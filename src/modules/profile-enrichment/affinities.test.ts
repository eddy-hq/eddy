import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'gemma4:e4b',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
  },
}));

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../queue', () => ({
  redis: {},
  profileEnrichmentQueue: { add: vi.fn() },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { ollamaGenerate } from '../../ollama';
import {
  AFFINITY_MIN_LIFETIME_EVENTS,
  buildAffinityDigest,
  buildAffinityPrompt,
  checkAffinityEligibility,
  parseAffinityResponse,
  persistAffinities,
  readActiveAffinities,
  regenerateAffinities,
} from './affinities';

const USER_KID = '11111111-1111-7111-8111-111111111111';
const USER_PARENT = '11111111-1111-7111-8111-111111111222';
const USER_OTHER = '11111111-1111-7111-8111-111111111333';
const PERSON_A = '22222222-2222-7222-8222-22222222aaaa';
const PERSON_B = '22222222-2222-7222-8222-22222222bbbb';
const INTEREST_ID = '33333333-3333-7333-8333-333333333abc';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function insertWatchEvent(opts: {
  user_id: string;
  video_id: string;
  reason: 'ended' | 'dismissed' | 'navigated' | 'backgrounded';
  position_s?: number;
  duration_s?: number;
  title?: string | null;
}): string {
  const requestId = `req-${opts.user_id}-${opts.video_id}`;
  const existing = db.prepare('SELECT 1 FROM requests WHERE request_id = ?').get(requestId);
  if (!existing) {
    db.prepare(`
      INSERT INTO requests
        (request_id, user_id, source, url, youtube_id, title, status, requested_at)
      VALUES (?, ?, 'discovery', ?, ?, ?, 'ready', ?)
    `).run(
      requestId, opts.user_id,
      `https://www.youtube.com/watch?v=${opts.video_id}`,
      opts.video_id, opts.title ?? `Title for ${opts.video_id}`,
      nowIso(),
    );
  }
  const eventId = `evt-${requestId}-${opts.reason}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO watch_events
      (event_id, user_id, request_id, video_id, source, started_at, ended_at,
       position_s, duration_s, reason)
    VALUES (?, ?, ?, ?, 'discovery', ?, ?, ?, ?, ?)
  `).run(
    eventId, opts.user_id, requestId, opts.video_id,
    nowIso(), nowIso(),
    opts.position_s ?? 0,
    opts.duration_s ?? 600,
    opts.reason,
  );
  return eventId;
}

// Seeds the raw engagement the person aggregate counts: `watched` completed
// plays and `dismissed` mid-play bailouts, each on its own request from the
// person's channel. `source` is the requests.source of those rows.
function seedBehaviouralSignal(opts: {
  user_id: string; person_id: string; watched: number; dismissed: number; source?: string;
}): void {
  const channelId = `UC-${opts.person_id}`;
  db.prepare(`
    INSERT OR IGNORE INTO person_outputs (output_id, person_id, output_type, external_id)
    VALUES (?, ?, 'youtube', ?)
  `).run(`out-${opts.person_id}`, opts.person_id, channelId);
  const seed = (reason: 'ended' | 'dismissed', n: number): void => {
    for (let i = 0; i < n; i++) {
      const videoId = `v-${opts.person_id}-${opts.source ?? 'rec'}-${reason}-${i}`;
      const requestId = `req-${opts.user_id}-${videoId}`;
      db.prepare(`
        INSERT INTO requests
          (request_id, user_id, source, url, youtube_id, youtube_channel_id, title, status, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)
      `).run(
        requestId, opts.user_id, opts.source ?? 'recommended',
        `https://www.youtube.com/watch?v=${videoId}`, videoId, channelId, `Title ${videoId}`, nowIso(),
      );
      db.prepare(`
        INSERT INTO watch_events
          (event_id, user_id, request_id, video_id, source, started_at, ended_at,
           position_s, duration_s, reason)
        VALUES (?, ?, ?, ?, 'feed', ?, ?, ?, 600, ?)
      `).run(`evt-${requestId}`, opts.user_id, requestId, videoId, nowIso(), nowIso(),
        reason === 'ended' ? 600 : 10, reason);
    }
  };
  seed('ended', opts.watched);
  seed('dismissed', opts.dismissed);
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_KID, 'Boy1', 'kid', 12, nowIso());
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_PARENT, 'Parent', 'parent', 0, nowIso());
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_OTHER, 'Other', 'guest', 0, nowIso());
  db.prepare(
    'INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)',
  ).run(PERSON_A, 'Person A', 'individual', nowIso());
  db.prepare(
    'INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)',
  ).run(PERSON_B, 'Person B', 'individual', nowIso());
  db.prepare(
    'INSERT INTO interests (id, label, search_terms, source) VALUES (?, ?, ?, ?)',
  ).run(INTEREST_ID, 'robotics', '[]', 'user_added');
});

