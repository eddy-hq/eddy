import { db } from '../../db/client';
import { config } from '../../config';
import { logger } from '../../logger';
import { channelInfo } from '../../ytdlp';
import { extractBio } from './util';

const DAY_MS = 86_400_000;

// Fetches channel description + avatar via yt-dlp and applies them to the
// person row. Silent — yt-dlp failures and unusable descriptions both leave
// the existing values in place (COALESCE), so a transient flake doesn't
// wipe out a previously-captured bio. Drift will surface meaningful changes
// in a later phase.
//
// Staleness gate (#185): this is called fire-and-forget once per followed
// channel on every RSS poll pass, which turns a daily poll into a wide
// concurrent yt-dlp channel-page burst from the shared residential IP. Channel
// bio/avatar are near-static, so we skip the fetch entirely while the last
// successful refresh is within PERSON_CHANNEL_INFO_TTL_DAYS. A null/missing
// timestamp counts as stale, so a brand-new follow still enriches on its next
// poll; a failed fetch leaves the timestamp untouched, so it retries next pass.
export async function applyChannelInfoToPerson(personId: string, channelId: string): Promise<void> {
  const ttlDays = config.PERSON_CHANNEL_INFO_TTL_DAYS;
  if (ttlDays > 0) {
    const row = db
      .prepare('SELECT channel_info_fetched_at FROM people WHERE person_id = ?')
      .get(personId) as { channel_info_fetched_at: string | null } | undefined;
    const fetchedAt = row?.channel_info_fetched_at;
    if (fetchedAt) {
      const ageMs = Date.now() - Date.parse(fetchedAt);
      // A NaN parse (malformed timestamp) is not finite — fall through and
      // refetch rather than skipping forever on bad data.
      if (Number.isFinite(ageMs) && ageMs < ttlDays * DAY_MS) return;
    }
  }

  let info: { description: string | null; avatarUrl: string | null };
  try {
    info = await channelInfo(channelId);
  } catch (err) {
    // Leave channel_info_fetched_at untouched so this channel retries next pass.
    logger.debug({ err, channelId, personId }, 'Channel info fetch failed');
    return;
  }

  const bio = extractBio(info.description);
  const fetchedAt = new Date().toISOString();

  // Stamp the successful fetch even when there's nothing usable to write — a
  // bio-less, avatar-less channel must not re-fetch every poll pass. The
  // bio/photo columns stay put (no COALESCE no-op write); only the timestamp
  // moves so the gate can rest until the next TTL window.
  if (bio === null && info.avatarUrl === null) {
    db.prepare('UPDATE people SET channel_info_fetched_at = ? WHERE person_id = ?')
      .run(fetchedAt, personId);
    return;
  }

  db.prepare(
    'UPDATE people SET bio = COALESCE(?, bio), photo_url = COALESCE(?, photo_url), channel_info_fetched_at = ? WHERE person_id = ?'
  ).run(bio, info.avatarUrl, fetchedAt, personId);

  logger.debug(
    { personId, channelId, hasBio: !!bio, hasPhoto: !!info.avatarUrl },
    'Person channel info applied',
  );
}
