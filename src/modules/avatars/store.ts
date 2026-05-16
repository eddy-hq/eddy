import { db } from '../../db/client';
import { NotFoundError } from '../../errors';
import { logger } from '../../logger';
import {
  AvatarConfig,
  DEFAULT_AVATAR,
  coerceAvatarConfig,
} from './types';

interface ProfileRow { profile: string | null }

// users.profile is a free-form JSON blob (see migration 001_initial). We
// read-modify-write it so the avatar key sits alongside whatever else lives
// in there without clobbering other keys.

export function getAvatar(userId: string): AvatarConfig {
  const row = db.prepare('SELECT profile FROM users WHERE user_id = ?').get(userId) as ProfileRow | undefined;
  if (!row) throw new NotFoundError(`user ${userId}`);
  const parsed = parseProfile(row.profile);
  return coerceAvatarConfig(parsed.avatar);
}

export function saveAvatar(userId: string, next: AvatarConfig): AvatarConfig {
  const validated = coerceAvatarConfig(next);

  const run = db.transaction(() => {
    const row = db.prepare('SELECT profile FROM users WHERE user_id = ?').get(userId) as ProfileRow | undefined;
    if (!row) throw new NotFoundError(`user ${userId}`);
    const profile = parseProfile(row.profile);
    profile.avatar = validated;
    db.prepare('UPDATE users SET profile = ? WHERE user_id = ?').run(JSON.stringify(profile), userId);
  });
  run();

  return validated;
}

function parseProfile(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    // Don't fail the user's request because we hit corrupt JSON — log and
    // act as if the profile were empty. The next write will overwrite it.
    logger.warn({ err }, 'Failed to parse users.profile JSON; treating as empty');
    return {};
  }
}

export { DEFAULT_AVATAR };
