import { Router, Request, Response } from 'express';
import { db } from '../../db/client';
import { ValidationError, NotFoundError } from '../../errors';
import { resolveUserById } from '../users';
import { normalizeUserAddedInterest } from './normalize';

interface InterestRow {
  id: string;
  label: string;
  category: string | null;
}

interface CategoryGroup {
  name: string;
  interests: Array<{ id: string; label: string; selected: boolean }>;
}

interface MineRow {
  interest_id: string;
  label: string;
  rank: number;
  expertise: 'beginner' | 'comfortable' | 'deep';
}

export const interestsRouter = Router();

interestsRouter.get('/', (req: Request, res: Response) => {
  const user = resolveUserById(req.query['userId']);

  const allInterests = db.prepare(
    `SELECT id, label, category FROM interests ORDER BY category, label`
  ).all() as InterestRow[];

  const selectedIds = new Set(
    (db.prepare('SELECT interest_id FROM user_interests WHERE user_id = ?').all(user.user_id) as Array<{ interest_id: string }>)
      .map((r) => r.interest_id)
  );

  const categoryMap = new Map<string, CategoryGroup>();
  for (const t of allInterests) {
    const cat = t.category ?? 'Other';
    if (!categoryMap.has(cat)) categoryMap.set(cat, { name: cat, interests: [] });
    categoryMap.get(cat)!.interests.push({ id: t.id, label: t.label, selected: selectedIds.has(t.id) });
  }

  res.json({ categories: Array.from(categoryMap.values()), selected_count: selectedIds.size });
});

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

interestsRouter.delete('/select', (req: Request, res: Response) => {
  const { userId, interestId } = req.body as { userId?: string; interestId?: string };
  const user = resolveUserById(userId);
  if (!interestId?.trim()) throw new ValidationError('interestId required');

  db.prepare('DELETE FROM user_interests WHERE user_id = ? AND interest_id = ?')
    .run(user.user_id, interestId);

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
