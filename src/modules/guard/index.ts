import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate } from '../../ollama';
import { config } from '../../config';

const PROMPT_VERSION = 'v1';

export interface ScoreParams {
  requestId: string;
  userId: string;
  url: string;
  title: string;
  channel: string;
  description: string;
  transcript: string | null;
}

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

function buildPrompt(params: ScoreParams & { channelHistory: ChannelHistory }): string {
  const { title, channel, description, transcript, channelHistory } = params;

  const desc = description.length > 500 ? description.slice(0, 500) + '...' : description;
  const txScript = transcript
    ? `\nTranscript excerpt:\n${transcript.slice(0, 2000)}${transcript.length > 2000 ? '...' : ''}`
    : '';
  const history =
    channelHistory.approved > 0 || channelHistory.rejected > 0
      ? `\nChannel history for this child: ${channelHistory.approved} previously approved, ${channelHistory.rejected} previously rejected.`
      : '\nChannel history: no prior requests from this channel.';

  return `You are a content safety guard for a family media system. A child (aged 10-12) wants to watch a YouTube video.

Video details:
Title: ${title}
Channel: ${channel}
Description: ${desc}${txScript}${history}

Decide if this video is appropriate for a child aged 10-12.

Return ONLY valid JSON with no other text:
{
  "verdict": "clear_yes" or "clear_no" or "uncertain",
  "reason": "one sentence, plain English, suitable to show a parent",
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
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON block in Gemma response');

  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  const v = parsed['verdict'];
  if (v !== 'clear_yes' && v !== 'clear_no' && v !== 'uncertain') {
    throw new Error(`Unexpected verdict value: ${String(v)}`);
  }

  return {
    verdict: v,
    reason: typeof parsed['reason'] === 'string' ? parsed['reason'] : 'No reason provided',
    confidence:
      typeof parsed['confidence'] === 'number'
        ? Math.min(1, Math.max(0, parsed['confidence']))
        : 0.5,
  };
}

// Shared Gemma round-trip + parse + guard_eval insert. Used by both the
// request flow (scoreForRequest) and the candidate flow (evaluateCandidate)
// so the eval logic exists in one place.
async function runGuardEvaluation(
  prompt: string,
  ctx: { requestId: string | null; url: string },
): Promise<GuardVerdict> {
  let verdict: GuardVerdict;
  try {
    const raw = await ollamaGenerate(prompt);
    verdict = parseVerdict(raw);
  } catch (err) {
    logger.warn({ err, requestId: ctx.requestId, url: ctx.url }, 'Guard scoring failed — defaulting to uncertain');
    verdict = { verdict: 'uncertain', reason: 'Guard scoring error', confidence: 0 };
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO guard_eval
      (eval_id, request_id, url, gemma_verdict, gemma_reason, gemma_confidence, prompt_version, scored_at, created_at)
    VALUES
      (@eval_id, @request_id, @url, @gemma_verdict, @gemma_reason, @gemma_confidence, @prompt_version, @scored_at, @scored_at)
  `).run({
    eval_id: uuidv7(),
    request_id: ctx.requestId,
    url: ctx.url,
    gemma_verdict: verdict.verdict,
    gemma_reason: verdict.reason,
    gemma_confidence: verdict.confidence,
    prompt_version: PROMPT_VERSION,
    scored_at: now,
  });

  return verdict;
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
  const prompt = buildPrompt({ ...params, channelHistory });
  const verdict = await runGuardEvaluation(prompt, { requestId: params.requestId, url: params.url });

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
}

// Evaluate a discovery candidate. The candidate flow has no request row,
// so guard_eval.request_id is NULL and channel/description/transcript are
// unavailable — only the title carries safety signal at this stage.
export async function evaluateCandidate(params: CandidateEvalParams): Promise<GuardVerdict> {
  const prompt = buildPrompt({
    requestId: params.candidateId,
    userId: params.userId,
    url: params.url,
    title: params.title,
    channel: '',
    description: '',
    transcript: null,
    channelHistory: { approved: 0, rejected: 0 },
  });
  return runGuardEvaluation(prompt, { requestId: null, url: params.url });
}

const THUMB_CLASSIFY_PROMPT = `Look at this YouTube thumbnail image.

Classify it as either "editorial" or "slop" by overall composition style.

Editorial: clean photography or illustration, journalistic or magazine-cover composition, considered typography. Prominent title text is fine when it's in an editorial style — serif headlines, clean sans-serif, publisher wordmarks, album/podcast-cover typography.

Slop: manufactured shock expressions (open mouth, wide/bulging eyes, fake reactions), arrows or circles pointing at things, garish clashing colours, stroked/outlined "YouTuber" text styling, or composition clearly designed to bait clicks.

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

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const style = parsed['style'];
    if (style !== 'editorial' && style !== 'slop') throw new Error(`Unexpected style: ${String(style)}`);
    logger.debug({ youtubeId, variant, style }, 'Thumbnail classified');
    return style;
  } catch (err) {
    logger.warn({ err, youtubeId, variant, raw }, 'Failed to parse thumb classification response');
    return 'slop';
  }
}