beforeEach(() => {
  db.exec('DELETE FROM affinity_evidence');
  db.exec('DELETE FROM inferred_affinities');
  db.exec('DELETE FROM behavioural_signals');
  db.exec('DELETE FROM watch_events');
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM requests');
  vi.mocked(ollamaGenerate).mockReset();
});

describe('checkAffinityEligibility', () => {
  it('rejects users below the lifetime watch-event floor', () => {
    for (let i = 0; i < AFFINITY_MIN_LIFETIME_EVENTS - 1; i++) {
      insertWatchEvent({ user_id: USER_KID, video_id: `vid-${i}`, reason: 'ended' });
    }
    const result = checkAffinityEligibility(USER_KID);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('too_few_events');
    expect(result.events).toBe(AFFINITY_MIN_LIFETIME_EVENTS - 1);
  });

  it('accepts users at the floor exactly', () => {
    for (let i = 0; i < AFFINITY_MIN_LIFETIME_EVENTS; i++) {
      insertWatchEvent({ user_id: USER_KID, video_id: `vid-${i}`, reason: 'ended' });
    }
    expect(checkAffinityEligibility(USER_KID).eligible).toBe(true);
  });

  it('accepts a kid with enough events', () => {
    for (let i = 0; i < 40; i++) {
      insertWatchEvent({ user_id: USER_KID, video_id: `vid-${i}`, reason: 'ended' });
    }
    const result = checkAffinityEligibility(USER_KID);
    expect(result.eligible).toBe(true);
    expect(result.role).toBe('kid');
  });

  it('accepts a parent with enough events', () => {
    for (let i = 0; i < 40; i++) {
      insertWatchEvent({ user_id: USER_PARENT, video_id: `vid-${i}`, reason: 'ended' });
    }
    expect(checkAffinityEligibility(USER_PARENT).eligible).toBe(true);
  });

  it('rejects non-kid/parent roles even with enough events', () => {
    for (let i = 0; i < 40; i++) {
      insertWatchEvent({ user_id: USER_OTHER, video_id: `vid-${i}`, reason: 'ended' });
    }
    const result = checkAffinityEligibility(USER_OTHER);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('role');
    expect(result.role).toBe('guest');
  });

  it('rejects an unknown user_id outright', () => {
    expect(checkAffinityEligibility('does-not-exist').eligible).toBe(false);
  });
});

