import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'gemma4:e4b' },
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
  discoveryQueue: { add: vi.fn() },
  guardQueue: {},
  downloadQueue: {},
  thumbsQueue: {},
  deleteQueue: {},
}));

vi.mock('../../ytdlp', () => ({
  searchVideosWithDates: vi.fn(),
  flatPlaylistChannel: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { surfaceForToday, readScoredCandidatesByBucket } from './surface';

// Role-blind default cap (ADR-0009). surfaceForToday now takes the per-user
// cap as a third argument; tests pass it explicitly.
const CAP = 15;

const KID_USER_ID = '11111111-1111-7111-8111-111111111111';
const ADULT_USER_ID = '22222222-2222-7222-8222-222222222222';
const INTEREST_ID = '33333333-3333-7333-8333-333333333333';
const INTEREST_ID_2 = '44444444-4444-7444-8444-444444444444';
const INTEREST_ID_3 = '55555555-5555-7555-8555-555555555555';
const INTEREST_ID_4 = '66666666-6666-7666-8666-666666666666';
const INTEREST_ID_5 = '77777777-7777-7777-8777-777777777777';
const INTEREST_ID_6 = '88888888-8888-7888-8888-888888888888';

interface CandidateOpts {
  candidateId: string;
  userId?: string;
  status?: string;
  guardVerdict?: string | null;
  title?: string | null;
  publishedAt?: string | null;
  connectionScore?: number | null;
  qualityScore?: number | null;
  timeSensitivity?: string | null;
  sourceType?: string;
  gemmaScore?: number | null;
  interestId?: string | null;
  surfacedDate?: string | null;
  externalId?: string;
  createdAt?: string;
  whyText?: string | null;
}

function insertCandidate(opts: CandidateOpts): void {
  const userId = opts.userId ?? KID_USER_ID;
  const externalId = opts.externalId ?? opts.candidateId;
  const createdAt = opts.createdAt ?? new Date().toISOString();
  // Default why_text to a non-null sentinel — brief §9a requires it,
  // and the surface query enforces `why_text IS NOT NULL`. Tests that
  // care about the null path opt in explicitly via whyText: null.
  const whyText = opts.whyText === undefined ? 'Because it matches your interests.' : opts.whyText;
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type,
       interest_id, url, external_id, title,
       connection_score, quality_score, time_sensitivity, gemma_score,
       published_at, guard_verdict, status, surfaced_date, created_at,
       why_text)
    VALUES (?, ?, 'video', ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?)
  `).run(
    opts.candidateId,
    userId,
    opts.sourceType ?? 'interest_search',
    opts.interestId ?? null,
    `https://www.youtube.com/watch?v=${opts.candidateId}`,
    externalId,
    opts.title ?? `Title for ${opts.candidateId}`,
    opts.connectionScore ?? 8,
    opts.qualityScore ?? 8,
    opts.timeSensitivity ?? 'evergreen',
    opts.gemmaScore ?? null,
    opts.publishedAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    opts.guardVerdict ?? null,
    opts.status ?? 'scored',
    opts.surfacedDate ?? null,
    createdAt,
    whyText,
  );
}

function insertRequest(userId: string, youtubeId: string): void {
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, status, requested_at)
    VALUES (?, ?, 'search', ?, ?, 'pending', ?)
  `).run(
    `req-${youtubeId}`,
    userId,
    `https://www.youtube.com/watch?v=${youtubeId}`,
    youtubeId,
    new Date().toISOString(),
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(KID_USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(ADULT_USER_ID, 'Parent1', 'parent', 18, new Date().toISOString());

  const insertInterest = db.prepare(`
    INSERT INTO interests (id, label, search_terms, category, source)
    VALUES (?, ?, '["x"]', 'tech', 'seed')
  `);
  insertInterest.run(INTEREST_ID, 'functional programming');
  insertInterest.run(INTEREST_ID_2, 'submarines');
  insertInterest.run(INTEREST_ID_3, 'crystallography');
  insertInterest.run(INTEREST_ID_4, 'origami');
  insertInterest.run(INTEREST_ID_5, 'pottery');
  insertInterest.run(INTEREST_ID_6, 'gardening');

  const insertUserInterest = db.prepare(`
    INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
    VALUES (?, ?, ?, 'comfortable', 1, ?)
  `);
  const now = new Date().toISOString();
  // Kid: ranks 1..6. The cap-blocked / per-interest-cap tests want rank 1
  // (top interest), the "stretch only" tests want rank > 3.
  insertUserInterest.run(KID_USER_ID, INTEREST_ID, 1, now);
  insertUserInterest.run(KID_USER_ID, INTEREST_ID_2, 2, now);
  insertUserInterest.run(KID_USER_ID, INTEREST_ID_3, 3, now);
  insertUserInterest.run(KID_USER_ID, INTEREST_ID_4, 4, now);
  insertUserInterest.run(KID_USER_ID, INTEREST_ID_5, 5, now);
  insertUserInterest.run(KID_USER_ID, INTEREST_ID_6, 6, now);
  insertUserInterest.run(ADULT_USER_ID, INTEREST_ID, 1, now);
  insertUserInterest.run(ADULT_USER_ID, INTEREST_ID_2, 2, now);
});

