import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';

// Free-text interest normalization: takes a user-typed label, slugs it,
// resolves to an existing interest if one matches by id or label, otherwise
// creates a new interest row. Always links the resolved interest to the user
// at the next available rank, then kicks off async search-term generation
// for newly-created interests so they're searchable on the next discovery run.

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

  void generateSearchTermsAsync(interestId, trimmed);

  return { interestId, label: trimmed, isNew: true };
}

async function generateSearchTermsAsync(interestId: string, label: string): Promise<void> {
  const prompt = `Generate 4 YouTube search queries that would find good videos about "${label}". Return a JSON array of strings only, for example ["query one","query two","query three","query four"]. No explanation.`;
  let raw: string;
  try {
    raw = await ollamaGenerate(prompt);
  } catch (err) {
    logger.warn({ err, interestId }, 'User-added interest: search term generation failed');
    return;
  }
  const terms = parseOllamaJson<string[]>(raw, 'array', (parsed) => {
    if (!Array.isArray(parsed)) return null;
    return (parsed as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 4);
  });
  if (!terms) return;
  db.prepare('UPDATE interests SET search_terms = ? WHERE id = ?').run(JSON.stringify(terms), interestId);
  logger.info({ interestId, terms }, 'User-added interest search terms generated');
}
