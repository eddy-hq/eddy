import { v7 as uuidv7 } from 'uuid';
import { Worker } from 'bullmq';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';
import { config } from '../../config';
import { redis } from '../../queue';
import { getAgeBand } from '../users';
import { categoryName } from './metadata';

export { ensureVideoMetadata, type StoredVideoMetadata } from './metadata';

const PROMPT_VERSION = 'v2';
const CANDIDATE_PROMPT_VERSION = 'candidate-v3';
const KID_INTEREST_PROMPT_VERSION = 'kid-interest-v2';
export const KID_INTEREST_EVAL_JOB = 'kid-interest-eval';

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
// back-to-back calls.
const GUARD_CALL_OPTIONS = {
  temperature: 0,
  num_predict: 200,
  think: false,
  keep_alive: '30m',
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

// Upper bound on the rendered tags line. Uploaders stuff tags; a few hundred
// characters carries the signal without crowding out the rest of the prompt.
const TAGS_MAX_CHARS = 300;

function formatTags(tags: string[] | undefined): string {
  let out = '';
  for (const raw of tags ?? []) {
    const tag = raw.trim();
    if (!tag) continue;
    const next = out ? `${out}, ${tag}` : tag;
    if (next.length > TAGS_MAX_CHARS) break;
    out = next;
  }
  return out;
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

export type GuardRequestType = 'video' | 'candidate' | 'kid_interest';

interface RunGuardCtx {
  requestId: string | null;
  url: string;
  requestType: GuardRequestType;
  subjectText?: string | null;
  interestId?: string | null;
  promptVersion?: string;
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
    verdict = { verdict: 'uncertain', reason: 'Guard scoring error', confidence: 0 };
  }

  recordGuardEval(verdict, ctx);
  return verdict;
}

// Write one guard_eval row. Every verdict lands here — model-scored or
// decided by rule (the age-restricted short-circuit) — so the eval set sees
// all of them.
function recordGuardEval(verdict: GuardVerdict, ctx: RunGuardCtx): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO guard_eval
      (eval_id, request_id, url, gemma_verdict, gemma_reason, gemma_confidence,
       prompt_version, request_type, subject_text, interest_id,
       scored_at, created_at)
    VALUES
      (@eval_id, @request_id, @url, @gemma_verdict, @gemma_reason, @gemma_confidence,
       @prompt_version, @request_type, @subject_text, @interest_id,
       @scored_at, @scored_at)
  `).run({
    eval_id: uuidv7(),
    request_id: ctx.requestId,
    url: ctx.url,
    gemma_verdict: verdict.verdict,
    gemma_reason: verdict.reason,
    gemma_confidence: verdict.confidence,
    prompt_version: ctx.promptVersion ?? PROMPT_VERSION,
    request_type: ctx.requestType,
    subject_text: ctx.subjectText ?? null,
    interest_id: ctx.interestId ?? null,
    scored_at: now,
  });
}

export async function scoreForRequest(params: ScoreParams): Promise<GuardVerdict> {
  const prior = db.prepare(
    'SELECT gemma_verdict, gemma_reason, gemma_confidence FROM guard_eval WHERE request_id = ? ORDER BY scored_at ASC LIMIT 1'
  ).get(params.requestId) as { gemma_verdict: string; gemma_reason: string; gemma_confidence: number } | undefined;

  if (prior) {
    logger.info({ requestId: params.requestId }, 'Guard already scored for this request — skipping retry');
    return {
      verdict: prior.gemma_verdict as GuardVerdict['verdict'],
      reason: prior.gemma_reason,
      confidence: prior.gemma_confidence,
    };
  }

  const channelHistory = getChannelHistory(params.userId, params.channel);
  const ageBand = getAgeBand(params.userId);
  const prompt = buildPrompt({ ...params, ageBand, channelHistory });
  const verdict = await runGuardEvaluation(prompt, {
    requestId: params.requestId,
    url: params.url,
    requestType: 'video',
  });

  db.prepare(`
    UPDATE requests SET guard_verdict = @verdict, guard_reason = @reason
    WHERE request_id = @request_id
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
}

export const AGE_RESTRICTED_REASON = 'Age-restricted on YouTube';

// Evaluate a discovery candidate. The candidate flow has no request row, so
// guard_eval.request_id is NULL and there is no transcript — the title,
// channel, the child's history with it and any stored Data API metadata carry
// the signal. A video YouTube itself age-restricts is a clear_no by rule, with
// no model call; the verdict is still written to guard_eval so it counts in
// the eval set.
export async function evaluateCandidate(params: CandidateEvalParams): Promise<GuardVerdict> {
  const ctx: RunGuardCtx = {
    requestId: null,
    url: params.url,
    requestType: 'candidate',
    promptVersion: CANDIDATE_PROMPT_VERSION,
  };

  if (params.ageRestricted === true) {
    const verdict: GuardVerdict = { verdict: 'clear_no', reason: AGE_RESTRICTED_REASON, confidence: 1 };
    recordGuardEval(verdict, ctx);
    return verdict;
  }

  const channel = params.channel?.trim() ?? '';
  const prompt = buildPrompt({
    requestId: params.candidateId,
    userId: params.userId,
    url: params.url,
    title: params.title,
    channel,
    description: params.description ?? '',
    transcript: null,
    ageBand: params.ageBand ?? getAgeBand(params.userId),
    channelHistory: channel ? getChannelHistory(params.userId, channel) : null,
    tags: params.tags ?? [],
    category: categoryName(params.categoryId),
    madeForKids: params.madeForKids ?? null,
  });
  return runGuardEvaluation(prompt, ctx);
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
    subjectText: params.rawLabel,
    interestId: params.interestId,
    promptVersion: KID_INTEREST_PROMPT_VERSION,
  });
}

// guardQueue worker — currently handles the kid-interest chain only. Other
// guard flows (scoreForRequest / evaluateCandidate) still run synchronously
// inside their HTTP / discovery code paths.

let guardWorker: Worker | null = null;

interface KidInterestJob {
  userId: string;
  interestId: string;
  rawLabel: string;
}

export function startGuardWorker(): void {
  guardWorker = new Worker<KidInterestJob>('guard', async (job) => {
    if (job.name === KID_INTEREST_EVAL_JOB) {
      await evaluateKidInterest(job.data);
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
