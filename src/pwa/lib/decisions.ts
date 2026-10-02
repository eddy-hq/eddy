// Pure helpers for the Decisions page (Phase 6a). The shapes mirror
// /parent/decisions responses; kept here rather than imported so the PWA
// build doesn't typecheck server modules.

export type SubjectType = 'candidate' | 'request';
export type DecisionSource = 'escalation' | 'spot_check' | 'catch_up';
export type HumanVerdict = 'clear_yes' | 'clear_no';
export type DecisionEffect = 'eligible' | 'blocked' | 'shown' | 'removed' | 'label_only';

// What a Block meant (#227): unsafe for this kid, or not for us (quality,
// taste, relevance). Both are verdict clear_no with exactly the Block effect.
export type BlockKind = 'unsafe' | 'not_for_us';

// A parent's answer on a card: Allow, or a Block of one kind. Each is one tap.
export type Answer = 'allow' | BlockKind;

export const ANSWER_LABEL: Record<Answer, string> = {
  allow: 'Allow',
  unsafe: 'Unsafe',
  not_for_us: 'Not for us',
};

// A decision button's label; a two-kid card answers for both.
export function answerButtonLabel(answer: Answer, both: boolean): string {
  return both ? `${ANSWER_LABEL[answer]} · both` : ANSWER_LABEL[answer];
}

// The verdict and kind an answer is sent as. Allow carries no kind.
export function answerFields(answer: Answer): { verdict: HumanVerdict; blockKind?: BlockKind } {
  return answer === 'allow' ? { verdict: 'clear_yes' } : { verdict: 'clear_no', blockKind: answer };
}

export function answerVerdict(answer: Answer): HumanVerdict {
  return answer === 'allow' ? 'clear_yes' : 'clear_no';
}

// A stored answer in words: a Block with no recorded kind stays "block".
export function answerLabel(verdict: HumanVerdict, blockKind: BlockKind | null): string {
  if (verdict === 'clear_yes') return 'allow';
  if (blockKind === 'unsafe') return 'unsafe';
  if (blockKind === 'not_for_us') return 'not for us';
  return 'block';
}

export interface ShownEval {
  evalId: string | null;
  verdict: string | null;
  reason: string | null;
  scores: Record<string, number> | null;
  promptVersion?: string | null;
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
  blockKind?: BlockKind;
}

// One card's decisions: every kid on the card ("same for both"), or only the
// named kid. The answer's kind and the card's reason, if any, go on each.
export function decisionsForCard(
  card: DecisionCard,
  answer: Answer,
  onlyUserId?: string,
  reason: ReasonDraft = EMPTY_REASON,
): DecisionPayloadItem[] {
  const fields = reasonFields(reason);
  return card.subjects
    .filter((s) => !onlyUserId || s.userId === onlyUserId)
    .map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId, ...answerFields(answer), ...fields }));
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

export type KeyAction = Answer | 'skip' | 'next';

// Desktop shortcuts: a allow, u unsafe, f not for us, s skip; Enter or space
// continues past a revealed Spot check. While a reveal is showing only "next"
// applies, so a stray key can't decide the following card unseen. There is no
// plain Block key: every Block says which kind it is, and "n" (next) is never
// a decision, so a double tap past a reveal decides nothing.
export const ANSWER_KEY: Record<Answer, string> = { allow: 'A', unsafe: 'U', not_for_us: 'F' };

