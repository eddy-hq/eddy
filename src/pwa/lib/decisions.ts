// Pure helpers for the Decisions page (Phase 6a). The shapes mirror
// /parent/decisions responses; kept here rather than imported so the PWA
// build doesn't typecheck server modules.

export type SubjectType = 'candidate' | 'request';
export type DecisionSource = 'escalation' | 'spot_check' | 'catch_up';
export type HumanVerdict = 'clear_yes' | 'clear_no';
export type DecisionEffect = 'eligible' | 'blocked' | 'shown' | 'removed' | 'label_only';

export interface ShownEval {
  evalId: string | null;
  verdict: string | null;
  reason: string | null;
  scores: Record<string, number> | null;
}

export interface CardSubject {
  subjectType: SubjectType;
  subjectId: string;
  userId: string;
  kidName: string;
  ageBand: string;
  guard: ShownEval | null;
}

export interface DecisionCard {
  key: string;
  source: DecisionSource;
  url: string;
  youtubeId: string | null;
  title: string;
  channel: string | null;
  // YouTube channel id, when known — what "Block channel" acts on.
  channelId: string | null;
  description: string;
  thumbnailUrl: string | null;
  addedAt: string;
  subjects: CardSubject[];
}

export interface DecisionQueue {
  mode: 'today' | 'catch_up';
  focus: 'escalations' | 'spot_checks' | null;
  cards: DecisionCard[];
  counts: { escalations: number; escalationsRecent: number; spotChecksToday: number };
}

export interface DecisionOutcome {
  subjectType: SubjectType;
  subjectId: string;
  source: DecisionSource;
  effect: DecisionEffect;
  alreadyDecided: boolean;
  guard: ShownEval;
}

export interface DecisionPayloadItem {
  subjectType: SubjectType;
  subjectId: string;
  verdict: HumanVerdict;
}

// One card's decisions: every kid on the card ("same for both"), or only the
// named kid.
export function decisionsForCard(card: DecisionCard, verdict: HumanVerdict, onlyUserId?: string): DecisionPayloadItem[] {
  return card.subjects
    .filter((s) => !onlyUserId || s.userId === onlyUserId)
    .map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId, verdict }));
}

// Drop decided subjects from the local queue; a card goes once every kid on
// it is decided.
export function removeDecided(cards: readonly DecisionCard[], decidedSubjectIds: ReadonlySet<string>): DecisionCard[] {
  return cards
    .map((c) => ({ ...c, subjects: c.subjects.filter((s) => !decidedSubjectIds.has(s.subjectId)) }))
    .filter((c) => c.subjects.length > 0);
}

// Skip: the card moves to the back of the local queue. Nothing is recorded.
export function skipCard(cards: readonly DecisionCard[], key: string): DecisionCard[] {
  const card = cards.find((c) => c.key === key);
  if (!card) return [...cards];
  return [...cards.filter((c) => c.key !== key), card];
}

// ── Block channel ────────────────────────────────────────────────────────────

export interface BlockChannelResult {
  channel: { channelId: string; displayName: string };
  alreadyBlocked: boolean;
  poolRowsRemoved: number;
  outcomes: DecisionOutcome[];
}

// Only a card whose channel id is known can block its channel.
export function canBlockChannel(card: DecisionCard): boolean {
  return !!card.channelId;
}

// Every kid on the card: the video is recorded as a Block for each of them.
export function blockChannelSubjects(card: DecisionCard): Array<{ subjectType: SubjectType; subjectId: string }> {
  return card.subjects.map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId }));
}

export function channelLabel(card: DecisionCard): string {
  return card.channel?.trim() || 'this channel';
}

export function blockChannelPrompt(card: DecisionCard): string {
  return `Block ${channelLabel(card)} for every kid?`;
}

// After a block, every queued card from the channel goes: by id, or by name
// for a card whose channel id isn't known (the server matches the same way).
export function removeChannelCards(
  cards: readonly DecisionCard[],
  channel: { channelId: string; displayName: string },
): DecisionCard[] {
  return cards.filter((c) => c.channelId
    ? c.channelId !== channel.channelId
    : !(c.channel && c.channel === channel.displayName));
}

export function blockChannelFlash(result: BlockChannelResult): string {
  const name = result.channel.displayName;
  const n = result.poolRowsRemoved;
  const removed = n === 0 ? 'nothing else queued' : `${n} queued video${n === 1 ? '' : 's'} removed`;
  return `${result.alreadyBlocked ? 'Already blocked' : 'Blocked'} ${name} · ${removed}`;
}

export type KeyAction = 'allow' | 'block' | 'skip' | 'next';

// Desktop shortcuts: a allow, b block, s skip; Enter or space continues past
// a revealed Spot check. While a reveal is showing only "next" applies, so a
// stray key can't decide the following card unseen.
export function keyAction(key: string, revealing: boolean): KeyAction | null {
  const k = key.toLowerCase();
  if (revealing) return k === 'enter' || k === ' ' || k === 'n' ? 'next' : null;
  if (k === 'a') return 'allow';
  if (k === 'b') return 'block';
  if (k === 's') return 'skip';
  return null;
}

export const SOURCE_LABEL: Record<DecisionSource, string> = {
  escalation: 'Escalation',
  spot_check: 'Spot check',
  catch_up: 'Catch-up spot check',
};

export function verdictLabel(verdict: string | null): string {
  if (verdict === 'clear_yes') return 'allow';
  if (verdict === 'clear_no') return 'block';
  if (verdict === 'uncertain') return 'unsure';
  return 'no verdict';
}

export function effectLabel(effect: DecisionEffect): string {
  switch (effect) {
    case 'eligible': return 'Can now be picked for the feed';
    case 'blocked': return 'Taken out of the pool';
    case 'shown': return 'Now in the feed';
    case 'removed': return 'Removed from the feed';
    case 'label_only': return 'Recorded';
  }
}

// How the parent's answer compares with the guard's, for the Spot check
// reveal. An uncertain or missing verdict isn't a disagreement.
export function agreement(human: HumanVerdict, guardVerdict: string | null): 'agree' | 'disagree' | 'none' {
  if (guardVerdict !== 'clear_yes' && guardVerdict !== 'clear_no') return 'none';
  return guardVerdict === human ? 'agree' : 'disagree';
}

const DIMENSION_LABELS: Array<[string, string]> = [
  ['language', 'Language'],
  ['violence', 'Violence'],
  ['frightening', 'Frightening'],
  ['sexual', 'Sexual'],
  ['substances', 'Substances'],
  ['dangerous', 'Dangerous'],
  ['commercial', 'Commercial'],
  ['attitude', 'Attitude'],
];

// Rubric scores in rubric order, flagging Moderate or above.
export function formatScores(scores: Record<string, number> | null): Array<{ label: string; value: number; high: boolean }> {
  if (!scores) return [];
  return DIMENSION_LABELS
    .filter(([key]) => typeof scores[key] === 'number')
    .map(([key, label]) => ({ label, value: scores[key]!, high: scores[key]! >= 2 }));
}
