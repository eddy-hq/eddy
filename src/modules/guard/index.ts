import { v7 as uuidv7 } from 'uuid';
import { Worker } from 'bullmq';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';
import { config } from '../../config';
import { GuardError } from '../../errors';
import { redis, guardQueue } from '../../queue';
import { getAgeBand } from '../users';
import { categoryName, readVideoMetadata, type StoredVideoMetadata } from './metadata';
import {
  CANDIDATE_V4_PROMPT_VERSION,
  RUBRIC_SCORES_SCHEMA,
  SECOND_PASS_V4_NO_TRANSCRIPT_PROMPT_VERSION,
  SECOND_PASS_V4_PROMPT_VERSION,
  buildRubricPrompt,
  formatTags,
  parseRubricOutput,
  type RubricPromptInput,
} from './rubric-prompt';
import {
  RUBRIC_VERSION,
  describeDriver,
  verdictFromScores,
  type RubricContext,
  type RubricDecision,
  type RubricScores,
} from './rubric';

export { ensureVideoMetadata, readVideoMetadata, type StoredVideoMetadata } from './metadata';
export {
  THUMB_SAFETY_VERSION,
  THUMB_SAFETY_MAX_SCORE,
  passesThumbSafetyFloor,
  scoreThumbnailSafety,
  type ThumbSafetyVerdict,
  type ThumbSafetyScore,
  type ThumbSafetyDimension,
  type ThumbSafetyError,
} from './thumb-safety';
export * from './rubric';
export {
  CANDIDATE_V4_PROMPT_VERSION,
  SECOND_PASS_V4_PROMPT_VERSION,
  SECOND_PASS_V4_NO_TRANSCRIPT_PROMPT_VERSION,
  RUBRIC_PROMPT_PREFIX,
  buildRubricPrompt,
  cleanDescription,
} from './rubric-prompt';
export { shownEvalForCandidate, shownEvalForRequest, labelGuardEval, type ShownEval } from './labels';

const PROMPT_VERSION = 'v2';
export const CANDIDATE_PROMPT_VERSION = 'candidate-v3';
const KID_INTEREST_PROMPT_VERSION = 'kid-interest-v2';
export const KID_INTEREST_EVAL_JOB = 'kid-interest-eval';
// Download-time second pass on slate picks (Phase 6a). Two versions so
// guard_eval says whether the transcript was there: the no-transcript variant
// is the same prompt guarded on metadata alone.
export const SECOND_PASS_PROMPT_VERSION = 'candidate-transcript-v1';
export const SECOND_PASS_NO_TRANSCRIPT_PROMPT_VERSION = 'candidate-transcript-v1-no-transcript';
export const DOWNLOAD_SECOND_PASS_JOB = 'download-second-pass';

// Which prompt judges discovery candidates and the second pass (Phase 6a):
// v3 asks for a verdict, v4 scores the rubric and code decides. Chosen by
// GUARD_CANDIDATE_PROMPT; anything other than 'v4' is v3.
export type CandidatePromptId = 'v3' | 'v4';

export function liveCandidatePrompt(): CandidatePromptId {
  return config.GUARD_CANDIDATE_PROMPT === 'v4' ? 'v4' : 'v3';
}

export function candidatePromptVersion(prompt: CandidatePromptId): string {
  return prompt === 'v4' ? CANDIDATE_V4_PROMPT_VERSION : CANDIDATE_PROMPT_VERSION;
}

// What a parked re-run keys its results by. A v4 result depends on both the
// prompt and the rubric it scored against, so a rubric edit re-evaluates too
// rather than resuming over results scored under the old rubric.
export function rerunVersionKey(prompt: CandidatePromptId): string {
  return prompt === 'v4' ? `${CANDIDATE_V4_PROMPT_VERSION}+${RUBRIC_VERSION}` : CANDIDATE_PROMPT_VERSION;
}

function secondPassPromptVersion(prompt: CandidatePromptId, transcriptAvailable: boolean): string {
  if (prompt === 'v4') {
    return transcriptAvailable ? SECOND_PASS_V4_PROMPT_VERSION : SECOND_PASS_V4_NO_TRANSCRIPT_PROMPT_VERSION;
  }
  return transcriptAvailable ? SECOND_PASS_PROMPT_VERSION : SECOND_PASS_NO_TRANSCRIPT_PROMPT_VERSION;
}

export interface ScoreParams {
  requestId: string;
  userId: string;
  url: string;
  title: string;
  channel: string;
  description: string;
  transcript: string | null;
}

