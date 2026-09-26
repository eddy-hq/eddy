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

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import {
  DISAGREEMENT_DISMISS_RATIO,
  DISAGREEMENT_MIN_INTERACTIONS,
  buildDepthObservations,
  buildDisagreementObservations,
  computeDriftObservations,
  generateDriftObservations,
  isoWeek,
  isoWeekRange,
  persistDriftObservations,
  readDriftObservations,
} from './observations';

const USER = '11111111-1111-7111-8111-111111111111';
const PERSON = '22222222-2222-7222-8222-22222222aaaa';
const INTEREST_ECON = '33333333-3333-7333-8333-3333333econ';
const INTEREST_ROBO = '33333333-3333-7333-8333-3333333robo';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

// Declares an interest for USER (a real user_interests row — the explicit
// profile). This is the row a disagreement observation must NOT delete.
function declareInterest(interestId: string, rank: number): void {
  db.prepare(`
    INSERT INTO user_interests (user_id, interest_id, liked, rank, expertise, added_at)
    VALUES (?, ?, 1, ?, 'comfortable', ?)
  `).run(USER, interestId, rank, nowIso());
}

// Inserts a candidate tagged with an interest plus, optionally, a backing
// request + watch event so the same video reads as watched or mid-play
// dismissed. `status='dismissed'` models a pre-play swipe — surfaced_at is set
// to the swipe time (the candidate must have been surfaced to be swiped),
// unless `notSurfaced` is set to model a never-surfaced candidate.
//
// `createdAt` defaults to `at` but can be set independently to model a
// candidate that entered the pool well before it was surfaced/swiped.
function seedInterestInteraction(opts: {
  interestId: string;
  videoId: string;
  status?: string;
  watchReason?: 'ended' | 'dismissed';
  at?: string;
  createdAt?: string;
  notSurfaced?: boolean;
}): void {
  const at = opts.at ?? nowIso();
  const createdAt = opts.createdAt ?? at;
  const candidateId = `cand-${opts.videoId}`;
  // Pre-play swipe-dismisses carry a surfaced_at; everything else leaves it null.
  const surfacedAt = opts.status === 'dismissed' && !opts.notSurfaced ? at : null;
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type, interest_id,
       url, external_id, status, created_at, surfaced_at)
    VALUES (?, ?, 'video', 'interest_search', ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId, USER, opts.interestId,
    `https://www.youtube.com/watch?v=${opts.videoId}`,
    opts.videoId, opts.status ?? 'scored', createdAt, surfacedAt,
  );

  if (!opts.watchReason) return;

  const requestId = `req-${opts.videoId}`;
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, title, status, requested_at)
    VALUES (?, ?, 'discovery', ?, ?, ?, 'ready', ?)
  `).run(
    requestId, USER,
    `https://www.youtube.com/watch?v=${opts.videoId}`,
    opts.videoId, `Title ${opts.videoId}`, at,
  );

  const ended = opts.watchReason === 'ended';
  db.prepare(`
    INSERT INTO watch_events
      (event_id, user_id, request_id, video_id, source, started_at, ended_at,
       position_s, duration_s, reason)
    VALUES (?, ?, ?, ?, 'discovery', ?, ?, ?, ?, ?)
  `).run(
    `evt-${opts.videoId}`, USER, requestId, opts.videoId,
    at, at,
    ended ? 600 : 10, 600, opts.watchReason,
  );
}