beforeEach(() => {
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM requests');
});

describe('surfaceForToday — kid-safety filter (eligibleGuard)', () => {
  it('excludes kid candidates with guard_verdict = clear_no', () => {
    insertCandidate({ candidateId: 'cand-no', guardVerdict: 'clear_no' });
    insertCandidate({ candidateId: 'cand-yes', guardVerdict: 'clear_yes' });

    const verdicts = surfaceForToday(KID_USER_ID, true, CAP);

    const ids = verdicts.map((v) => v.candidate.candidateId);
    expect(ids).not.toContain('cand-no');
    expect(ids).toContain('cand-yes');
  });

  it('excludes kid candidates with guard_verdict = uncertain', () => {
    insertCandidate({ candidateId: 'cand-uncertain', guardVerdict: 'uncertain' });
    insertCandidate({ candidateId: 'cand-yes', guardVerdict: 'clear_yes' });

    const verdicts = surfaceForToday(KID_USER_ID, true, CAP);

    const ids = verdicts.map((v) => v.candidate.candidateId);
    expect(ids).not.toContain('cand-uncertain');
    expect(ids).toContain('cand-yes');
  });

  it('admits ONLY clear_yes for kids — NULL (un-rechecked) is excluded (ADR-0009 kid safety)', () => {
    // Now that follows route through the pool, a NULL guard_verdict means the
    // candidate was never guard-rechecked. Admitting it would surface an
    // un-guarded followed upload to a kid — the bypass this issue closes.
    // Default to escalation: only an explicit clear_yes surfaces.
    insertCandidate({ candidateId: 'cand-null', guardVerdict: null });
    insertCandidate({ candidateId: 'cand-yes', guardVerdict: 'clear_yes' });
    insertCandidate({ candidateId: 'cand-no', guardVerdict: 'clear_no' });
    insertCandidate({ candidateId: 'cand-unc', guardVerdict: 'uncertain' });

    const verdicts = surfaceForToday(KID_USER_ID, true, CAP);
    const ids = verdicts.map((v) => v.candidate.candidateId);

    expect(ids).toEqual(['cand-yes']);
    expect(ids).not.toContain('cand-null');
    expect(ids).not.toContain('cand-no');
    expect(ids).not.toContain('cand-unc');
  });

  it('admits every guard verdict for a non-kid user (eligibleGuard is empty)', () => {
    insertCandidate({ candidateId: 'a-null', userId: ADULT_USER_ID, guardVerdict: null });
    insertCandidate({ candidateId: 'a-yes', userId: ADULT_USER_ID, guardVerdict: 'clear_yes' });
    insertCandidate({ candidateId: 'a-no', userId: ADULT_USER_ID, guardVerdict: 'clear_no' });
    insertCandidate({ candidateId: 'a-unc', userId: ADULT_USER_ID, guardVerdict: 'uncertain' });

    const verdicts = surfaceForToday(ADULT_USER_ID, false, CAP);
    const ids = verdicts.map((v) => v.candidate.candidateId).sort();

    expect(ids).toEqual(['a-no', 'a-null', 'a-unc', 'a-yes']);
  });
});