describe('buildAffinityDigest', () => {
  it('orders top-watched persons by watched_count DESC and includes display names', () => {
    seedBehaviouralSignal({ user_id: USER_KID, person_id: PERSON_A, watched: 20, dismissed: 2 });
    seedBehaviouralSignal({ user_id: USER_KID, person_id: PERSON_B, watched: 8, dismissed: 0 });

    const digest = buildAffinityDigest(USER_KID);
    expect(digest.topWatched.map((p) => p.personId)).toEqual([PERSON_A, PERSON_B]);
    expect(digest.topWatched[0]?.displayName).toBe('Person A');
  });

  it('lists top-dismissed persons separately from watched', () => {
    seedBehaviouralSignal({ user_id: USER_KID, person_id: PERSON_A, watched: 1, dismissed: 0 });
    seedBehaviouralSignal({ user_id: USER_KID, person_id: PERSON_B, watched: 0, dismissed: 7 });

    const digest = buildAffinityDigest(USER_KID);
    expect(digest.topDismissed[0]?.personId).toBe(PERSON_B);
    expect(digest.topDismissed[0]?.dismissedCount).toBe(7);
  });

  it('leaves parent picks (#217) out of the person counts', () => {
    seedBehaviouralSignal({ user_id: USER_KID, person_id: PERSON_A, watched: 3, dismissed: 0 });
    // Engagement that exists only on videos a parent sent: no inferred taste.
    seedBehaviouralSignal({ user_id: USER_KID, person_id: PERSON_B, watched: 9, dismissed: 4, source: 'parent_pick' });

    const digest = buildAffinityDigest(USER_KID);
    expect(digest.topWatched.map((p) => p.personId)).toEqual([PERSON_A]);
    expect(digest.topDismissed).toEqual([]);
    expect(digest.sampleTitles.every((t) => !t.title.includes(PERSON_B))).toBe(true);
  });

  it('returns empty arrays when the user has no signal at all', () => {
    const digest = buildAffinityDigest(USER_KID);
    expect(digest.topWatched).toEqual([]);
    expect(digest.topDismissed).toEqual([]);
    expect(digest.perInterest).toEqual([]);
    expect(digest.sampleTitles).toEqual([]);
  });

  it('captures sample titles from each end of the engagement spectrum', () => {
    insertWatchEvent({
      user_id: USER_KID, video_id: 'vid-w-1', reason: 'ended',
      title: 'Long-form Robotics Deep Dive',
    });
    insertWatchEvent({
      user_id: USER_KID, video_id: 'vid-d-1', reason: 'dismissed',
      title: 'Clickbait Top 10',
    });
    const digest = buildAffinityDigest(USER_KID);
    const watched = digest.sampleTitles.filter((t) => t.bucket === 'watched');
    const dismissed = digest.sampleTitles.filter((t) => t.bucket === 'dismissed');
    expect(watched.map((t) => t.title)).toContain('Long-form Robotics Deep Dive');
    expect(dismissed.map((t) => t.title)).toContain('Clickbait Top 10');
  });
});

describe('buildAffinityPrompt', () => {
  it('includes person ids, interest ids, and sample titles', () => {
    const prompt = buildAffinityPrompt({
      userId: USER_KID,
      topWatched: [{ personId: PERSON_A, displayName: 'Person A', watchedCount: 12, dismissedCount: 1 }],
      topDismissed: [{ personId: PERSON_B, displayName: 'Person B', watchedCount: 0, dismissedCount: 6 }],
      perInterest: [{ interestId: INTEREST_ID, label: 'robotics', watchedCount: 9 }],
      sampleTitles: [
        { bucket: 'watched', title: 'A Watched Title' },
        { bucket: 'dismissed', title: 'A Dismissed Title' },
      ],
    });
    expect(prompt).toContain(`[id=${PERSON_A}]`);
    expect(prompt).toContain(`[id=${PERSON_B}]`);
    expect(prompt).toContain(`[id=${INTEREST_ID}]`);
    expect(prompt).toContain('A Watched Title');
    expect(prompt).toContain('A Dismissed Title');
  });

  it('falls back to placeholders when a section is empty', () => {
    const prompt = buildAffinityPrompt({
      userId: USER_KID,
      topWatched: [],
      topDismissed: [],
      perInterest: [],
      sampleTitles: [],
    });
    expect(prompt).toContain('(none)');
  });
});