function insertAffinity(opts: { statement: string; confidence: number; superseded?: boolean }): string {
  const affinityId = `aff-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO inferred_affinities
      (affinity_id, user_id, statement, confidence, generated_at, superseded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(affinityId, USER, opts.statement, opts.confidence, nowIso(), opts.superseded ? nowIso() : null);
  return affinityId;
}

// Snapshot the explicit-profile tables so a test can prove no mutation.
function snapshotProfile(): {
  userInterests: unknown[];
  interests: unknown[];
  affinities: unknown[];
} {
  return {
    userInterests: db.prepare('SELECT * FROM user_interests ORDER BY interest_id').all(),
    interests: db.prepare('SELECT * FROM interests ORDER BY id').all(),
    affinities: db.prepare('SELECT * FROM inferred_affinities ORDER BY affinity_id').all(),
  };
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER, 'Boy1', 'kid', 12, nowIso());
  db.prepare(
    'INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)',
  ).run(PERSON, 'Person A', 'individual', nowIso());
  db.prepare(
    'INSERT INTO interests (id, label, search_terms, source) VALUES (?, ?, ?, ?)',
  ).run(INTEREST_ECON, 'Economics', '[]', 'user_added');
  db.prepare(
    'INSERT INTO interests (id, label, search_terms, source) VALUES (?, ?, ?, ?)',
  ).run(INTEREST_ROBO, 'Robotics', '[]', 'user_added');
});

beforeEach(() => {
  db.exec('DELETE FROM affinity_evidence');
  db.exec('DELETE FROM inferred_affinities');
  db.exec('DELETE FROM watch_events');
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM requests');
  db.exec('DELETE FROM user_interests');
  db.exec('DELETE FROM drift');
});

describe('isoWeek', () => {
  it('formats as ISO year-week with a zero-padded week number', () => {
    // 2026-01-01 is a Thursday → ISO week 2026-W01.
    expect(isoWeek(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-W01');
    // 2026-04-13 is a Monday in ISO week 16.
    expect(isoWeek(new Date(Date.UTC(2026, 3, 13)))).toBe('2026-W16');
  });

  it('rolls a Sunday into the week that started the previous Monday', () => {
    // 2026-01-04 is a Sunday → still ISO week 2026-W01.
    expect(isoWeek(new Date(Date.UTC(2026, 0, 4)))).toBe('2026-W01');
  });
});

describe('isoWeekRange', () => {
  it('returns the Monday→next-Monday UTC bounds for a week label', () => {
    const { start, end } = isoWeekRange('2026-W15');
    // 2026-W15 runs Mon 2026-04-06 to Mon 2026-04-13 (exclusive).
    expect(start).toBe('2026-04-06T00:00:00.000Z');
    expect(end).toBe('2026-04-13T00:00:00.000Z');
  });

  it('round-trips with isoWeek for an in-week date', () => {
    const date = new Date(Date.UTC(2026, 3, 8, 12));
    const { start, end } = isoWeekRange(isoWeek(date));
    expect(date.toISOString() >= start && date.toISOString() < end).toBe(true);
  });

  it('rejects a malformed week label', () => {
    expect(() => isoWeekRange('2026-15')).toThrowError();
  });
});

describe('buildDisagreementObservations', () => {
  it('flags a declared interest the user consistently skips', () => {
    declareInterest(INTEREST_ECON, 1);
    // 1 watched, 6 mid-play bailouts → ratio 0.86 over 7 interactions.
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended' });
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, watchReason: 'dismissed' });
    }

    const obs = buildDisagreementObservations(USER);
    expect(obs).toHaveLength(1);
    expect(obs[0]?.type).toBe('disagreement');
    expect(obs[0]?.refId).toBe(INTEREST_ECON);
    expect(obs[0]?.text).toContain('Economics');
  });

  it('does not flag an interest the user mostly engages with', () => {
    declareInterest(INTEREST_ROBO, 1);
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ROBO, videoId: `r-w${i}`, watchReason: 'ended' });
    }
    seedInterestInteraction({ interestId: INTEREST_ROBO, videoId: 'r-d0', watchReason: 'dismissed' });

    expect(buildDisagreementObservations(USER)).toHaveLength(0);
  });

  it('does not flag below the minimum-interactions floor (anecdotal skip)', () => {
    declareInterest(INTEREST_ECON, 1);
    // 4 dismissals, 0 watched → ratio 1.0 but only 4 interactions (< floor).
    expect(DISAGREEMENT_MIN_INTERACTIONS).toBeGreaterThan(4);
    for (let i = 0; i < 4; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, watchReason: 'dismissed' });
    }
    expect(buildDisagreementObservations(USER)).toHaveLength(0);
  });

  it('counts mid-play bailouts as dismissals via the interest tag', () => {
    declareInterest(INTEREST_ECON, 1);
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended' });
    // 5 mid-play bailouts: 5/6 = 0.83 ratio.
    for (let i = 0; i < 5; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-m${i}`, watchReason: 'dismissed' });
    }
    expect(DISAGREEMENT_DISMISS_RATIO).toBeLessThanOrEqual(0.83);
    expect(buildDisagreementObservations(USER)).toHaveLength(1);
  });

  it('counts pre-play swipe-dismisses surfaced within the week', () => {
    declareInterest(INTEREST_ECON, 1);
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended' });
    // 6 pre-play swipe-dismisses (surfaced this week) → 6/7 over the ratio.
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, status: 'dismissed' });
    }
    expect(buildDisagreementObservations(USER)).toHaveLength(1);
  });

  it('windows pre-play swipes on surfaced_at, not created_at', () => {
    declareInterest(INTEREST_ECON, 1);
    const inW15 = new Date(Date.UTC(2026, 3, 8, 12)).toISOString();
    const earlierW10 = new Date(Date.UTC(2026, 2, 4, 12)).toISOString();
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended', at: inW15 });
    // Candidates created weeks earlier (W10) but surfaced + swiped in W15.
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({
        interestId: INTEREST_ECON, videoId: `e-d${i}`, status: 'dismissed',
        at: inW15, createdAt: earlierW10,
      });
    }
    // Attributed to the surfacing week (W15), not the creation week (W10).
    expect(buildDisagreementObservations(USER, '2026-W15')).toHaveLength(1);
    expect(buildDisagreementObservations(USER, '2026-W10')).toHaveLength(0);
  });

  it('excludes pre-play dismisses that were never surfaced', () => {
    declareInterest(INTEREST_ECON, 1);
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended' });
    // 6 dismisses with no surfaced_at — can't be attributed to a week.
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, status: 'dismissed', notSurfaced: true });
    }
    expect(buildDisagreementObservations(USER)).toHaveLength(0);
  });

  it('only counts interactions inside the requested week (no stale re-fire)', () => {
    declareInterest(INTEREST_ECON, 1);
    // Heavy skipping in 2026-W15, none in 2026-W16.
    const inW15 = new Date(Date.UTC(2026, 3, 8, 12)).toISOString();
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended', at: inW15 });
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, watchReason: 'dismissed', at: inW15 });
    }

    // The skipping week reports the disagreement.
    expect(buildDisagreementObservations(USER, '2026-W15')).toHaveLength(1);
    // The following week, with no new interactions, does not re-report it.
    expect(buildDisagreementObservations(USER, '2026-W16')).toHaveLength(0);
  });

  it('still counts watch signal after the backing request is hard-deleted', () => {
    declareInterest(INTEREST_ECON, 1);
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended' });
    for (let i = 0; i < 5; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-m${i}`, watchReason: 'dismissed' });
    }
    // watch_events.video_id is denormalised so signal survives request delete.
    db.exec('DELETE FROM requests');
    // 5 mid-play bailouts vs 1 watched → still over the ratio.
    expect(buildDisagreementObservations(USER)).toHaveLength(1);
  });

  it('leaves out plays of a parent pick (#217) — the parent chose the video', () => {
    declareInterest(INTEREST_ECON, 1);
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended' });
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, watchReason: 'dismissed' });
    }
    // The same plays, but on videos a parent sent: no disagreement to report.
    db.exec("UPDATE requests SET source = 'parent_pick'");
    expect(buildDisagreementObservations(USER)).toHaveLength(0);
  });

  it('ignores interests the user has not declared (no user_interests row)', () => {
    // Heavy skipping but never declared → not in the explicit profile, so no
    // disagreement (an inferred-but-unkept interest can't disagree).
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended' });
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, watchReason: 'dismissed' });
    }
    expect(buildDisagreementObservations(USER)).toHaveLength(0);
  });
});

describe('buildDepthObservations', () => {
  it('surfaces a depth/length pattern from an active affinity statement', () => {
    insertAffinity({ statement: 'Tends toward long-form technical explainers.', confidence: 0.8 });
    const obs = buildDepthObservations(USER);
    expect(obs).toHaveLength(1);
    expect(obs[0]?.type).toBe('depth');
    expect(obs[0]?.text).toBe('Tends toward long-form technical explainers.');
  });

  it('ignores affinity statements that describe topics rather than depth', () => {
    insertAffinity({ statement: 'Engages with robotics content from Person A.', confidence: 0.8 });
    expect(buildDepthObservations(USER)).toHaveLength(0);
  });

  it('ignores superseded affinity statements', () => {
    insertAffinity({ statement: 'Prefers in-depth deep dives.', confidence: 0.8, superseded: true });
    expect(buildDepthObservations(USER)).toHaveLength(0);
  });

  it('caps the number of depth observations', () => {
    insertAffinity({ statement: 'Prefers long-form videos.', confidence: 0.9 });
    insertAffinity({ statement: 'Tends toward in-depth explainers.', confidence: 0.8 });
    insertAffinity({ statement: 'Gravitates to detailed technical breakdowns.', confidence: 0.7 });
    expect(buildDepthObservations(USER).length).toBeLessThanOrEqual(2);
  });
});

describe('observational phrasing', () => {
  const EVALUATIVE = /\b(should|recommend|suggest|try|consider|reduce|increase|better|worse|good|bad)\b/i;

  it('disagreement copy carries no advice or evaluation', () => {
    declareInterest(INTEREST_ECON, 1);
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended' });
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, watchReason: 'dismissed' });
    }
    const obs = buildDisagreementObservations(USER);
    expect(obs[0]?.text).not.toMatch(EVALUATIVE);
  });

  it('drops a depth-matching affinity statement that carries advice', () => {
    insertAffinity({ statement: 'You should try more long-form explainers.', confidence: 0.9 });
    expect(buildDepthObservations(USER)).toHaveLength(0);
  });

  it('keeps a depth statement that only describes a pattern', () => {
    insertAffinity({ statement: 'Tends toward long-form technical explainers.', confidence: 0.9 });
    const obs = buildDepthObservations(USER);
    expect(obs).toHaveLength(1);
    expect(obs[0]?.text).not.toMatch(EVALUATIVE);
  });
});

describe('no profile mutation', () => {
  it('generating observations leaves user_interests, interests, and affinities untouched', () => {
    declareInterest(INTEREST_ECON, 1);
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended' });
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, watchReason: 'dismissed' });
    }
    insertAffinity({ statement: 'Tends toward long-form technical explainers.', confidence: 0.8 });

    const before = snapshotProfile();
    const obs = computeDriftObservations(USER);
    // Both observation types fired.
    expect(obs.some((o) => o.type === 'disagreement')).toBe(true);
    expect(obs.some((o) => o.type === 'depth')).toBe(true);

    const after = snapshotProfile();
    expect(after).toEqual(before);
  });

  it('generateDriftObservations persists to drift without mutating the profile', () => {
    // Seed interactions inside ISO week 2026-W15 (mid-week Wednesday).
    const inW15 = new Date(Date.UTC(2026, 3, 8, 12)).toISOString();
    declareInterest(INTEREST_ECON, 1);
    seedInterestInteraction({ interestId: INTEREST_ECON, videoId: 'e-w1', watchReason: 'ended', at: inW15 });
    for (let i = 0; i < 6; i++) {
      seedInterestInteraction({ interestId: INTEREST_ECON, videoId: `e-d${i}`, watchReason: 'dismissed', at: inW15 });
    }
    insertAffinity({ statement: 'Prefers long-form deep dives.', confidence: 0.8 });

    const before = snapshotProfile();
    const result = generateDriftObservations(USER, '2026-W15');
    expect(result.observationCount).toBe(2);
    expect(snapshotProfile()).toEqual(before);

    const stored = readDriftObservations(USER, '2026-W15');
    expect(stored.map((o) => o.type).sort()).toEqual(['depth', 'disagreement']);
  });
});

describe('persistDriftObservations', () => {
  it('preserves other keys already in the drift summary JSON', () => {
    db.prepare(`
      INSERT INTO drift (user_id, week, summary, calculated_at)
      VALUES (?, ?, ?, ?)
    `).run(USER, '2026-W20', JSON.stringify({ oneSentence: 'A prior summary.' }), nowIso());

    persistDriftObservations(USER, [{ type: 'depth', text: 'Prefers long-form videos.' }], '2026-W20');

    const row = db.prepare('SELECT summary FROM drift WHERE user_id = ? AND week = ?')
      .get(USER, '2026-W20') as { summary: string };
    const parsed = JSON.parse(row.summary) as { oneSentence?: string; observations?: unknown[] };
    expect(parsed.oneSentence).toBe('A prior summary.');
    expect(parsed.observations).toHaveLength(1);
  });

  it('upserts the observations on re-run for the same week', () => {
    persistDriftObservations(USER, [{ type: 'depth', text: 'First.' }], '2026-W21');
    persistDriftObservations(USER, [{ type: 'depth', text: 'Second.' }], '2026-W21');
    const stored = readDriftObservations(USER, '2026-W21');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe('Second.');
  });
});
