import { Router, Request, Response } from 'express';
import { db } from '../../db/client';
import { ValidationError, NotFoundError } from '../../errors';
import { resolveUserById } from '../users';
import { normalizeUserAddedInterest } from './normalize';
import { getInferredInterests, suppressInferredInterest, keepInferredInterest } from './inferred';

interface MineRow {
  interest_id: string;
  label: string;
  rank: number;
  expertise: 'beginner' | 'comfortable' | 'deep';
}

export const interestsRouter = Router();

interestsRouter.post('/select', (req: Request, res: Response) => {
  const { userId, interestId } = req.body as { userId?: string; interestId?: string };
  const user = resolveUserById(userId);
  if (!interestId?.trim()) throw new ValidationError('interestId required');

  const interest = db.prepare('SELECT id FROM interests WHERE id = ?').get(interestId) as { id: string } | undefined;
  if (!interest) throw new NotFoundError(`interest ${interestId}`);

  const nextRank = (db.prepare(
    'SELECT COALESCE(MAX(rank), 0) + 1 AS r FROM user_interests WHERE user_id = ?'
  ).get(user.user_id) as { r: number }).r;

  db.prepare(`
    INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
    VALUES (?, ?, ?, 'comfortable', 1, ?)
    ON CONFLICT(user_id, interest_id) DO NOTHING
  `).run(user.user_id, interestId, nextRank, new Date().toISOString());

  res.json({ interestId, selected: true });
});

// Drop the interest from the user's profile and cascade to in-flight
// candidates carrying that interest_id. Without the cascade those rows
// linger as orphaned dead-weight in scoring (rank-999 against MIN_WEIGHTED)
// — see issue #70. Surfaced/dismissed/requested rows are history and stay.
export function removeUserInterest(userId: string, interestId: string): void {
  const removeInterest = db.prepare(
    'DELETE FROM user_interests WHERE user_id = ? AND interest_id = ?'
  );
  const removeCandidates = db.prepare(`
    DELETE FROM candidate_pool
    WHERE user_id = ? AND interest_id = ?
      AND status IN ('pending', 'scored', 'guard_pending', 'guard_rejected')
  `);
  db.transaction(() => {
    removeInterest.run(userId, interestId);
    removeCandidates.run(userId, interestId);
  })();
}

interestsRouter.delete('/select', (req: Request, res: Response) => {
  const { userId, interestId } = req.body as { userId?: string; interestId?: string };
  const user = resolveUserById(userId);
  if (!interestId?.trim()) throw new ValidationError('interestId required');

  removeUserInterest(user.user_id, interestId);

  res.json({ interestId, selected: false });
});

interestsRouter.get('/mine', (req: Request, res: Response) => {
  const user = resolveUserById(req.query['userId']);

  const rows = db.prepare(`
    SELECT ui.interest_id, i.label, ui.rank, ui.expertise
    FROM user_interests ui
    INNER JOIN interests i ON i.id = ui.interest_id
    WHERE ui.user_id = ?
    ORDER BY ui.rank ASC
  `).all(user.user_id) as MineRow[];

  res.json({
    interests: rows.map((r) => ({
      interestId: r.interest_id,
      label: r.label,
      rank: r.rank,
      expertise: r.expertise,
    })),
  });
});

interestsRouter.post('/reorder', (req: Request, res: Response) => {
  const { userId, interestIds } = req.body as { userId?: string; interestIds?: unknown };
  const user = resolveUserById(userId);
  if (!Array.isArray(interestIds) || interestIds.some((v) => typeof v !== 'string')) {
    throw new ValidationError('interestIds must be an array of strings');
  }
  const ids = interestIds as string[];

  const existing = db.prepare(
    'SELECT interest_id FROM user_interests WHERE user_id = ?'
  ).all(user.user_id) as Array<{ interest_id: string }>;
  const existingSet = new Set(existing.map((r) => r.interest_id));

  if (ids.length !== existingSet.size || !ids.every((id) => existingSet.has(id))) {
    throw new ValidationError('interestIds must exactly match the user\'s current interests');
  }

  const update = db.prepare(
    'UPDATE user_interests SET rank = ? WHERE user_id = ? AND interest_id = ?'
  );
  db.transaction(() => {
    ids.forEach((id, idx) => update.run(idx + 1, user.user_id, id));
  })();

  res.json({ reordered: true, count: ids.length });
});

interestsRouter.patch('/expertise', (req: Request, res: Response) => {
  const { userId, interestId, expertise } = req.body as {
    userId?: string;
    interestId?: string;
    expertise?: string;
  };
  const user = resolveUserById(userId);
  if (!interestId?.trim()) throw new ValidationError('interestId required');
  if (expertise !== 'beginner' && expertise !== 'comfortable' && expertise !== 'deep') {
    throw new ValidationError('expertise must be beginner | comfortable | deep');
  }

  const result = db.prepare(
    'UPDATE user_interests SET expertise = ? WHERE user_id = ? AND interest_id = ?'
  ).run(expertise, user.user_id, interestId);

  if (result.changes === 0) throw new NotFoundError(`user_interest ${interestId}`);

  res.json({ interestId, expertise });
});

interestsRouter.post('/user-add', (req: Request, res: Response) => {
  const { userId, label } = req.body as { userId?: string; label?: string };
  const user = resolveUserById(userId);
  if (!label?.trim()) throw new ValidationError('label required');

  const result = normalizeUserAddedInterest(user.user_id, label);
  res.json(result);
});

// Inferred interests (#156, ADR-0008): live-derived proposals from who the
// user follows, minus declared and Removed. Inert until Kept.
interestsRouter.get('/inferred', (req: Request, res: Response) => {
  const user = resolveUserById(req.query['userId']);
  res.json({ inferred: getInferredInterests(user.user_id) });
});

// Keep promotes a proposal to a declared interest (the human act). For a kid
// this routes through the guard eval chain inside keepInferredInterest.
interestsRouter.post('/inferred/keep', (req: Request, res: Response) => {
  const { userId, interestId } = req.body as { userId?: string; interestId?: string };
  const user = resolveUserById(userId);
  if (!interestId?.trim()) throw new ValidationError('interestId required');

  const interest = db.prepare('SELECT id FROM interests WHERE id = ?').get(interestId) as { id: string } | undefined;
  if (!interest) throw new NotFoundError(`interest ${interestId}`);

  const result = keepInferredInterest(user.user_id, interestId);
  res.json({ ...result, kept: true });
});

// Remove suppresses a proposal so it is never re-derived. Does NOT unfollow.
interestsRouter.delete('/inferred', (req: Request, res: Response) => {
  const { userId, interestId } = req.body as { userId?: string; interestId?: string };
  const user = resolveUserById(userId);
  if (!interestId?.trim()) throw new ValidationError('interestId required');

  suppressInferredInterest(user.user_id, interestId);
  res.json({ interestId, suppressed: true });
});
