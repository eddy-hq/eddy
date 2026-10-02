// "What the guard saw" on a decision card (#225): the inputs the guard prompt
// had beyond the title, channel and description the card already shows, so a
// parent judges on at least what the model judged on. Fetched when the parent
// opens the section rather than served with every card: a transcript excerpt
// runs to ~2,000 characters and most cards are decided without opening it.
//
// Parent-only, like every Decisions route. Read from the M4's own tables;
// nothing here leaves the M4.
import { db } from '../../db/client';
import { NotFoundError } from '../../errors';
import {
  categoryName,
  formatTags,
  getChannelHistory,
  promptSentMetadata,
  promptTranscript,
  readVideoMetadata,
  type ChannelHistory,
  type ShownEval,
} from '../guard';
import { shownEvalForSubject } from './queue';
import { shownEvalForDecision } from './review';
import type { SubjectType } from './util';

export interface GuardInputs {
  // The prompt version that judged the subject, or null when no guard_eval
  // row is found.
  promptVersion: string | null;
  // 'excerpt': exactly what the prompt was sent. 'none': the guard had no
  // transcript. null: not known for this prompt version — show nothing.
  transcript: { kind: 'excerpt'; text: string } | { kind: 'none' } | null;
  // Stored video_metadata, formatted as the prompts format them. Null fields
  // are left off the card.
  tags: string | null;
  category: string | null;
  madeForKids: boolean | null;
  // False when the judging prompt is known not to have been sent the stored
  // metadata above (the kid-request prompt), so the card can say so.
  metadataSent: boolean | null;
  // The kid's history with the channel as it stands now, not as at the
  // verdict. Null when the channel is unknown.
  channelHistory: ChannelHistory | null;
}

export type GuardInputsRef =
  | { decisionId: string }
  | { subjectType: SubjectType; subjectId: string };

interface SubjectInputs {
  subjectType: SubjectType;
  userId: string;
  youtubeId: string | null;
  channel: string | null;
  transcript: string | null;
}

interface SubjectRow {
  user_id: string;
  url: string;
  youtube_id: string | null;
  channel: string | null;
  guard_verdict: string | null;
  transcript: string | null;
}

// A kid's subject row, or undefined when it has gone (an older pruned
// candidate) or isn't a kid's.
function readSubjectRow(type: SubjectType, id: string): SubjectRow | undefined {
  return (type === 'candidate'
    ? db.prepare(`
        SELECT cp.user_id, cp.url, cp.external_id AS youtube_id, cp.channel, cp.guard_verdict,
               NULL AS transcript
          FROM candidate_pool cp JOIN users u ON u.user_id = cp.user_id
         WHERE cp.candidate_id = ? AND u.role = 'kid'`).get(id)
    : db.prepare(`
        SELECT r.user_id, r.url, r.youtube_id, r.channel, r.guard_verdict, r.transcript
          FROM requests r JOIN users u ON u.user_id = r.user_id
         WHERE r.request_id = ? AND u.role = 'kid'`).get(id)) as SubjectRow | undefined;
}

interface DecisionRow {
  subject_type: SubjectType;
  subject_id: string;
  user_id: string;
  url: string;
  youtube_id: string | null;
  guard_verdict: string | null;
  eval_id: string | null;
}

function resolve(ref: GuardInputsRef): { subject: SubjectInputs; shown: ShownEval } {
  if ('decisionId' in ref) {
    const d = db.prepare(`
      SELECT subject_type, subject_id, user_id, url, youtube_id, guard_verdict, eval_id
        FROM guard_decisions WHERE decision_id = ?
    `).get(ref.decisionId) as DecisionRow | undefined;
    if (!d) throw new NotFoundError(`decision ${ref.decisionId}`);
    const row = readSubjectRow(d.subject_type, d.subject_id);
    return {
      subject: {
        subjectType: d.subject_type,
        userId: d.user_id,
        youtubeId: d.youtube_id ?? row?.youtube_id ?? null,
        channel: row?.channel ?? null,
        transcript: row?.transcript ?? null,
      },
      // The row the Review card's guard panel shows.
      shown: shownEvalForDecision(d),
    };
  }
  const row = readSubjectRow(ref.subjectType, ref.subjectId);
  if (!row) throw new NotFoundError(`${ref.subjectType} ${ref.subjectId}`);
  return {
    subject: {
      subjectType: ref.subjectType,
      userId: row.user_id,
      youtubeId: row.youtube_id,
      channel: row.channel,
      transcript: row.transcript,
    },
    // The row the queue card's guard panel shows (or would, on a Spot check).
    shown: shownEvalForSubject(ref.subjectType, ref.subjectId, row.url, row.guard_verdict),
  };
}

export function readGuardInputs(ref: GuardInputsRef): GuardInputs {
  const { subject, shown } = resolve(ref);
  const promptVersion = shown.promptVersion;

  // A candidate is never downloaded, so its guard never had a transcript,
  // whatever version judged it.
  let transcript: GuardInputs['transcript'] = { kind: 'none' };
  if (subject.subjectType === 'request') {
    const seen = promptTranscript(promptVersion, subject.transcript);
    transcript = seen.kind === 'unknown' ? null : seen;
  }

  const meta = subject.youtubeId ? readVideoMetadata(subject.youtubeId) : null;
  const tags = formatTags(meta?.tags);
  const category = categoryName(meta?.categoryId);
  const channel = subject.channel?.trim() ?? '';

  return {
    promptVersion,
    transcript,
    tags: tags || null,
    category,
    madeForKids: meta?.madeForKids ?? null,
    metadataSent: promptSentMetadata(promptVersion),
    channelHistory: channel ? getChannelHistory(subject.userId, channel) : null,
  };
}
