// HTTP routes for the people module — search, following list, resolve, follow,
// unfollow, and person view. Mounted at `/people` by the server. Kept in its
// own file so `./index.ts` can be a pure barrel re-exporting the registry,
// poller, and router surfaces.
import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError, NotFoundError } from '../../errors';
import { inferChannelInterests } from '../interests';
import { resolveUserById } from '../users';
import { searchChannelsFlat, type SearchChannel } from '../../ytdlp';
import { applyChannelInfoToPerson, ensurePersonForChannel } from './registry';
import { getPersonView, getPersonSummaryByChannel } from './personView';
import { pollChannel } from './poller';

export const peopleRouter = Router();

// Express 4 doesn't catch rejected promises from async handlers — wrap them.
type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function ra(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// GET /people/search?q=&userId=
peopleRouter.get('/search', ra(async (req, res) => {
  const { q, userId } = req.query as { q?: string; userId?: string };
  if (!q?.trim()) throw new ValidationError('q required');
  const uid = resolveUserById(userId).user_id;

  let channels: SearchChannel[];
  let searchError = false;
  try {
    channels = await searchChannelsFlat(q.trim());
  } catch (err) {
    logger.error({ err }, 'Channel search failed');
    channels = [];
    searchError = true;
  }

  const followingIds = new Set(
    (db.prepare('SELECT po.external_id FROM followed_people fp INNER JOIN person_outputs po ON po.person_id = fp.person_id WHERE fp.user_id = ? AND po.output_type = ?').all(uid, 'youtube') as Array<{ external_id: string }>)
      .map((r) => r.external_id)
  );

  const results = channels.map((c) => ({ ...c, following: followingIds.has(c.channelId) }));
  res.json({ channels: results, searchError });
}));

// GET /people/following?userId=
peopleRouter.get('/following', (req: Request, res: Response) => {
  const { userId } = req.query as { userId?: string };
  const uid = resolveUserById(userId).user_id;

  const rows = db.prepare(`
    SELECT p.person_id, p.display_name, p.person_type, p.photo_url,
           po.output_id, po.external_id AS channel_id, po.feed_url, po.last_polled,
           fp.followed_at
    FROM followed_people fp
    INNER JOIN people p ON p.person_id = fp.person_id
    LEFT JOIN person_outputs po ON po.person_id = fp.person_id AND po.output_type = 'youtube'
    WHERE fp.user_id = ?
    ORDER BY fp.followed_at DESC
  `).all(uid);

  res.json({ following: rows });
});

// POST /people/resolve — body: { userId, channelId, channelName }
// Returns the personId for a channel, creating the person row on demand. Used
// by the search tap-through, where the user may navigate to a person view for
// a channel they don't yet follow. Requires userId — same gate as every other
// write endpoint in this module, even though no follow row is created.
peopleRouter.post('/resolve', (req: Request, res: Response) => {
  const { userId, channelId, channelName } = req.body as {
    userId?: string; channelId?: string; channelName?: string;
  };
  if (!channelId?.trim()) throw new ValidationError('channelId required');
  if (!channelName?.trim()) throw new ValidationError('channelName required');
  resolveUserById(userId);

  const { personId } = ensurePersonForChannel(channelId.trim(), channelName.trim());

  // Best-effort bio + photo capture so a thin page (no items, never followed)
  // still has something visible. Fire-and-forget — the /resolve response
  // returns the personId immediately and the page poll picks up the rest.
  void applyChannelInfoToPerson(personId, channelId.trim())
    .catch((err: unknown) => logger.debug({ err, channelId }, 'Capture channel info on resolve failed'));

  res.json({ personId });
});

// POST /people/follow — body: { userId, channelId, channelName, channelUrl }
peopleRouter.post('/follow', (req: Request, res: Response) => {
  const { userId, channelId, channelName } = req.body as {
    userId?: string; channelId?: string; channelName?: string; channelUrl?: string;
  };
  if (!channelId?.trim()) throw new ValidationError('channelId required');
  if (!channelName?.trim()) throw new ValidationError('channelName required');
  const uid = resolveUserById(userId).user_id;

  const { personId, outputId } = ensurePersonForChannel(channelId.trim(), channelName.trim());

  // Upsert follow
  const alreadyFollowing = db.prepare(
    'SELECT 1 FROM followed_people WHERE user_id = ? AND person_id = ?'
  ).get(uid, personId);

  if (!alreadyFollowing) {
    db.prepare(`
      INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
      VALUES (?, ?, 1.0, ?, 'manual')
    `).run(uid, personId, new Date().toISOString());
  }

  // Fire-and-forget: capture the person's bio + photo from the channel's
  // about page. Runs alongside the poll so bio/photo land on the row shortly
  // after follow, without blocking the response.
  void applyChannelInfoToPerson(personId, channelId)
    .catch((err: unknown) => logger.warn({ err, channelId }, 'Capture channel info on follow failed'));

  // Fire-and-forget, but ordered: infer the channel's interest links FIRST,
  // then poll. The immediate poll's first-poll confirmation candidate is a
  // 'subscription' candidate that must carry the channel's interest_id
  // (ADR-0009), read from channel_interest_links — which inferChannelInterests
  // populates. Running them concurrently races a (slower, Gemma-backed)
  // inference against the poll, so the candidate would be written with a null
  // interest_id and then marked seen, leaving the daily poll unable to repair
  // it. Awaiting inference before the poll closes that race; the whole chain
  // stays off the HTTP response path.
  void (async () => {
    try {
      await inferChannelInterests(channelId, channelName.trim());
    } catch (err) {
      logger.error({ err, channelId }, 'Channel interest inference failed');
    }
    try {
      await pollChannel({ output_id: outputId, channel_id: channelId, person_id: personId, channel_name: channelName.trim() });
    } catch (err) {
      logger.error({ err, channelId }, 'Immediate post-follow poll failed');
    }
  })();

  logger.info({ userId: uid, personId, channelId }, 'User followed channel');
  res.json({ personId, channelId, following: true });
});

// GET /people/by-channel/:channelId?userId=
// Lightweight Person summary for a YouTube channel — drives the player's
// Person row (#138). Read-only: never creates a Person or fires capture.
// 404 when no Person row exists for the channel yet (caller renders the
// not-followed row from the channel name it already holds). Two-segment path
// so it can't collide with the single-segment /:personId route below.
peopleRouter.get('/by-channel/:channelId', (req: Request, res: Response) => {
  const { channelId } = req.params as { channelId: string };
  const { userId } = req.query as { userId?: string };
  const uid = resolveUserById(userId).user_id;

  const summary = getPersonSummaryByChannel(channelId, uid);
  if (!summary) throw new NotFoundError(`person for channel ${channelId}`);

  res.json(summary);
});

// GET /people/:personId?userId=
peopleRouter.get('/:personId', (req: Request, res: Response) => {
  const { personId } = req.params as { personId: string };
  const { userId } = req.query as { userId?: string };
  const user = resolveUserById(userId);
  const view = getPersonView(personId, user.user_id);
  res.json({ ...view, userRole: user.role });
});

// DELETE /people/follow/:channelId?userId=
peopleRouter.delete('/follow/:channelId', (req: Request, res: Response) => {
  const { channelId } = req.params as { channelId: string };
  const { userId } = req.query as { userId?: string };
  const uid = resolveUserById(userId).user_id;

  const output = db.prepare(
    'SELECT person_id FROM person_outputs WHERE output_type = ? AND external_id = ?'
  ).get('youtube', channelId) as { person_id: string } | undefined;

  if (!output) throw new NotFoundError(`channel ${channelId}`);

  db.prepare('DELETE FROM followed_people WHERE user_id = ? AND person_id = ?')
    .run(uid, output.person_id);

  logger.info({ userId: uid, channelId }, 'User unfollowed channel');
  res.json({ channelId, following: false });
});
