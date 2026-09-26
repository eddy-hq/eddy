// Send to (#217): a parent sends a video from their own library to one or
// both kids' feeds. Pure helpers behind the Send-to tile and its inline picker
// in VideoDetailSheet, kept here so the node-env Vitest harness covers them.

// A kid the parent can send to, from GET /requests/send-targets.
export interface SendTarget {
  userId: string;
  displayName: string;
}

// One per-kid result from POST /requests/:id/send.
export interface SendResult {
  kidId: string;
  displayName: string;
  outcome: 'sent' | 'already' | 'in_review';
  requestId: string;
}

export interface PickerOption {
  key: string;
  label: string;
  kidIds: string[];
}

// The picker's options: each kid by name, then "Both" when there are exactly
// two (or "Everyone" for more). A single kid gets just their own option.
export function pickerOptions(kids: SendTarget[]): PickerOption[] {
  const options: PickerOption[] = kids.map((k) => ({
    key: k.userId,
    label: k.displayName,
    kidIds: [k.userId],
  }));
  if (kids.length >= 2) {
    options.push({
      key: 'all',
      label: kids.length === 2 ? 'Both' : 'Everyone',
      kidIds: kids.map((k) => k.userId),
    });
  }
  return options;
}

// Whether to offer Send to at all: the caller is a parent (the send-targets
// read returns kids only for a parent) and the video is playable.
export function canSendTo(kids: SendTarget[] | undefined, isReady: boolean): boolean {
  return isReady && !!kids && kids.length > 0;
}

// The ActionGrid's column count. Kids keep the three-up Save / Delete /
// Share row; a parent with Send to gets a 2×2 grid.
export function actionGridColumns(showSend: boolean): 2 | 3 {
  return showSend ? 2 : 3;
}

// The armed Delete tile spans every column but Save's.
export function armedDeleteSpan(columns: 2 | 3): number {
  return columns - 1;
}

function joinNames(names: string[]): string {
  return names.join(' and ');
}

// The line shown after a send. "Sent" / "Already in their feed" when every
// kid landed the same way; otherwise one clause per outcome.
export function sendResultMessage(results: SendResult[]): string {
  if (results.length === 0) return 'Nothing sent';
  const sent = results.filter((r) => r.outcome === 'sent').map((r) => r.displayName);
  const already = results.filter((r) => r.outcome === 'already').map((r) => r.displayName);
  const inReview = results.filter((r) => r.outcome === 'in_review').map((r) => r.displayName);

  if (sent.length === results.length) return 'Sent';
  if (already.length === results.length) return 'Already in their feed';

  const parts: string[] = [];
  if (sent.length) parts.push(`Sent to ${joinNames(sent)}`);
  if (already.length) parts.push(`${joinNames(already)} already ${already.length === 1 ? 'has' : 'have'} it`);
  if (inReview.length) parts.push(`${joinNames(inReview)}: waiting in Decisions`);
  return parts.join(' · ');
}
