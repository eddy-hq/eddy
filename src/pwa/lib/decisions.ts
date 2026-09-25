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

// Reason chips offered on each card: the rubric's scored dimensions, served
// with the queue (the rubric's one source is on the server).
export interface ReasonOptions {
  dimensions: Array<{ key: string; label: string }>;
  textMax: number;
}

export interface DecisionQueue {
  mode: 'today' | 'catch_up';
  focus: 'escalations' | 'spot_checks' | null;
  cards: DecisionCard[];
  counts: { escalations: number; escalationsRecent: number; spotChecksToday: number };
  reasons: ReasonOptions;
}

export interface DecisionOutcome {
  subjectType: SubjectType;
  subjectId: string;
  source: DecisionSource;
  effect: DecisionEffect;
  alreadyDecided: boolean;
  guard: ShownEval;
}

// ── Reason chips ─────────────────────────────────────────────────────────────
//
// Optional, picked on the card before Allow / Block, and sent with the
// decision in the same request. Nothing picked is a bare decision.

export interface ReasonDraft {
  dimensions: string[];
  text: string;
}

export const EMPTY_REASON: ReasonDraft = { dimensions: [], text: '' };

// Toggle a chip. Selected chips stay in the offered (rubric) order whatever
// order they were tapped in; a key not on offer is ignored.
export function toggleReasonDimension(draft: ReasonDraft, key: string, options: ReasonOptions): ReasonDraft {
  const offered = options.dimensions.map((d) => d.key);
  if (!offered.includes(key)) return draft;
  const selected = new Set(draft.dimensions);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  return { ...draft, dimensions: offered.filter((k) => selected.has(k)) };
}

// The note, cut to the server's cap.
export function setReasonText(draft: ReasonDraft, text: string, options: ReasonOptions): ReasonDraft {
  return { ...draft, text: text.slice(0, options.textMax) };
}

export function hasReason(draft: ReasonDraft): boolean {
  return draft.dimensions.length > 0 || draft.text.trim().length > 0;
}

export interface ReasonFields {
  reasonDimensions?: string[];
  reasonText?: string;
}

// The fields a decision request carries; empty ones are left out, so a card
// with no reason posts exactly what a bare decision always has.
export function reasonFields(draft: ReasonDraft): ReasonFields {
  const out: ReasonFields = {};
  if (draft.dimensions.length > 0) out.reasonDimensions = [...draft.dimensions];
  const text = draft.text.trim();
  if (text) out.reasonText = text;
  return out;
}

// "Add a reason" collapsed: a short summary of what's picked, if anything.
export function reasonSummary(draft: ReasonDraft, options: ReasonOptions): string | null {
  if (!hasReason(draft)) return null;
  const labels = draft.dimensions.map((k) => options.dimensions.find((d) => d.key === k)?.label ?? k);
  if (draft.text.trim()) labels.push('note');
  return labels.join(', ');
}

export interface DecisionPayloadItem extends ReasonFields {
  subjectType: SubjectType;
  subjectId: string;
  verdict: HumanVerdict;
}

// One card's decisions: every kid on the card ("same for both"), or only the
// named kid. The card's reason, if any, goes on each.
export function decisionsForCard(
  card: DecisionCard,
  verdict: HumanVerdict,
  onlyUserId?: string,
  reason: ReasonDraft = EMPTY_REASON,
): DecisionPayloadItem[] {
  const fields = reasonFields(reason);
  return card.subjects
    .filter((s) => !onlyUserId || s.userId === onlyUserId)
    .map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId, verdict, ...fields }));
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

// The Block channel request: every kid on the card, plus the card's reason
// (recorded on each kid's Block, as on the Block button).
export function blockChannelBody(
  userId: string,
  card: DecisionCard,
  reason: ReasonDraft = EMPTY_REASON,
): { userId: string; subjects: Array<{ subjectType: SubjectType; subjectId: string }> } & ReasonFields {
  return { userId, subjects: blockChannelSubjects(card), ...reasonFields(reason) };
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
