import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate } from '../../ollama';

export const PROMPT_VERSION = 'v1';

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

export function buildPrompt(params: ScoreParams & { channelHistory: ChannelHistory }): string {
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

export function parseVerdict(response: string): GuardVerdict {
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

export async function scoreForRequest(params: ScoreParams): Promise<GuardVerdict> {
  const channelHistory = getChannelHistory(params.userId, params.channel);
  const prompt = buildPrompt({ ...params, channelHistory });

  let verdict: GuardVerdict;
  try {
    const raw = await ollamaGenerate(prompt);
    verdict = parseVerdict(raw);
  } catch (err) {
    logger.warn({ err, requestId: params.requestId }, 'Guard scoring failed — defaulting to uncertain');
    verdict = { verdict: 'uncertain', reason: 'Guard scoring error', confidence: 0 };
  }

  const evalId = uuidv7();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO guard_eval
      (eval_id, request_id, url, gemma_verdict, gemma_reason, gemma_confidence, prompt_version, scored_at, created_at)
    VALUES
      (@eval_id, @request_id, @url, @gemma_verdict, @gemma_reason, @gemma_confidence, @prompt_version, @scored_at, @scored_at)
  `).run({
    eval_id: evalId,
    request_id: params.requestId,
    url: params.url,
    gemma_verdict: verdict.verdict,
    gemma_reason: verdict.reason,
    gemma_confidence: verdict.confidence,
    prompt_version: PROMPT_VERSION,
    scored_at: now,
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
