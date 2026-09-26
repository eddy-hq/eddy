// Card provenance: where a card came from, as a pill on every card. Pure so
// the node-env Vitest harness covers it (the PWA has no jsdom/RTL).
//
//   req     the user asked for it (share sheet)
//   follow  a followed channel's upload or back catalogue
//   pick    Eddy's discovery pick
//   sent    a parent sent it from their own library (#217)

export type SourceKind = 'req' | 'follow' | 'pick' | 'sent';

// Provenance dot / pill colours — keep in sync with index.css.
export const SOURCE_DOT: Record<SourceKind, string> = {
  req: '#B8863C',          // amber-gold
  follow: 'var(--accent)', // teal
  pick: 'var(--save)',     // save green
  sent: '#5B6FA8',         // slate blue
};

// Map a request's `source` column to its provenance kind. Null for sources
// with no pill (legacy 'search' / 'dns_landing').
export function sourceKind(source: string | null | undefined): SourceKind | null {
  if (source === 'share_sheet') return 'req';
  if (source === 'channel_subscription') return 'follow';
  if (source === 'recommended') return 'pick';
  if (source === 'parent_pick') return 'sent';
  return null;
}

// The provenance line on a parent pick: "From <parent display name>". Falls
// back to a neutral line when the sender's name isn't on hand (e.g. a row
// read by a surface that doesn't join the sender).
export function sentFromLabel(sentByName: string | null | undefined): string {
  const name = sentByName?.trim();
  return name ? `From ${name}` : 'From a grown-up';
}

// The "Why this video" line on a parent pick in the detail sheet.
export function sentWhyLine(sentByName: string | null | undefined): string {
  const name = sentByName?.trim();
  return name ? `${name} sent you this.` : 'A grown-up sent you this.';
}
