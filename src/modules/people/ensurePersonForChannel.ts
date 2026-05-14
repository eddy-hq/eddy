import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';

// Find or create the person + youtube output for a channel. No follow side
// effect — both /follow and /resolve route through this so the row layout
// stays consistent and a search-tap can land on a person view before any
// follow has happened. Also called from `markDownloaded` so every imported
// video produces a `people` row, closing the discovery + share-sheet gap
// where requests existed for channels with no matching person. Wrapped in a
// transaction so a failure on the second insert doesn't orphan the people row.
//
// The transaction handle itself is module-private because better-sqlite3's
// Transaction generic isn't named-exportable from this file under TS strict.
// The exported function is a thin facade with an explicit return type.
const ensurePersonForChannelTx = db.transaction(
  (channelId: string, channelName: string): { personId: string; outputId: string } => {
    const existing = db.prepare(
      'SELECT person_id, output_id FROM person_outputs WHERE output_type = ? AND external_id = ?'
    ).get('youtube', channelId) as { person_id: string; output_id: string } | undefined;

    if (existing) return { personId: existing.person_id, outputId: existing.output_id };

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

    return { personId, outputId };
  },
);

export function ensurePersonForChannel(
  channelId: string,
  channelName: string,
): { personId: string; outputId: string } {
  return ensurePersonForChannelTx(channelId, channelName);
}