describe('parseAffinityResponse', () => {
  it('parses a clean JSON object with statements + evidence', () => {
    const raw = JSON.stringify({
      statements: [
        {
          statement: 'Likes long-form robotics explainers.',
          confidence: 0.8,
          evidence: [{ ref_type: 'interest', ref_id: INTEREST_ID, note: 'top per-interest watch count' }],
        },
      ],
    });
    const out = parseAffinityResponse(raw);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.confidence).toBe(0.8);
    expect(out?.[0]?.evidence[0]?.refType).toBe('interest');
    expect(out?.[0]?.evidence[0]?.refId).toBe(INTEREST_ID);
  });

  it('clamps confidence into [0, 1]', () => {
    const raw = JSON.stringify({
      statements: [
        { statement: 'A', confidence: 1.6, evidence: [] },
        { statement: 'B', confidence: -0.3, evidence: [] },
      ],
    });
    const out = parseAffinityResponse(raw);
    expect(out?.[0]?.confidence).toBe(1.0);
    expect(out?.[1]?.confidence).toBe(0.0);
  });

  it('drops evidence rows whose ref_type is outside the allowed set', () => {
    const raw = JSON.stringify({
      statements: [{
        statement: 'A',
        confidence: 0.5,
        evidence: [
          { ref_type: 'person', ref_id: PERSON_A },
          { ref_type: 'channel', ref_id: 'UCxxxxx' },
          { ref_type: 'content_item', ref_id: 'vid-1' },
        ],
      }],
    });
    const out = parseAffinityResponse(raw);
    expect(out?.[0]?.evidence.map((e) => e.refType)).toEqual(['person', 'content_item']);
  });

  it('returns null for malformed input', () => {
    expect(parseAffinityResponse('not json')).toBeNull();
    expect(parseAffinityResponse('{"statements":[]}')).toBeNull();
    expect(parseAffinityResponse('{"statements":[{"confidence":0.5}]}')).toBeNull();
  });
});

describe('persistAffinities (supersede + insert)', () => {
  it('keeps old rows with superseded_at set rather than deleting them', () => {
    const t1 = nowIso();
    persistAffinities(
      USER_KID,
      [{ statement: 'Old statement', confidence: 0.6, evidence: [] }],
      t1,
    );

    const t2 = nowIso(60_000);
    persistAffinities(
      USER_KID,
      [{ statement: 'New statement', confidence: 0.9, evidence: [] }],
      t2,
    );

    const rows = db.prepare(
      'SELECT statement, superseded_at FROM inferred_affinities WHERE user_id = ? ORDER BY generated_at ASC'
    ).all(USER_KID) as Array<{ statement: string; superseded_at: string | null }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.statement).toBe('Old statement');
    expect(rows[0]?.superseded_at).toBe(t2);
    expect(rows[1]?.statement).toBe('New statement');
    expect(rows[1]?.superseded_at).toBeNull();
  });

  it('full-replaces: the new active set is exactly what was inserted', () => {
    persistAffinities(
      USER_KID,
      [
        { statement: 'A', confidence: 0.7, evidence: [] },
        { statement: 'B', confidence: 0.6, evidence: [] },
      ],
    );
    persistAffinities(
      USER_KID,
      [{ statement: 'C', confidence: 0.9, evidence: [] }],
    );

    const active = readActiveAffinities(USER_KID, 10);
    expect(active.map((a) => a.statement)).toEqual(['C']);
  });

  it('writes evidence rows tied to the new affinity_id', () => {
    persistAffinities(
      USER_KID,
      [{
        statement: 'Likes deep robotics videos',
        confidence: 0.85,
        evidence: [
          { refType: 'interest', refId: INTEREST_ID, note: 'top watched interest' },
          { refType: 'person', refId: PERSON_A },
        ],
      }],
    );

    const affinity = db.prepare(
      'SELECT affinity_id FROM inferred_affinities WHERE user_id = ?'
    ).get(USER_KID) as { affinity_id: string };

    const evidence = db.prepare(
      'SELECT ref_type, ref_id, note FROM affinity_evidence WHERE affinity_id = ? ORDER BY ref_type ASC'
    ).all(affinity.affinity_id) as Array<{ ref_type: string; ref_id: string; note: string | null }>;

    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.ref_type).toBe('interest');
    expect(evidence[0]?.note).toBe('top watched interest');
    expect(evidence[1]?.ref_type).toBe('person');
    expect(evidence[1]?.ref_id).toBe(PERSON_A);
  });

  it('rejects evidence rows with disallowed ref_type via the CHECK constraint', () => {
    // The persistAffinities entry point only takes typed EvidenceRefType, so
    // we go direct to the table to prove the CHECK fires. Belt-and-braces:
    // even if a future caller bypasses the parser, the DB enforces the
    // constraint.
    persistAffinities(
      USER_KID,
      [{ statement: 'A', confidence: 0.5, evidence: [] }],
    );
    const affinity = db.prepare(
      'SELECT affinity_id FROM inferred_affinities WHERE user_id = ?'
    ).get(USER_KID) as { affinity_id: string };

    expect(() => db.prepare(`
      INSERT INTO affinity_evidence (evidence_id, affinity_id, ref_type, ref_id, note)
      VALUES (?, ?, 'channel', ?, NULL)
    `).run('ev-bogus', affinity.affinity_id, 'UCxxx')).toThrowError();
  });
});