describe('surfaceForToday — per-day cap', () => {
  it('returns [] and writes nothing when the cap is already filled today', () => {
    for (let i = 0; i < 5; i++) {
      insertCandidate({
        candidateId: `already-${i}`,
        guardVerdict: 'clear_yes',
        status: 'surfaced',
        surfacedDate: todayIso(),
      });
    }
    // A fresh candidate that *would* be eligible if the cap weren't full.
    insertCandidate({ candidateId: 'fresh', guardVerdict: 'clear_yes' });

    // cap=5, already 5 surfaced → nothing more surfaces.
    const verdicts = surfaceForToday(KID_USER_ID, true, 5);

    expect(verdicts).toEqual([]);
    const fresh = db.prepare(
      'SELECT status, surfaced_date FROM candidate_pool WHERE candidate_id = ?',
    ).get('fresh') as { status: string; surfaced_date: string | null };
    expect(fresh.status).toBe('scored');
    expect(fresh.surfaced_date).toBeNull();
  });

  it('the delighter bucket caps fresh interest-search picks at its quota of 2', () => {
    // All candidates here are interest_search (delighter bucket, quota 2).
    // Five fresh delighters on distinct interests + channels → exactly 2 are
    // surfaced; the rest are cut for bucket quota. This is the floor-as-ceiling
    // behaviour (ADR-0009), not a per-interest cap.
    for (let i = 1; i <= 5; i++) {
      insertCandidate({
        candidateId: `fresh-${i}`,
        guardVerdict: 'clear_yes',
        title: `${['Aardvark', 'Bagpipe', 'Crystal', 'Dolphin', 'Echo'][i - 1]} explainer ${i}`,
        interestId: [INTEREST_ID, INTEREST_ID_2, INTEREST_ID_3, INTEREST_ID_4, INTEREST_ID_5][i - 1],
        connectionScore: 9, qualityScore: 9,
      });
    }

    surfaceForToday(KID_USER_ID, true, CAP);

    const surfacedToday = db.prepare(
      "SELECT candidate_id FROM candidate_pool WHERE surfaced_date = ? AND status = 'surfaced'",
    ).all(todayIso()) as Array<{ candidate_id: string }>;
    // Delighter quota is 2 — only two surface even with cap 15, because there
    // is no subscription / back-catalogue supply to fill the rest of the slate.
    expect(surfacedToday).toHaveLength(2);
  });

  it('a prefilled delighter bucket leaves room for the remainder of the quota', () => {
    // One delighter already surfaced today (interest_search) → delighter
    // bucket prefilled at 1, quota 2, so exactly one more fresh delighter fits.
    insertCandidate({
      candidateId: 'already-delighter',
      guardVerdict: 'clear_yes',
      status: 'surfaced',
      surfacedDate: todayIso(),
      title: 'Already surfaced delighter',
      interestId: INTEREST_ID,
    });
    insertCandidate({
      candidateId: 'fresh-1', guardVerdict: 'clear_yes',
      title: 'Bagpipe maintenance guide', interestId: INTEREST_ID_2,
      connectionScore: 9, qualityScore: 9,
    });
    insertCandidate({
      candidateId: 'fresh-2', guardVerdict: 'clear_yes',
      title: 'Crystallography for amateurs', interestId: INTEREST_ID_3,
      connectionScore: 9, qualityScore: 9,
    });

    surfaceForToday(KID_USER_ID, true, CAP);

    const freshSurfaced = db.prepare(
      "SELECT candidate_id FROM candidate_pool WHERE surfaced_date = ? AND status = 'surfaced' AND candidate_id LIKE 'fresh-%'",
    ).all(todayIso()) as Array<{ candidate_id: string }>;
    expect(freshSurfaced).toHaveLength(1);
  });
});

