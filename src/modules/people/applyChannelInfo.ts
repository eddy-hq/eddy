import { db } from '../../db/client';
import { logger } from '../../logger';
import { channelInfo } from '../../ytdlp';
import { extractBio } from './util';

// Fetches channel description + avatar via yt-dlp and applies them to the
// person row. Silent — yt-dlp failures and unusable descriptions both leave
// the existing values in place (COALESCE), so a transient flake doesn't
// wipe out a previously-captured bio. Drift will surface meaningful changes
// in a later phase.
export async function applyChannelInfoToPerson(personId: string, channelId: string): Promise<void> {
  let info: { description: string | null; avatarUrl: string | null };
  try {
    info = await channelInfo(channelId);
  } catch (err) {
    logger.debug({ err, channelId, personId }, 'Channel info fetch failed');
    return;
  }

  const bio = extractBio(info.description);

  db.prepare(
    'UPDATE people SET bio = COALESCE(?, bio), photo_url = COALESCE(?, photo_url) WHERE person_id = ?'
  ).run(bio, info.avatarUrl, personId);

  logger.debug(
    { personId, channelId, hasBio: !!bio, hasPhoto: !!info.avatarUrl },
    'Person channel info applied',
  );
}