// A verdict is a short classification, not an essay: no thinking pass, output
// constrained to the verdict shape, deterministic, capped well above one
// sentence of reason. keep_alive holds the model across a discovery run's
// back-to-back calls. truncate/shift off: by default Ollama silently drops the
// start of a prompt longer than its 4096-token context — for the rubric prompt,
// the rubric itself — and the schema still forces a well-formed answer. With
// both off an over-long prompt is a 400, which the callers turn into uncertain.
const GUARD_CALL_OPTIONS = {
  temperature: 0,
  num_predict: 200,
  think: false,
  keep_alive: '30m',
  truncate: false,
  shift: false,
};

// `reason` comes first so the model states its grounds before it commits to
// a verdict — the only reasoning it gets with thinking off.
const GUARD_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    verdict: { type: 'string', enum: ['clear_yes', 'clear_no', 'uncertain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['reason', 'verdict', 'confidence'],
};

export interface GuardVerdict {
  verdict: 'clear_yes' | 'clear_no' | 'uncertain';
  reason: string;
  confidence: number;
}

interface ChannelHistory {
  approved: number;
  rejected: number;
}

function getChannelHistory(userId: string, channel: string): ChannelHistory {
  const row = db.prepare(`
    SELECT
      COUNT(CASE WHEN status IN ('ready', 'watched') THEN 1 END) AS approved,
      COUNT(CASE WHEN status = 'rejected' THEN 1 END)            AS rejected
    FROM requests
    WHERE user_id = ? AND lower(channel) = lower(?)
      -- Parent picks (#217) never met the guard; a parent's send isn't the
      -- kid's history with the channel.
      AND source != 'parent_pick'
  `).get(userId, channel) as { approved: number; rejected: number };
  return { approved: row?.approved ?? 0, rejected: row?.rejected ?? 0 };
}

interface PromptParams extends ScoreParams {
  ageBand: string;
  // Null when the channel is unknown — the history line is then left out
  // rather than claiming there is no history.
  channelHistory: ChannelHistory | null;
  // Data API fields, candidate flow only (Phase 6a). Each line is left out
  // when the field is blank or unknown.
  tags?: string[];
  category?: string | null;
  madeForKids?: boolean | null;
}

function buildPrompt(params: PromptParams): string {
  const { title, channel, description, transcript, ageBand, channelHistory } = params;

  const desc = description.length > 500 ? description.slice(0, 500) + '...' : description;
  const tags = formatTags(params.tags);
  const category = params.category?.trim() ?? '';
  // The uploader's audience setting, stated as a fact about the upload and
  // never as a safety assurance: uploaders set it themselves, and Elsagate
  // content was marked made for kids. Same caution as the follow line below.
  const audience = params.madeForKids === true
    ? 'YouTube audience setting: made for kids'
    : params.madeForKids === false
      ? 'YouTube audience setting: not made for kids'
      : null;
  const txScript = transcript
    ? `\nTranscript excerpt:\n${transcript.slice(0, 2000)}${transcript.length > 2000 ? '...' : ''}`
    : '';
  const history = !channelHistory
    ? ''
    : channelHistory.approved > 0 || channelHistory.rejected > 0
      ? `\nChannel history for this child: ${channelHistory.approved} previously approved, ${channelHistory.rejected} previously rejected.`
      : '\nChannel history: no prior requests from this channel.';
  // Deliberately no "the child follows this channel" line. Tested on parked
  // and rejected follow candidates: a neutral wording talked the model out of
  // a clear_no, and an ADR-0010 wording ("no parent has reviewed it") pushed
  // nearly everything to uncertain. A follow is persuasion, not evidence.
  // Blank fields are omitted: an empty "Channel:" line reads as missing
  // evidence and pushes the model towards uncertain.
  const details = [
    `Title: ${title}`,
    channel ? `Channel: ${channel}` : null,
    category ? `Category: ${category}` : null,
    desc ? `Description: ${desc}` : null,
    tags ? `Tags: ${tags}` : null,
    audience,
  ].filter((line) => line !== null).join('\n');

  return `You are a content safety guard for a family media system. A child (aged ${ageBand}) wants to watch a YouTube video.

Video details:
${details}${txScript}${history}

Decide if this video is appropriate for a child aged ${ageBand}.

Return ONLY valid JSON with no other text:
{
  "reason": "one sentence, plain English, suitable to show a parent",
  "verdict": "clear_yes" or "clear_no" or "uncertain",
  "confidence": 0.0 to 1.0
}

Guidelines:
- clear_yes: clearly appropriate — educational, entertainment, or informational content for children
- clear_no: clearly inappropriate — violence, adult themes, strong language, disturbing content, age-restricted material
- uncertain: ambiguous — escalate to parent; when in doubt, use this
- confidence reflects certainty in the verdict (not how appropriate the content is)
- Never auto-approve when uncertain`;
}

function parseVerdict(response: string): GuardVerdict {
  const verdict = parseOllamaJson<GuardVerdict>(response, 'object', (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    const v = p['verdict'];
    if (v !== 'clear_yes' && v !== 'clear_no' && v !== 'uncertain') return null;
    return {
      verdict: v,
      reason: typeof p['reason'] === 'string' ? p['reason'] : 'No reason provided',
      confidence:
        typeof p['confidence'] === 'number'
          ? Math.min(1, Math.max(0, p['confidence']))
          : 0.5,
    };
  });
  if (!verdict) throw new Error('Could not parse Gemma verdict');
  return verdict;
}

// The reason on the uncertain verdict a failed model call falls back to. Batch
// callers (the parked re-run) use it to tell "the model said uncertain" from
// "the model never answered", so the latter can be retried.
export const GUARD_SCORING_ERROR_REASON = 'Guard scoring error';

export type GuardRequestType = 'video' | 'candidate' | 'kid_interest';

interface RunGuardCtx {
  requestId: string | null;
  url: string;
  // The kid the verdict is for, and the candidate it judged (candidate flow
  // only), so the parent decision surface can find the exact row.
  userId?: string | null;
  candidateId?: string | null;
  requestType: GuardRequestType;
  subjectText?: string | null;
  interestId?: string | null;
  promptVersion?: string;
}

// What a rubric-scored (v4) call adds to its guard_eval row. `decision` is
// null when the model call failed and no scores exist.
interface RubricRecord {
  scores: RubricScores | null;
  decision: RubricDecision | null;
}

// Shared Gemma round-trip + parse + guard_eval insert. Used by every guard
// flow (scoreForRequest / evaluateCandidate / evaluateKidInterest) so the
// eval logic exists in one place.
async function runGuardEvaluation(
  prompt: string,
  ctx: RunGuardCtx,
): Promise<GuardVerdict> {
  let verdict: GuardVerdict;
  try {
    const raw = await ollamaGenerate(prompt, undefined, undefined, GUARD_CALL_OPTIONS, GUARD_VERDICT_SCHEMA);
    verdict = parseVerdict(raw);
  } catch (err) {
    logger.warn({ err, requestId: ctx.requestId, url: ctx.url }, 'Guard scoring failed — defaulting to uncertain');
    verdict = { verdict: 'uncertain', reason: GUARD_SCORING_ERROR_REASON, confidence: 0 };
  }

  recordGuardEval(verdict, ctx);
  return verdict;
}

// Write one guard_eval row. Every verdict lands here — model-scored or
// decided by rule (the age-restricted short-circuit) — so the eval set sees
// all of them.
function recordGuardEval(verdict: GuardVerdict, ctx: RunGuardCtx, rubric?: RubricRecord): void {
  // A parent may have taken the request over as a parent pick (#217) while
  // the model ran: the guard never judges one, so its verdict isn't kept.
  if (ctx.requestId) {
    const req = db.prepare('SELECT source FROM requests WHERE request_id = ?').get(ctx.requestId) as
      | { source: string }
      | undefined;
    if (req?.source === 'parent_pick') {
      logger.info({ requestId: ctx.requestId }, 'Guard verdict not recorded — request is now a parent pick');
      return;
    }
  }
  const now = new Date().toISOString();
  const scoresJson = rubric?.scores && rubric.decision
    ? JSON.stringify({
      ...rubric.scores,
      limitsBand: rubric.decision.limitsBand,
      context: rubric.decision.context,
      drivers: rubric.decision.drivers,
    })
    : null;
  db.prepare(`
    INSERT INTO guard_eval
      (eval_id, request_id, url, gemma_verdict, gemma_reason, gemma_confidence,
       prompt_version, request_type, subject_text, interest_id,
       rubric_version, rubric_scores_json, user_id, candidate_id,
       scored_at, created_at)
    VALUES
      (@eval_id, @request_id, @url, @gemma_verdict, @gemma_reason, @gemma_confidence,
       @prompt_version, @request_type, @subject_text, @interest_id,
       @rubric_version, @rubric_scores_json, @user_id, @candidate_id,
       @scored_at, @scored_at)
  `).run({
    eval_id: uuidv7(),
    request_id: ctx.requestId,
    url: ctx.url,
    gemma_verdict: verdict.verdict,
    gemma_reason: verdict.reason,
    // A rubric verdict is decided by rule, not reported by the model, so
    // there is no model confidence to record. A failed rubric call has no
    // decision: it keeps the error's confidence (0), like a failed v3 call.
    gemma_confidence: rubric?.decision ? null : verdict.confidence,
    prompt_version: ctx.promptVersion ?? PROMPT_VERSION,
    request_type: ctx.requestType,
    subject_text: ctx.subjectText ?? null,
    interest_id: ctx.interestId ?? null,
    // Set only when scores exist; prompt_version already marks a v4 attempt.
    rubric_version: rubric?.decision ? RUBRIC_VERSION : null,
    rubric_scores_json: scoresJson,
    user_id: ctx.userId ?? null,
    candidate_id: ctx.candidateId ?? null,
    scored_at: now,
  });
}

// Same call options as the verdict prompts, with room for the longer score
// object (~110 tokens measured; truncated output would be a scoring error).
const RUBRIC_CALL_OPTIONS = { ...GUARD_CALL_OPTIONS, num_predict: 256 };

// A v4 verdict: the model's scores plus the rule decision on them. `rubric`
// is null when the model never produced a valid score set.
export interface RubricGuardVerdict extends GuardVerdict {
  rubric: { scores: RubricScores; decision: RubricDecision } | null;
}

// Rubric round-trip (candidate-v4 and its second-pass counterpart): the model
// scores dimensions, hard stops and flags; verdictFromScores decides for this
// age band and context. Any failure is uncertain, never a pass. Confidence is
// reported as 1 because the verdict is rule-decided (stored as NULL).
async function runRubricEvaluation(
  input: RubricPromptInput,
  ageBand: string,
  context: RubricContext,
  ctx: RunGuardCtx,
): Promise<RubricGuardVerdict> {
  let parsed: ReturnType<typeof parseRubricOutput>;
  try {
    const raw = await ollamaGenerate(
      buildRubricPrompt(input), undefined, undefined, RUBRIC_CALL_OPTIONS, RUBRIC_SCORES_SCHEMA,
    );
    parsed = parseRubricOutput(raw);
    if (!parsed) throw new GuardError('Could not parse Gemma rubric scores');
  } catch (err) {
    logger.warn({ err, requestId: ctx.requestId, url: ctx.url }, 'Guard rubric scoring failed — defaulting to uncertain');
    const verdict: GuardVerdict = { verdict: 'uncertain', reason: GUARD_SCORING_ERROR_REASON, confidence: 0 };
    recordGuardEval(verdict, ctx, { scores: null, decision: null });
    return { ...verdict, rubric: null };
  }

  const decision = verdictFromScores(parsed.scores, ageBand, context);
  // The model's reason, plus what the limits table found — so a verdict the
  // model didn't express (a flag, a limit it didn't know about) still names
  // its cause.
  const reason = decision.drivers.length > 0
    ? `${parsed.reason} (${decision.drivers.map(describeDriver).join('; ')})`
    : parsed.reason;
  const verdict: GuardVerdict = { verdict: decision.verdict, reason, confidence: 1 };
  recordGuardEval(verdict, ctx, { scores: parsed.scores, decision });
  return { ...verdict, rubric: { scores: parsed.scores, decision } };
}

export async function scoreForRequest(params: ScoreParams): Promise<GuardVerdict> {
  const prior = db.prepare(
    'SELECT gemma_verdict, gemma_reason, gemma_confidence FROM guard_eval WHERE request_id = ? ORDER BY scored_at ASC LIMIT 1'
  ).get(params.requestId) as { gemma_verdict: string; gemma_reason: string; gemma_confidence: number | null } | undefined;

  if (prior) {
    logger.info({ requestId: params.requestId }, 'Guard already scored for this request — skipping retry');
    return {
      verdict: prior.gemma_verdict as GuardVerdict['verdict'],
      reason: prior.gemma_reason,
      // NULL on a rubric (v4) row: rule-decided, reported as 1 like a fresh one.
      confidence: prior.gemma_confidence ?? 1,
    };
  }

  const channelHistory = getChannelHistory(params.userId, params.channel);
  const ageBand = getAgeBand(params.userId);
  const prompt = buildPrompt({ ...params, ageBand, channelHistory });
  const verdict = await runGuardEvaluation(prompt, {
    requestId: params.requestId,
    url: params.url,
    requestType: 'video',
    userId: params.userId,
  });

  // A parent may have taken the request over as a parent pick (#217) while
  // the model ran: its row carries no guard verdict.
  db.prepare(`
    UPDATE requests SET guard_verdict = @verdict, guard_reason = @reason
    WHERE request_id = @request_id AND source != 'parent_pick'
  `).run({ verdict: verdict.verdict, reason: verdict.reason, request_id: params.requestId });

  logger.info(
    { requestId: params.requestId, verdict: verdict.verdict, confidence: verdict.confidence },
    'Guard verdict logged'
  );

  return verdict;
}

export interface CandidateEvalParams {
  candidateId: string;
  userId: string;
  url: string;
  title: string;
  channel?: string | null;
  ageBand?: string;
  // Data API metadata (Phase 6a), from video_metadata. All optional: a
  // candidate without a stored row is guarded on title, channel and history
  // alone, as before.
  description?: string | null;
  tags?: string[] | null;
  categoryId?: string | null;
  madeForKids?: boolean | null;
  ageRestricted?: boolean;
  // Which candidate prompt to use. Defaults to the live one
  // (GUARD_CANDIDATE_PROMPT); the parked re-run passes it explicitly.
  prompt?: CandidatePromptId;
}

// A candidate verdict. `rubric` is set only for a v4 call that produced
// scores; v3 verdicts and the age-restricted short-circuit leave it null.
export interface CandidateVerdict extends GuardVerdict {
  promptVersion: string;
  rubric: RubricGuardVerdict['rubric'];
}

export const AGE_RESTRICTED_REASON = 'Age-restricted on YouTube';

// Evaluate a discovery candidate. The candidate flow has no request row, so
// guard_eval.request_id is NULL and there is no transcript — the title,
// channel, the child's history with it and any stored Data API metadata carry
// the signal. A video YouTube itself age-restricts is a clear_no by rule, with
// no model call; the verdict is still written to guard_eval so it counts in
// the eval set.
export async function evaluateCandidate(params: CandidateEvalParams): Promise<CandidateVerdict> {
  const promptId = params.prompt ?? liveCandidatePrompt();
  const promptVersion = candidatePromptVersion(promptId);
  const ctx: RunGuardCtx = {
    requestId: null,
    url: params.url,
    requestType: 'candidate',
    userId: params.userId,
    candidateId: params.candidateId,
    promptVersion,
  };

  if (params.ageRestricted === true) {
    const verdict: GuardVerdict = { verdict: 'clear_no', reason: AGE_RESTRICTED_REASON, confidence: 1 };
    recordGuardEval(verdict, ctx);
    return { ...verdict, promptVersion, rubric: null };
  }

  const channel = params.channel?.trim() ?? '';
  const ageBand = params.ageBand ?? getAgeBand(params.userId);
  const channelHistory = channel ? getChannelHistory(params.userId, channel) : null;

  if (promptId === 'v4') {
    const verdict = await runRubricEvaluation({
      title: params.title,
      channel,
      description: params.description ?? '',
      tags: params.tags ?? [],
      category: categoryName(params.categoryId),
      madeForKids: params.madeForKids ?? null,
      channelHistory,
      transcript: null,
    }, ageBand, 'discovery', ctx);
    return { ...verdict, promptVersion };
  }

  const prompt = buildPrompt({
    requestId: params.candidateId,
    userId: params.userId,
    url: params.url,
    title: params.title,
    channel,
    description: params.description ?? '',
    transcript: null,
    ageBand,
    channelHistory,
    tags: params.tags ?? [],
    category: categoryName(params.categoryId),
    madeForKids: params.madeForKids ?? null,
  });
  const verdict = await runGuardEvaluation(prompt, ctx);
  return { ...verdict, promptVersion, rubric: null };
}

// ── Download-time second pass (Phase 6a) ─────────────────────────────────────
// A kid's slate pick passed the candidate guard on metadata alone. Once it
// downloads, the transcript that arrived with it (yt-dlp's auto-captions,
// fetched with the info JSON — no extra yt-dlp or Data API traffic) is guarded
// together with the stored video_metadata before the card becomes visible.
// Only clear_yes shows; anything else, or any failure, parks the request for
// an Escalation.

export interface DownloadedPickEvalParams {
  requestId: string;
  userId: string;
  url: string;
  title: string;
  channel: string | null;
  // yt-dlp's description, used when there is no stored Data API row.
  description: string | null;
  transcript: string | null;
  metadata: StoredVideoMetadata | null;
}

export interface DownloadedPickVerdict extends GuardVerdict {
  transcriptAvailable: boolean;
}

export async function evaluateDownloadedPick(params: DownloadedPickEvalParams): Promise<DownloadedPickVerdict> {
  const transcript = params.transcript?.trim() ? params.transcript : null;
  const transcriptAvailable = transcript !== null;
  const promptId = liveCandidatePrompt();
  const ctx: RunGuardCtx = {
    requestId: params.requestId,
    url: params.url,
    requestType: 'video',
    userId: params.userId,
    promptVersion: secondPassPromptVersion(promptId, transcriptAvailable),
  };
  const meta = params.metadata;

  // Same rule as the candidate guard: YouTube's own age restriction is a
  // clear_no with no model call, still recorded.
  if (meta?.ageRestricted === true) {
    const verdict: GuardVerdict = { verdict: 'clear_no', reason: AGE_RESTRICTED_REASON, confidence: 1 };
    recordGuardEval(verdict, ctx);
    return { ...verdict, transcriptAvailable };
  }

  const channel = params.channel?.trim() ?? '';
  const ageBand = getAgeBand(params.userId);
  const channelHistory = channel ? getChannelHistory(params.userId, channel) : null;

  // v4: same rubric and static prefix as the candidate guard, transcript
  // excerpt last. A slate pick is a discovery surface, so flags never show.
  if (promptId === 'v4') {
    const verdict = await runRubricEvaluation({
      title: params.title,
      channel,
      description: meta?.description ?? params.description ?? '',
      tags: meta?.tags ?? [],
      category: categoryName(meta?.categoryId),
      madeForKids: meta?.madeForKids ?? null,
      channelHistory,
      transcript,
    }, ageBand, 'discovery', ctx);
    return { verdict: verdict.verdict, reason: verdict.reason, confidence: verdict.confidence, transcriptAvailable };
  }

  const prompt = buildPrompt({
    requestId: params.requestId,
    userId: params.userId,
    url: params.url,
    title: params.title,
    channel,
    description: meta?.description ?? params.description ?? '',
    transcript,
    ageBand,
    channelHistory,
    tags: meta?.tags ?? [],
    category: categoryName(meta?.categoryId),
    madeForKids: meta?.madeForKids ?? null,
  });
  const verdict = await runGuardEvaluation(prompt, ctx);
  return { ...verdict, transcriptAvailable };
}

// Reason recorded on a pick parked because the second pass never produced a
// verdict (enqueue or evaluation failure). Distinct from the model-error
// reason so the parent surface can tell "the guard doubted it" from "the
// guard never ran".
export const SECOND_PASS_FAILED_REASON = 'Download-time guard check could not run';

// The requests module is imported lazily: statically it would pull the
// requests state machine (and people/registry behind it) into every importer
// of the guard, including modules that only want a job-name constant. The
// guard stays a leaf at load time; only the second pass reaches into requests.
function loadRequests(): Promise<typeof import('../requests')> {
  return import('../requests');
}

async function parkPick(requestId: string, verdict: 'uncertain' | 'clear_no', reason: string): Promise<void> {
  try {
    const { getRequestsState } = await loadRequests();
    const { result } = getRequestsState().apply({ kind: 'mark_second_pass_parked', requestId, verdict, reason });
    if (!result.transitioned) {
      logger.info({ requestId, currentStatus: result.currentStatus }, 'Second pass: park skipped — request no longer awaiting the guard');
    }
  } catch (err) {
    // The row stays in guard_review, which no kid surface shows.
    logger.error({ err, requestId }, 'Second pass: failed to park request');
  }
}

// Queue the second pass for a request just moved to guard_review. Kid safety
// first: if the job can't be queued the pick is parked, never shown.
export async function enqueueDownloadSecondPass(requestId: string): Promise<void> {
  try {
    await guardQueue.add(DOWNLOAD_SECOND_PASS_JOB, { requestId }, { jobId: `second-pass-${requestId}` });
  } catch (err) {
    logger.error({ err, requestId }, 'Second pass: failed to enqueue — parking the pick');
    await parkPick(requestId, 'uncertain', SECOND_PASS_FAILED_REASON);
  }
}

// Run the second pass for one request. Never shows a pick on failure: a
// missing transcript guards on metadata alone (recorded as such), a model
// error comes back as uncertain, and anything that throws parks the pick.
export async function runDownloadSecondPass(requestId: string): Promise<void> {
  const { getRequestsState, readSecondPassInput, rejectIfChannelBlocked } = await loadRequests();
  const input = readSecondPassInput(requestId);
  if (!input) {
    logger.warn({ requestId }, 'Second pass: request not found');
    return;
  }
  if (input.status !== 'guard_review') {
    logger.info({ requestId, currentStatus: input.status }, 'Second pass: request no longer awaiting the guard — skipping');
    return;
  }
  // A Blocked channel needs no model call: the pick is rejected outright.
  const channelBlocked = (): boolean => rejectIfChannelBlocked({
    requestId, youtubeChannelId: input.youtubeChannelId, channel: input.channel,
  }).blocked;
  if (channelBlocked()) return;

  let outcome: DownloadedPickVerdict;
  try {
    outcome = await evaluateDownloadedPick({
      requestId,
      userId: input.userId,
      url: input.url,
      title: input.title ?? '',
      channel: input.channel,
      description: input.description,
      transcript: input.transcript,
      metadata: input.youtubeId ? readVideoMetadata(input.youtubeId) : null,
    });
  } catch (err) {
    logger.error({ err, requestId }, 'Second pass: evaluation failed — parking the pick');
    await parkPick(requestId, 'uncertain', SECOND_PASS_FAILED_REASON);
    return;
  }

  logger.info(
    { requestId, verdict: outcome.verdict, transcriptAvailable: outcome.transcriptAvailable },
    'Second pass verdict',
  );

  if (outcome.verdict === 'clear_yes') {
    // The channel may have been blocked while the guard ran.
    if (channelBlocked()) return;
    const { result } = getRequestsState().apply({ kind: 'mark_second_pass_cleared', requestId, reason: outcome.reason });
    if (!result.transitioned) {
      logger.info({ requestId, currentStatus: result.currentStatus }, 'Second pass: clear skipped — request no longer awaiting the guard');
    }
    return;
  }
  await parkPick(requestId, outcome.verdict, outcome.reason);
}

// ── Kid-authored interest guard (shadow mode) ────────────────────────────────
// Phase 5 chain: kid types a freeform interest → search-terms job populates
// `interests.search_terms` → this evaluator runs against raw label + terms and
// writes a `guard_eval` row. Verdict has no user-facing effect yet — the row
// is the deliverable for tuning Phase 6 enforcement.

function buildKidInterestPrompt(rawLabel: string, searchTerms: string[], ageBand: string): string {
  const termsLine = searchTerms.length > 0
    ? `\nGenerated YouTube search queries for this interest: ${searchTerms.map((t) => `"${t}"`).join(', ')}.`
    : '\nNo search queries have been generated for this interest yet.';

  return `You are a content safety guard for a family media system. A child (aged ${ageBand}) has typed a freeform interest they would like to be recommended videos about.

Raw input from the child: "${rawLabel}"${termsLine}

Decide whether this interest is appropriate to recommend videos for to a child aged ${ageBand}. Consider both the literal meaning of the input and what the generated search queries imply about the actual videos this interest will surface.

Return ONLY valid JSON with no other text:
{
  "reason": "one sentence, plain English, suitable to show a parent",
  "verdict": "clear_yes" or "clear_no" or "uncertain",
  "confidence": 0.0 to 1.0
}

Guidelines:
- clear_yes: clearly appropriate — hobbies, learning topics, age-appropriate entertainment, sports, games suitable for this age band
- clear_no: clearly inappropriate — sexual content, graphic violence, drugs, self-harm, hate, age-restricted material, or topics whose recommendations would predictably be inappropriate
- uncertain: ambiguous — escalate to parent; when in doubt, use this
- confidence reflects certainty in the verdict (not how appropriate the topic is)
- Never auto-approve when uncertain`;
}

export interface KidInterestEvalParams {
  userId: string;
  interestId: string;
  rawLabel: string;
}

export async function evaluateKidInterest(params: KidInterestEvalParams): Promise<GuardVerdict> {
  const row = db.prepare('SELECT search_terms FROM interests WHERE id = ?')
    .get(params.interestId) as { search_terms: string } | undefined;

  let searchTerms: string[] = [];
  if (row?.search_terms) {
    try {
      const parsed = JSON.parse(row.search_terms) as unknown;
      if (Array.isArray(parsed)) {
        searchTerms = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // fall through with empty terms — eval still runs against the raw label
    }
  }

  const prompt = buildKidInterestPrompt(params.rawLabel, searchTerms, getAgeBand(params.userId));
  return runGuardEvaluation(prompt, {
    requestId: null,
    url: `interest:${params.interestId}`,
    requestType: 'kid_interest',
    userId: params.userId,
    subjectText: params.rawLabel,
    interestId: params.interestId,
    promptVersion: KID_INTEREST_PROMPT_VERSION,
  });
}

// guardQueue worker — handles the kid-interest chain and the download-time
// second pass. The other guard flows (scoreForRequest / evaluateCandidate)
// still run synchronously inside their HTTP / discovery code paths.

let guardWorker: Worker | null = null;

interface KidInterestJob {
  userId: string;
  interestId: string;
  rawLabel: string;
}

interface SecondPassJob {
  requestId: string;
}

export function startGuardWorker(): void {
  guardWorker = new Worker<KidInterestJob | SecondPassJob>('guard', async (job) => {
    if (job.name === KID_INTEREST_EVAL_JOB) {
      await evaluateKidInterest(job.data as KidInterestJob);
      return;
    }
    if (job.name === DOWNLOAD_SECOND_PASS_JOB) {
      await runDownloadSecondPass((job.data as SecondPassJob).requestId);
      return;
    }
    throw new Error(`Guard worker: unknown job name '${job.name}'`);
  }, { connection: redis, concurrency: 1 });

  guardWorker.on('failed', (job, err) => {
    logger.warn({ err, jobId: job?.id, jobName: job?.name }, 'Guard worker: job failed');
  });

  logger.info('Guard worker started');
}

export async function stopGuardWorker(): Promise<void> {
  if (guardWorker) {
    await guardWorker.close();
    guardWorker = null;
  }
}

const THUMB_CLASSIFY_PROMPT = `Look at this YouTube thumbnail image.

Classify it as either "editorial" or "slop" by overall composition style.

Editorial: clean photography or illustration, journalistic or magazine-cover composition, considered typography. Prominent title text is fine when it's in an editorial style — serif headlines, clean sans-serif, publisher wordmarks, album/podcast-cover typography.

Slop: manufactured shock expressions (open mouth, wide/bulging eyes, fake reactions), arrows or circles pointing at things, garish clashing colours, stroked/outlined "YouTuber" text styling, deliberately concealed content (taped-over or blacked-out list items, redacted faces, partial reveals designed to make the viewer click), or composition clearly designed to bait clicks.

Text presence alone does not decide it — a calm magazine-cover thumbnail with a large title is editorial; a shocked face with clickbait arrows is slop even with little text.

Return ONLY valid JSON with no other text:
{
  "style": "editorial" or "slop",
  "confidence": 0.0 to 1.0
}`;

export type ThumbStyle = 'editorial' | 'slop';

export async function classifyThumbnail(youtubeId: string): Promise<ThumbStyle> {
  const cached = db.prepare(`SELECT thumbnail_maxres_verdict FROM requests WHERE youtube_id = ?`)
    .get(youtubeId) as { thumbnail_maxres_verdict: string | null } | undefined;
  if (cached?.thumbnail_maxres_verdict === 'editorial' || cached?.thumbnail_maxres_verdict === 'slop') {
    logger.debug({ youtubeId, style: cached.thumbnail_maxres_verdict }, 'Thumbnail verdict from cache');
    return cached.thumbnail_maxres_verdict;
  }

  const style = await classifyYtImage(youtubeId, 'hqdefault');
  db.prepare(`UPDATE requests SET thumbnail_maxres_verdict = ? WHERE youtube_id = ?`)
    .run(style, youtubeId);
  return style;
}

// Classify an arbitrary YT thumbnail variant (e.g. hq1, hq2, hq3). Not cached —
// auto-frames are only classified once per pipeline run.
export async function classifyYtImage(youtubeId: string, variant: string): Promise<ThumbStyle> {
  const thumbUrl = `https://i.ytimg.com/vi/${youtubeId}/${variant}.jpg`;

  let imageBase64: string;
  try {
    const resp = await fetch(thumbUrl, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength < 2000) throw new Error('placeholder-sized response');
    imageBase64 = Buffer.from(buf).toString('base64');
  } catch (err) {
    logger.warn({ err, youtubeId, variant }, 'Failed to fetch YT thumbnail variant');
    return 'slop';
  }

  let raw: string;
  try {
    raw = await ollamaGenerate(THUMB_CLASSIFY_PROMPT, config.OLLAMA_GUARD_MODEL, [imageBase64]);
  } catch (err) {
    logger.warn({ err, youtubeId, variant }, 'Ollama thumb classification failed');
    return 'slop';
  }

  const style = parseOllamaJson<ThumbStyle>(raw, 'object', (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const s = (parsed as Record<string, unknown>)['style'];
    return s === 'editorial' || s === 'slop' ? s : null;
  });
  if (!style) {
    logger.warn({ youtubeId, variant, raw }, 'Failed to parse thumb classification response');
    return 'slop';
  }
  logger.debug({ youtubeId, variant, style }, 'Thumbnail classified');
  return style;
}
