import { db } from '../../db/client';
import { getDeclaredInterestLinks } from '../interests';

// Follow suggestions (#151). A flat top-5 list of creators the user has engaged
// with (watched or saved) but does not follow, gated to those mapping to ≥1
// *declared* interest, ranked by engagement strength. This grows the followed
// roster that feed quality now leans on. The surface is cheap SQL; the
// channel→interest alignment data is populated out-of-band by a nightly Gemma
// pass (profile-enrichment), not at render time.
//
// Module boundary: the engagement read (requests → person_outputs → people)
// lives here because the people module owns the suggestion concept. The
// channel_interest_links read is delegated to the interests-module export
// getDeclaredInterestLinks — this file never queries channel_interest_links
// directly.

export interface FollowSuggestion {
  channelId: string;
  displayName: string;
  photoUrl: string | null;
  interests: Array<{ id: string; label: string }>;
  watchedCount: number;
  savedCount: number;
  reason: string;
}

// Literal reason-line per brief §1 ("no automated recommendation without a
// visible reason"). Counts are reported separately because a request can be
// both watched and saved. Labels are comma-joined.
//   both > 0 → "Watched 4 · saved 2 — football"
//   watched only → "Watched 4 — football"
//   saved only → "Saved 2 — football"
export function buildSuggestionReason(
  watchedCount: number,
  savedCount: number,
  labels: string[],
): string {
  // The leading count word is capitalised ("Watched …" / "Saved …"); a trailing
  // count joined after a middot stays lower-case ("Watched 4 · saved 2 …").
  const parts: string[] = [];
  if (watchedCount > 0) parts.push(`watched ${watchedCount}`);
  if (savedCount > 0) parts.push(`saved ${savedCount}`);
  let counts = parts.join(' · ');
  counts = counts.charAt(0).toUpperCase() + counts.slice(1);
  const labelText = labels.join(', ');
  return `${counts} — ${labelText}`;
}

interface EngagedChannelRow {
  channel_id: string;
  display_name: string;
  photo_url: string | null;
  watched_count: number;
  saved_count: number;
  engaged_count: number;
  last_engaged_at: string;
}

const ENGAGED_CHANNELS_SQL = `
  SELECT r.youtube_channel_id AS channel_id,
         p.display_name AS display_name,
         p.photo_url AS photo_url,
         COUNT(DISTINCT CASE WHEN r.watched_at IS NOT NULL THEN r.request_id END) AS watched_count,
         COUNT(DISTINCT CASE WHEN r.saved_at IS NOT NULL THEN r.request_id END) AS saved_count,
         COUNT(DISTINCT CASE WHEN r.watched_at IS NOT NULL OR r.saved_at IS NOT NULL THEN r.request_id END) AS engaged_count,
         MAX(MAX(COALESCE(r.watched_at, '')), MAX(COALESCE(r.saved_at, ''))) AS last_engaged_at
  FROM requests r
  INNER JOIN person_outputs po
    ON po.external_id = r.youtube_channel_id
   AND po.output_type = 'youtube'
  INNER JOIN people p
    ON p.person_id = po.person_id
  WHERE r.user_id = @user_id
    AND r.youtube_channel_id IS NOT NULL
    AND (r.watched_at IS NOT NULL OR r.saved_at IS NOT NULL)
    AND po.person_id NOT IN (
      SELECT person_id FROM followed_people WHERE user_id = @user_id
    )
    AND r.youtube_channel_id NOT IN (
      SELECT channel_id FROM follow_suggestion_dismissals WHERE user_id = @user_id
    )
  GROUP BY r.youtube_channel_id, p.display_name, p.photo_url
`;

export function getFollowSuggestions(userId: string): FollowSuggestion[] {
  const engaged = db.prepare(ENGAGED_CHANNELS_SQL).all({ user_id: userId }) as EngagedChannelRow[];
  if (engaged.length === 0) return [];

  // Alignment hard-filter: keep only channels with ≥1 declared-interest link.
  // The interests export delegates the channel_interest_links read; we group
  // its rows by channel so every matching label can be attached to the row.
  const links = getDeclaredInterestLinks(userId);
  const labelsByChannel = new Map<string, Array<{ id: string; label: string }>>();
  for (const link of links) {
    const list = labelsByChannel.get(link.channelId) ?? [];
    list.push({ id: link.interestId, label: link.label });
    labelsByChannel.set(link.channelId, list);
  }

  const suggestions: FollowSuggestion[] = [];
  for (const row of engaged) {
    const interests = labelsByChannel.get(row.channel_id);
    if (!interests || interests.length === 0) continue;

    const labels = interests.map((i) => i.label);
    suggestions.push({
      channelId: row.channel_id,
      displayName: row.display_name,
      photoUrl: row.photo_url,
      interests,
      watchedCount: row.watched_count,
      savedCount: row.saved_count,
      reason: buildSuggestionReason(row.watched_count, row.saved_count, labels),
    });
  }

  // Rank by distinct watched-or-saved request count DESC, tie-break by most
  // recent engagement DESC. The engaged_count/last_engaged_at carry the sort
  // keys (kept on the row, not in the public tuple).
  const byChannel = new Map(engaged.map((r) => [r.channel_id, r]));
  suggestions.sort((a, b) => {
    const ra = byChannel.get(a.channelId)!;
    const rb = byChannel.get(b.channelId)!;
    if (rb.engaged_count !== ra.engaged_count) return rb.engaged_count - ra.engaged_count;
    return rb.last_engaged_at.localeCompare(ra.last_engaged_at);
  });

  return suggestions.slice(0, 5);
}

interface DismissResult {
  channelId: string;
  dismissed: true;
}

// Durable dismiss: a human act that hides the channel from suggestions for
// good. Insert-or-ignore so a repeat dismiss is a no-op.
export function dismissFollowSuggestion(userId: string, channelId: string): DismissResult {
  db.prepare(`
    INSERT INTO follow_suggestion_dismissals (user_id, channel_id, dismissed_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, channel_id) DO NOTHING
  `).run(userId, channelId, new Date().toISOString());
  return { channelId, dismissed: true };
}