describe('regenerateAffinities', () => {
  function seedEligibleUser(): void {
    for (let i = 0; i < AFFINITY_MIN_LIFETIME_EVENTS; i++) {
      insertWatchEvent({
        user_id: USER_KID, video_id: `vid-${i}`, reason: 'ended',
        title: `Watched title ${i}`,
      });
    }
    seedBehaviouralSignal({ user_id: USER_KID, person_id: PERSON_A, watched: 15, dismissed: 1 });
  }

  it('skips with reason "too_few_events" when below the floor', async () => {
    for (let i = 0; i < 10; i++) {
      insertWatchEvent({ user_id: USER_KID, video_id: `vid-${i}`, reason: 'ended' });
    }
    const result = await regenerateAffinities(USER_KID);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('too_few_events');
    expect(vi.mocked(ollamaGenerate)).not.toHaveBeenCalled();
  });

  it('skips with reason "role" for a non-kid/parent user', async () => {
    for (let i = 0; i < AFFINITY_MIN_LIFETIME_EVENTS; i++) {
      insertWatchEvent({ user_id: USER_OTHER, video_id: `vid-${i}`, reason: 'ended' });
    }
    const result = await regenerateAffinities(USER_OTHER);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('role');
    expect(vi.mocked(ollamaGenerate)).not.toHaveBeenCalled();
  });

  it('calls Gemma and persists statements when eligible', async () => {
    seedEligibleUser();
    vi.mocked(ollamaGenerate).mockResolvedValueOnce(JSON.stringify({
      statements: [
        {
          statement: 'Likes long-form videos from Person A',
          confidence: 0.85,
          evidence: [{ ref_type: 'person', ref_id: PERSON_A }],
        },
        {
          statement: 'Engages with robotics content',
          confidence: 0.7,
          evidence: [{ ref_type: 'interest', ref_id: INTEREST_ID }],
        },
        {
          statement: 'Avoids reaction-style videos',
          confidence: 0.55,
          evidence: [],
        },
      ],
    }));

    const result = await regenerateAffinities(USER_KID);
    expect(result.skipped).toBe(false);
    expect(result.statementCount).toBe(3);
    expect(result.evidenceCount).toBe(2);

    const active = readActiveAffinities(USER_KID, 10);
    expect(active).toHaveLength(3);
    expect(active[0]?.confidence).toBeGreaterThanOrEqual(active[1]?.confidence ?? 0);
  });

  it('skips with reason "gemma_failed" if the Ollama call throws', async () => {
    seedEligibleUser();
    vi.mocked(ollamaGenerate).mockRejectedValueOnce(new Error('boom'));
    const result = await regenerateAffinities(USER_KID);
    expect(result.skipReason).toBe('gemma_failed');
  });

  it('skips with reason "parse_failed" if Gemma returns garbage', async () => {
    seedEligibleUser();
    vi.mocked(ollamaGenerate).mockResolvedValueOnce('not json at all');
    const result = await regenerateAffinities(USER_KID);
    expect(result.skipReason).toBe('parse_failed');
  });

  it('skips with reason "too_few_statements" when Gemma returns fewer than the minimum', async () => {
    seedEligibleUser();
    // Seed a prior run so we can also confirm we don't supersede it on skip.
    persistAffinities(USER_KID, [
      { statement: 'Prior run A', confidence: 0.8, evidence: [] },
      { statement: 'Prior run B', confidence: 0.7, evidence: [] },
      { statement: 'Prior run C', confidence: 0.6, evidence: [] },
    ]);
    vi.mocked(ollamaGenerate).mockResolvedValueOnce(JSON.stringify({
      statements: [
        { statement: 'Just one short statement', confidence: 0.4, evidence: [] },
      ],
    }));

    const result = await regenerateAffinities(USER_KID);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('too_few_statements');

    const active = readActiveAffinities(USER_KID, 10);
    expect(active.map((a) => a.statement)).toEqual(
      expect.arrayContaining(['Prior run A', 'Prior run B', 'Prior run C']),
    );
    expect(active).toHaveLength(3);
  });

  it('drops evidence refs that do not resolve against the underlying tables', async () => {
    seedEligibleUser();
    vi.mocked(ollamaGenerate).mockResolvedValueOnce(JSON.stringify({
      statements: [
        {
          statement: 'Valid statement with mixed evidence',
          confidence: 0.8,
          evidence: [
            { ref_type: 'person', ref_id: PERSON_A },                          // resolves
            { ref_type: 'person', ref_id: '99999999-9999-7999-8999-999999999999' }, // orphan
            { ref_type: 'interest', ref_id: INTEREST_ID },                     // resolves
            { ref_type: 'interest', ref_id: 'not-a-real-interest-id' },        // orphan
          ],
        },
        { statement: 'Filler B', confidence: 0.6, evidence: [] },
        { statement: 'Filler C', confidence: 0.55, evidence: [] },
      ],
    }));

    const result = await regenerateAffinities(USER_KID);
    expect(result.skipped).toBe(false);
    // 2 evidence rows resolve (the two orphans are dropped).
    expect(result.evidenceCount).toBe(2);

    const affinity = db.prepare(
      "SELECT affinity_id FROM inferred_affinities WHERE statement = 'Valid statement with mixed evidence'"
    ).get() as { affinity_id: string };
    const rows = db.prepare(
      'SELECT ref_type, ref_id FROM affinity_evidence WHERE affinity_id = ?'
    ).all(affinity.affinity_id) as Array<{ ref_type: string; ref_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ref_id).sort()).toEqual([INTEREST_ID, PERSON_A].sort());
  });

  it('on re-run, supersedes the prior set and inserts the new one (full replace)', async () => {
    seedEligibleUser();
    vi.mocked(ollamaGenerate)
      .mockResolvedValueOnce(JSON.stringify({
        statements: [
          { statement: 'First-run A', confidence: 0.5, evidence: [] },
          { statement: 'First-run B', confidence: 0.45, evidence: [] },
          { statement: 'First-run C', confidence: 0.4, evidence: [] },
        ],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        statements: [
          { statement: 'Second-run A', confidence: 0.9, evidence: [] },
          { statement: 'Second-run B', confidence: 0.7, evidence: [] },
          { statement: 'Second-run C', confidence: 0.6, evidence: [] },
        ],
      }));

    const r1 = await regenerateAffinities(USER_KID);
    expect(r1.statementCount).toBe(3);

    const r2 = await regenerateAffinities(USER_KID);
    expect(r2.statementCount).toBe(3);
    expect(r2.supersededCount).toBe(3);

    const all = db.prepare(
      'SELECT statement, superseded_at FROM inferred_affinities WHERE user_id = ? ORDER BY generated_at ASC, statement ASC'
    ).all(USER_KID) as Array<{ statement: string; superseded_at: string | null }>;
    expect(all).toHaveLength(6);
    expect(all.slice(0, 3).every((r) => r.superseded_at !== null)).toBe(true);
    expect(all.slice(3).every((r) => r.superseded_at === null)).toBe(true);
  });
});