describe('surfaceForToday — mid-day re-run carry-over', () => {
  it('dedups against an already-surfaced similar title from earlier today', () => {
    // Earlier today: a kid had one item surfaced (interest_id left null
    // so the per-interest cap on fresh items below isn't pre-consumed).
    insertCandidate({
      candidateId: 'earlier',
      guardVerdict: 'clear_yes',
      status: 'surfaced',
      surfacedDate: todayIso(),
      title: 'Beginner monad tutorial walkthrough',
      interestId: null,
    });
    // Now: an eligible candidate with a near-duplicate title. The ranker
    // dedup (Jaccard ≥ 0.4 on shared tokens) should refuse it.
    insertCandidate({
      candidateId: 'near-dup',
      guardVerdict: 'clear_yes',
      title: 'Beginner monad tutorial walkthrough revisited',
      interestId: INTEREST_ID,
    });
    // And one with a totally different title (different interest so the
    // per-interest cap doesn't bite), which should be picked.
    insertCandidate({
      candidateId: 'distinct',
      guardVerdict: 'clear_yes',
      title: 'Submarine sonar history overview',
      interestId: INTEREST_ID_2,
    });

    surfaceForToday(KID_USER_ID, true, CAP);

    const nearDup = db.prepare(
      'SELECT status FROM candidate_pool WHERE candidate_id = ?',
    ).get('near-dup') as { status: string };
    const distinct = db.prepare(
      'SELECT status FROM candidate_pool WHERE candidate_id = ?',
    ).get('distinct') as { status: string };

    // The near-dup candidate was not picked (still 'scored'); the
    // unrelated title was, proving prefilledTitles was passed into rank.
    expect(nearDup.status).toBe('scored');
    expect(distinct.status).toBe('surfaced');
  });

  it("writes status='surfaced' only for picked verdicts; floor + quota losers stay 'scored'", () => {
    // pickable: high-scoring delighter — wins one of the two delighter slots.
    insertCandidate({
      candidateId: 'pickable',
      guardVerdict: 'clear_yes',
      title: 'Alpha pickable item',
      connectionScore: 10, qualityScore: 10,
      interestId: INTEREST_ID_2,
    });
    // low-qual: hits the hard quality floor (< MIN_QUALITY_SCORE = 5).
    insertCandidate({
      candidateId: 'low-qual',
      guardVerdict: 'clear_yes',
      title: 'Bravo too low quality',
      connectionScore: 9, qualityScore: 2,
      interestId: INTEREST_ID_3,
    });
    // Pre-surface one delighter today so the delighter bucket (quota 2) has
    // exactly one slot left — `pickable` (highest weight) takes it, and the
    // lower-weighted quota-blocked candidate below can't fit.
    insertCandidate({
      candidateId: 'already-1',
      guardVerdict: 'clear_yes',
      status: 'surfaced',
      surfacedDate: todayIso(),
      title: 'Charlie filler one',
      interestId: INTEREST_ID,
    });
    // quota-blocked: a fresh delighter that loses the last delighter slot to
    // `pickable` (lower weighted score) — cut for bucket quota, stays 'scored'.
    insertCandidate({
      candidateId: 'cap-blocked',
      guardVerdict: 'clear_yes',
      title: 'Delta quota-blocked candidate',
      interestId: INTEREST_ID_5,
      connectionScore: 8, qualityScore: 8,
    });

    surfaceForToday(KID_USER_ID, true, CAP);

    const rows = db.prepare(
      'SELECT candidate_id, status, surfaced_date, surfaced_at FROM candidate_pool ORDER BY candidate_id',
    ).all() as Array<{ candidate_id: string; status: string; surfaced_date: string | null; surfaced_at: string | null }>;

    const byId = new Map(rows.map((r) => [r.candidate_id, r]));

    const pickable = byId.get('pickable');
    expect(pickable?.status).toBe('surfaced');
    expect(pickable?.surfaced_date).toBe(todayIso());
    expect(pickable?.surfaced_at).not.toBeNull();

    const lowQual = byId.get('low-qual');
    expect(lowQual?.status).toBe('scored');
    expect(lowQual?.surfaced_date).toBeNull();
    expect(lowQual?.surfaced_at).toBeNull();

    const capped = byId.get('cap-blocked');
    expect(capped?.status).toBe('scored');
    expect(capped?.surfaced_date).toBeNull();
    expect(capped?.surfaced_at).toBeNull();
  });
});

describe('surfaceForToday — why_text required (brief §9a)', () => {
  it('excludes candidates with why_text = NULL', () => {
    insertCandidate({ candidateId: 'cand-no-why', guardVerdict: 'clear_yes', whyText: null });
    insertCandidate({ candidateId: 'cand-with-why', guardVerdict: 'clear_yes' });

    const verdicts = surfaceForToday(KID_USER_ID, true, CAP);

    const ids = verdicts.map((v) => v.candidate.candidateId);
    expect(ids).not.toContain('cand-no-why');
    expect(ids).toContain('cand-with-why');

    // The null-why candidate stays 'scored' (never surfaced).
    const row = db.prepare(
      "SELECT status, surfaced_date FROM candidate_pool WHERE candidate_id = ?",
    ).get('cand-no-why') as { status: string; surfaced_date: string | null };
    expect(row.status).toBe('scored');
    expect(row.surfaced_date).toBeNull();
  });

  it('excludes null-why candidates for adults too (filter is not kid-only)', () => {
    insertCandidate({ candidateId: 'a-no-why', userId: ADULT_USER_ID, guardVerdict: 'clear_yes', whyText: null });
    insertCandidate({ candidateId: 'a-with-why', userId: ADULT_USER_ID, guardVerdict: 'clear_yes' });

    const verdicts = surfaceForToday(ADULT_USER_ID, false, CAP);
    const ids = verdicts.map((v) => v.candidate.candidateId);

    expect(ids).not.toContain('a-no-why');
    expect(ids).toContain('a-with-why');
  });
});