export function keyAction(key: string, revealing: boolean): KeyAction | null {
  const k = key.toLowerCase();
  if (revealing) return k === 'enter' || k === ' ' || k === 'n' ? 'next' : null;
  if (k === 'a') return 'allow';
  if (k === 'u') return 'unsafe';
  if (k === 'f') return 'not_for_us';
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

// ── Review (#223) ────────────────────────────────────────────────────────────
//
// Past decisions, re-checked and changed. A change is a revision: the first
// answer stays recorded, the latest revision is the current answer.

export type ReviewFilter = 'disagreements' | 'all';
export type RevisionEffect = 'removed' | 'blocked' | 'eligible' | 'label_only';

export interface StoredReason {
  dimensions: string[];
  text: string | null;
}

export interface ReviewDecision {
  decisionId: string;
  decidedAt: string;
  guardVerdict: string | null;
  firstVerdict: HumanVerdict;
  // Absent from an older server: treated as not recorded.
  firstBlockKind?: BlockKind | null;
  firstReason: StoredReason | null;
  verdict: HumanVerdict;
  blockKind?: BlockKind | null;
  reason: StoredReason | null;
  revision: { revisedAt: string; effect: RevisionEffect; count: number } | null;
}

export interface ReviewCard extends DecisionCard {
  decision: ReviewDecision;
}

export interface ReviewPage {
  filter: ReviewFilter;
  cards: ReviewCard[];
  reasons: ReasonOptions;
  counts: { disagreements: number; all: number };
  nextOffset: number | null;
}

export interface RevisionOutcome {
  decisionId: string;
  revisionId: string;
  verdict: HumanVerdict;
  blockKind?: BlockKind | null;
  effect: RevisionEffect;
  card: ReviewCard;
}

export const REVIEW_FILTER_LABEL: Record<ReviewFilter, string> = {
  disagreements: 'Disagreements',
  all: 'All decisions',
};

// The guard gave a clear verdict and the parent the other one. An uncertain
// or missing guard verdict (an Escalation) is never a disagreement.
export function isDisagreement(guardVerdict: string | null, verdict: HumanVerdict): boolean {
  return (guardVerdict === 'clear_yes' || guardVerdict === 'clear_no') && guardVerdict !== verdict;
}

// Mirrors the server: a card disagreeing on its first answer or its current
// one stays under Disagreements, so a change into agreement can be seen.
// Either Block kind is a Block here: the comparison is on the verdict.
export function matchesReviewFilter(card: ReviewCard, filter: ReviewFilter): boolean {
  if (filter === 'all') return true;
  const d = card.decision;
  return isDisagreement(d.guardVerdict, d.firstVerdict) || isDisagreement(d.guardVerdict, d.verdict);
}

// The answers a card can change to: every answer but the current one. An
// Allow can become either kind of Block; a Block can become Allow or the
// other kind, and a Block with no recorded kind can be given either.
export function changeOptions(card: ReviewCard): Answer[] {
  const d = card.decision;
  if (d.verdict === 'clear_yes') return ['unsafe', 'not_for_us'];
  const kind = d.blockKind ?? null;
  return (['allow', 'unsafe', 'not_for_us'] as const).filter((a) => a !== kind);
}

// Setting or changing a Block's kind keeps it a Block: recorded as a
// revision, nothing live changes.
export function isKindOnlyChange(card: ReviewCard, answer: Answer): boolean {
  return card.decision.verdict === 'clear_no' && answer !== 'allow';
}

export function changeLabel(answer: Answer): string {
  return `Change to ${ANSWER_LABEL[answer]}`;
}

export function revisionBody(
  userId: string,
  card: ReviewCard,
  answer: Answer,
  reason: ReasonDraft = EMPTY_REASON,
): { userId: string; decisionId: string; verdict: HumanVerdict; blockKind?: BlockKind } & ReasonFields {
  return { userId, decisionId: card.decision.decisionId, ...answerFields(answer), ...reasonFields(reason) };
}

export function revisionEffectLabel(effect: RevisionEffect): string {
  switch (effect) {
    case 'removed': return 'Removed from the feed';
    case 'blocked': return 'Taken out of the pool';
    case 'eligible': return 'Can be picked for a future slate';
    case 'label_only': return 'Label only, nothing live changed';
  }
}

// "You said unsafe", or "You said allow, now not for us" once revised. A
// Block with no recorded kind reads "block".
export function answerLine(decision: ReviewDecision): string {
  const first = `You said ${answerLabel(decision.firstVerdict, decision.firstBlockKind ?? null)}`;
  return decision.revision ? `${first}, now ${answerLabel(decision.verdict, decision.blockKind ?? null)}` : first;
}

// A recorded reason as chip labels plus the note, or null when none was given.
export function storedReasonSummary(reason: StoredReason | null, options: ReasonOptions | undefined): string | null {
  if (!reason) return null;
  const labels = reason.dimensions.map((k) => options?.dimensions.find((d) => d.key === k)?.label ?? k);
  if (reason.text) labels.push(`"${reason.text}"`);
  return labels.length > 0 ? labels.join(', ') : null;
}

// Put a changed card back in its place; it leaves the list only if it no
// longer matches the filter.
export function applyRevision(cards: readonly ReviewCard[], updated: ReviewCard, filter: ReviewFilter): ReviewCard[] {
  return cards
    .map((c) => (c.key === updated.key ? updated : c))
    .filter((c) => c.key !== updated.key || matchesReviewFilter(c, filter));
}

// The next page appended, skipping any card already shown (a decision
// recorded between pages shifts the offsets by one).
export function appendReviewPage(cards: readonly ReviewCard[], page: readonly ReviewCard[]): ReviewCard[] {
  const seen = new Set(cards.map((c) => c.key));
  return [...cards, ...page.filter((c) => !seen.has(c.key))];
}

// The list on screen. `loadId` changes on every fresh first page (a filter
// switch, a switch back, a refetch), so a later page knows which list it
// was asked for.
export interface ReviewList {
  loadId: number;
  filter: ReviewFilter;
  cards: ReviewCard[];
  nextOffset: number | null;
}

// Only a different filter retires the list on screen: re-selecting the
// current one would clear it with nothing to reload it.
export function isFilterSwitch(current: ReviewFilter, next: ReviewFilter): boolean {
  return current !== next;
}

export function freshReviewList(previous: ReviewList | null, page: ReviewPage): ReviewList {
  return { loadId: (previous?.loadId ?? 0) + 1, filter: page.filter, cards: page.cards, nextOffset: page.nextOffset };
}

// A changed card back into the list. When it leaves the filter, the server's
// filtered list shrinks by one ahead of the next page, so the offset steps
// back one (else the next unseen decision is skipped), and any page already
// in flight, asked for at the old offset, is retired.
export function reviseInList(list: ReviewList, updated: ReviewCard): ReviewList {
  const cards = applyRevision(list.cards, updated, list.filter);
  if (cards.length === list.cards.length) return { ...list, cards };
  return {
    ...list,
    loadId: list.loadId + 1,
    cards,
    nextOffset: list.nextOffset === null ? null : Math.max(0, list.nextOffset - 1),
  };
}

// A "Show more" page lands only on the list it was asked for: a response
// that arrives after the list was reloaded (the parent switched filter, or
// switched away and back) is dropped, so it can't mix another list's cards
// in or move this list's offset.
export function mergeReviewPage(
  list: ReviewList,
  requestedLoadId: number,
  page: { cards: readonly ReviewCard[]; nextOffset: number | null },
): ReviewList {
  if (list.loadId !== requestedLoadId) return list;
  return { ...list, cards: appendReviewPage(list.cards, page.cards), nextOffset: page.nextOffset };
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

// ── What the guard saw (#225) ────────────────────────────────────────────────
//
// The guard prompt's inputs beyond the title, channel and description the card
// already shows. Fetched when the parent opens the section.

export interface GuardInputs {
  promptVersion: string | null;
  // null: not known for this prompt version, so nothing is shown.
  transcript: { kind: 'excerpt'; text: string } | { kind: 'none' } | null;
  tags: string | null;
  category: string | null;
  madeForKids: boolean | null;
  // False when the judging prompt wasn't sent tags, category or audience.
  metadataSent: boolean | null;
  channelHistory: { approved: number; rejected: number } | null;
}

// Which subject to ask about: a Review card's decision, else the subject.
export function guardInputsParams(
  userId: string,
  subject: Pick<CardSubject, 'subjectType' | 'subjectId'>,
  decisionId?: string,
): URLSearchParams {
  return decisionId
    ? new URLSearchParams({ userId, decisionId })
    : new URLSearchParams({ userId, subjectType: subject.subjectType, subjectId: subject.subjectId });
}

export interface GuardInputRow {
  label: string;
  value: string;
  // The transcript excerpt: shown as a block, not a line.
  block?: boolean;
  // Stored, but the judging prompt wasn't sent it.
  notSent?: boolean;
}

// The section's rows, in prompt order. A field with nothing stored is left
// out; so is the transcript when its excerpt isn't known for the version.
export function guardInputRows(inputs: GuardInputs): GuardInputRow[] {
  const rows: GuardInputRow[] = [];
  const notSent = inputs.metadataSent === false ? { notSent: true } : {};
  if (inputs.category) rows.push({ label: 'Category', value: inputs.category, ...notSent });
  if (inputs.tags) rows.push({ label: 'Tags', value: inputs.tags, ...notSent });
  if (inputs.madeForKids !== null) {
    rows.push({ label: 'YouTube audience', value: inputs.madeForKids ? 'Made for kids' : 'Not made for kids', ...notSent });
  }
  const h = inputs.channelHistory;
  if (h) {
    rows.push({
      label: 'Channel history (now)',
      value: h.approved > 0 || h.rejected > 0
        ? `${h.approved} approved, ${h.rejected} rejected`
        : 'No requests from this channel',
    });
  }
  if (inputs.transcript?.kind === 'excerpt') {
    rows.push({ label: 'Transcript excerpt', value: inputs.transcript.text, block: true });
  } else if (inputs.transcript?.kind === 'none') {
    rows.push({ label: 'Transcript', value: 'The guard had no transcript' });
  }
  if (inputs.promptVersion) rows.push({ label: 'Prompt', value: inputs.promptVersion });
  return rows;
}
