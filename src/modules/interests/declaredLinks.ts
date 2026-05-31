import { db } from '../../db/client';

// Channel → declared-interest links (#151). The follow-suggestion surface lives
// in the people module but must not query channel_interest_links directly —
// that table is interests-owned (module boundary). This leaf is the sanctioned
// read: for a given user, every channel_interest_links row whose interest the
// user has *declared* (present in user_interests for that user), joined to
// interests for label/category.
//
// This is the hard alignment filter from #151 decision #3: a creator is only
// suggested if engaged-but-not-followed AND maps to ≥1 declared interest. We
// gate on user_interests membership (unlike inferred.ts, which gates on
// followed_people), so a channel linked only to interests the user has *not*
// declared yields no rows here and is excluded from suggestions.

export interface DeclaredInterestLink {
  channelId: string;
  interestId: string;
  label: string;
  category: string | null;
}

interface DeclaredLinkRow {
  channel_id: string;
  interest_id: string;
  label: string;
  category: string | null;
}

export function getDeclaredInterestLinks(userId: string): DeclaredInterestLink[] {
  const rows = db.prepare(`
    SELECT cil.channel_id AS channel_id,
           i.id AS interest_id,
           i.label AS label,
           i.category AS category
    FROM channel_interest_links cil
    INNER JOIN interests i
      ON i.id = cil.interest_id
    WHERE cil.interest_id IN (
      SELECT interest_id FROM user_interests WHERE user_id = ?
    )
  `).all(userId) as DeclaredLinkRow[];

  return rows.map((r) => ({
    channelId: r.channel_id,
    interestId: r.interest_id,
    label: r.label,
    category: r.category,
  }));
}

// Engaged-not-followed channels that currently lack ANY channel_interest_links
// row (#151 decision #4: "inferChannelInterests over engaged-not-followed
// channels lacking links"). The nightly profile-enrichment pass runs
// inferChannelInterests over these so the suggestion surface has alignment data
// to gate on. The "lacking links" predicate touches channel_interest_links
// (interests-owned), so profile-enrichment delegates here rather than querying
// that table directly.
//
// A channel qualifies when:
//   (a) it has ≥1 watched-or-saved request,
//   (b) it has no channel_interest_links row, and
//   (c) at least one engaging user does not follow its person — a channel every
//       engaging user already follows can never become a suggestion (the
//       suggestion surface excludes followed channels), so inferring its links
//       is wasted Gemma work. Followed channels are already inferred at
//       follow-time; this keeps the channel-global pass to candidates that can
//       actually surface.
// The channel name is resolved from the request (requests.channel) or, failing
// that, the linked person's display_name — so inferChannelInterests has a name
// to categorise on. Channels with no resolvable name are skipped (Gemma needs a
// name to categorise).

export interface EngagedChannelLackingLinks {
  channelId: string;
  channelName: string;
}

interface EngagedChannelRow {
  channel_id: string;
  channel_name: string | null;
}

export function getEngagedChannelsLackingInterestLinks(): EngagedChannelLackingLinks[] {
  const rows = db.prepare(`
    SELECT r.youtube_channel_id AS channel_id,
           COALESCE(MAX(r.channel), MAX(p.display_name)) AS channel_name
    FROM requests r
    LEFT JOIN person_outputs po
      ON po.external_id = r.youtube_channel_id
     AND po.output_type = 'youtube'
    LEFT JOIN people p
      ON p.person_id = po.person_id
    WHERE r.youtube_channel_id IS NOT NULL
      AND (r.watched_at IS NOT NULL OR r.saved_at IS NOT NULL)
      AND r.youtube_channel_id NOT IN (
        SELECT channel_id FROM channel_interest_links
      )
      -- (c) keep only channels at least one engaging user does not follow: the
      -- engaging user has no followed_people row for the channel's person.
      AND NOT EXISTS (
        SELECT 1 FROM followed_people fp
        WHERE fp.user_id = r.user_id AND fp.person_id = po.person_id
      )
    GROUP BY r.youtube_channel_id
  `).all() as EngagedChannelRow[];

  return rows
    .filter((r): r is EngagedChannelRow & { channel_name: string } =>
      typeof r.channel_name === 'string' && r.channel_name.trim().length > 0)
    .map((r) => ({ channelId: r.channel_id, channelName: r.channel_name }));
}
