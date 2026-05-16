import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { interestsQueue } from '../../queue';
import { GENERATE_SEARCH_TERMS_JOB, type GenerateSearchTermsJob } from './searchTermsWorker';

// Free-text interest normalization: takes a user-typed label, slugs it,
// resolves to an existing interest if one matches by id or label, otherwise
// creates a new interest row. Always links the resolved interest to the user
// at the next available rank, then enqueues a search-terms generation job
// for newly-created interests so they're searchable on the next discovery
// run. The kid-interest guard eval (#110) fires in-band from the router; it
// is not chained from here.

export interface NormalizedUserInterest {
  interestId: string;
  label: string;
  isNew: boolean;
}

export function normalizeUserAddedInterest(userId: string, label: string): NormalizedUserInterest {
  const trimmed = label.trim();
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');
  const interestId = slug || uuidv7();
  const now = new Date().toISOString();

  const nextRank = (db.prepare(
    'SELECT COALESCE(MAX(rank), 0) + 1 AS r FROM user_interests WHERE user_id = ?'
  ).get(userId) as { r: number }).r;

  const existing = db.prepare(
    'SELECT id FROM interests WHERE id = ? OR label = ?'
  ).get(interestId, trimmed) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
      VALUES (?, ?, ?, 'comfortable', 1, ?)
      ON CONFLICT(user_id, interest_id) DO NOTHING
    `).run(userId, existing.id, nextRank, now);

    return { interestId: existing.id, label: trimmed, isNew: false };
  }

  db.prepare(`
    INSERT OR IGNORE INTO interests (id, label, category, source, search_terms)
    VALUES (?, ?, NULL, 'user_added', '[]')
  `).run(interestId, trimmed);

  db.prepare(`
    INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
    VALUES (?, ?, ?, 'comfortable', 1, ?)
    ON CONFLICT(user_id, interest_id) DO NOTHING
  `).run(userId, interestId, nextRank, now);

  const payload: GenerateSearchTermsJob = {
    interestId,
    label: trimmed,
    userId,
    isUserAdded: true,
  };
  void interestsQueue.add(GENERATE_SEARCH_TERMS_JOB, payload).catch((err: unknown) => {
    logger.warn({ err, interestId }, 'User-added interest: failed to enqueue search-terms job');
  });

  return { interestId, label: trimmed, isNew: true };
}