describe('surfaceForToday — already-requested exclusion', () => {
  it("excludes a candidate whose external_id matches a row in requests for the same user", () => {
    insertCandidate({ candidateId: 'requested', guardVerdict: 'clear_yes', externalId: 'yt-aaa' });
    insertCandidate({ candidateId: 'fresh', guardVerdict: 'clear_yes', externalId: 'yt-bbb' });
    insertRequest(KID_USER_ID, 'yt-aaa');

    const verdicts = surfaceForToday(KID_USER_ID, true, CAP);
    const ids = verdicts.map((v) => v.candidate.candidateId);

    expect(ids).not.toContain('requested');
    expect(ids).toContain('fresh');
  });

  it("only excludes when the request belongs to the same user", () => {
    insertCandidate({ candidateId: 'mine', guardVerdict: 'clear_yes', externalId: 'yt-shared' });
    // A different user already requested the same youtube_id — should not
    // exclude it from this user's surface.
    insertRequest(ADULT_USER_ID, 'yt-shared');

    const verdicts = surfaceForToday(KID_USER_ID, true, CAP);
    const ids = verdicts.map((v) => v.candidate.candidateId);

    expect(ids).toContain('mine');
  });
});

describe('readScoredCandidatesByBucket — kid guard recheck covers every bucket', () => {
  it('rechecks each bucket\'s top-N, not the top-N overall (flood-day floor protection)', () => {
    // Flood day: 10 subscriptions with the highest raw gemma_score, plus a few
    // back-catalogue and delighter rows scoring lower. A flat top-N=3 by
    // gemma_score would only return subscriptions, leaving the reserved
    // back-catalogue / delighter floors un-rechecked (and so un-surfaceable
    // for a kid). Per-bucket recheck must reach all three buckets.
    for (let i = 0; i < 10; i++) {
      insertCandidate({
        candidateId: `sub-${i}`, sourceType: 'subscription',
        gemmaScore: 100 - i, // highest raw scores
      });
    }
    insertCandidate({ candidateId: 'bc-1', sourceType: 'person_backcatalog', gemmaScore: 20 });
    insertCandidate({ candidateId: 'bc-2', sourceType: 'person_backcatalog', gemmaScore: 19 });
    insertCandidate({ candidateId: 'dl-1', sourceType: 'interest_search', gemmaScore: 10 });
    insertCandidate({ candidateId: 'dl-2', sourceType: 'interest_search', gemmaScore: 9 });

    // perBucketLimit = 2 → top 2 from each bucket.
    const rows = readScoredCandidatesByBucket(KID_USER_ID, 2);
    const ids = rows.map((r) => r.candidate_id).sort();

    // Two subscriptions (the very top), both back-cat, both delighter — the
    // lower-raw-score floors are reached despite the subscription flood.
    expect(ids).toEqual(['bc-1', 'bc-2', 'dl-1', 'dl-2', 'sub-0', 'sub-1'].sort());
  });

  it('treats any non-subscription / non-backcatalog source_type as the delighter bucket', () => {
    insertCandidate({ candidateId: 'is-1', sourceType: 'interest_search', gemmaScore: 30 });
    insertCandidate({ candidateId: 'other-1', sourceType: 'person_recommendation', gemmaScore: 29 });

    const rows = readScoredCandidatesByBucket(KID_USER_ID, 1);
    // Both map to the delighter bucket, so top-1 returns only the higher-scored.
    expect(rows.map((r) => r.candidate_id)).toEqual(['is-1']);
  });

  it('excludes already-guarded rows so they cannot consume the recheck window', () => {
    // A high-raw-score subscription already cleared by an earlier run, plus a
    // newer un-guarded subscription. With perBucketLimit=1, returning the
    // already-cleared row would starve the NULL one (which kid surfacing now
    // needs guarded). The recheck must skip non-NULL verdicts.
    insertCandidate({ candidateId: 'sub-cleared', sourceType: 'subscription', gemmaScore: 100, guardVerdict: 'clear_yes' });
    insertCandidate({ candidateId: 'sub-needs-guard', sourceType: 'subscription', gemmaScore: 50, guardVerdict: null });

    const rows = readScoredCandidatesByBucket(KID_USER_ID, 1);
    expect(rows.map((r) => r.candidate_id)).toEqual(['sub-needs-guard']);
  });
});
