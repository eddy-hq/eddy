import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';

// Find or create the person + youtube output for a channel. No follow side
// effect — both /follow and /resolve route through this so the row layout
// stays consistent and a search-tap can land on a person view before any
// follow has happened. Wrapped in a transaction so a failure on the second
// insert doesn't orphan the people row.
//
// `created` distinguishes a freshly-inserted row from an idempotent hit so
// callers (e.g. markDownloaded) can decide whether to fire a channel-info
// capture — we don't want a yt-dlp call on every video from a creator we've
// already indexed.
//
// Lives in its own leaf file so callers in the request lifecycle (state.ts)
// can pull just this helper without dragging the rest of the people barrel
// (RSS poller, router, yt-dlp, ollama-backed interest inference) into their
// module graph.
const ensurePersonForChannelTxn = db.transaction(
  (channelId: string, channelName: string): { personId: string; outputId: string; created: boolean } => {
    const existing = db.prepare(
      'SELECT person_id, output_id FROM person_outputs WHERE output_type = ? AND external_id = ?'
    ).get('youtube', channelId) as { person_id: string; output_id: string } | undefined;

    if (existing) {
      return { personId: existing.person_id, outputId: existing.output_id, created: false };
    }

    const personId = uuidv7();
    const outputId = uuidv7();
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO people (person_id, display_name, person_type, created_at)
      VALUES (?, ?, 'individual', ?)
    `).run(personId, channelName, now);

    db.prepare(`
      INSERT INTO person_outputs (output_id, person_id, output_type, fetcher_type, feed_url, external_id, active)
      VALUES (?, ?, 'youtube', 'youtube-rss', ?, ?, 1)
    `).run(outputId, personId, feedUrl, channelId);

    return { personId, outputId, created: true };
  },
);

export function ensurePersonForChannel(
  channelId: string,
  channelName: string,
): { personId: string; outputId: string; created: boolean } {
  return ensurePersonForChannelTxn(channelId, channelName);
}
