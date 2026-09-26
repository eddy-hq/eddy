import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Decisions (Phase 6a) on an in-memory DB with real migrations and the real
// requests state machine. Queues, notifications and person capture are
// mocked; nothing reaches Ollama. Fixtures are synthetic.

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

const { deleteQueueAdd, notify } = vi.hoisted(() => ({
  deleteQueueAdd: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../queue', () => ({
  redis: { get: vi.fn(), del: vi.fn(), set: vi.fn() },
  downloadQueue: { getJob: vi.fn(), add: vi.fn().mockResolvedValue(undefined) },
  deleteQueue: { add: deleteQueueAdd },
  guardQueue: { add: vi.fn() },
  discoveryQueue: {},
  thumbsQueue: {},
  decisionsQueue: {},
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify }),
  parseRelayPayload: vi.fn(),
}));

vi.mock('../people/registry', () => ({
  ensurePersonForChannel: vi.fn().mockReturnValue({ personId: 'person-1', created: false }),
  applyChannelInfoToPerson: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../watchdog', () => ({ checkStuckDownloads: vi.fn() }));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { DIMENSIONS, RUBRIC_VERSION } from '../guard';
import {
  countDecisionsWaiting,
  decisionsRouter,
  nudgeDay,
  readDecisionQueue,
  recordDecision,
  sendDecisionsNudge,
} from './index';
import { DAILY_CARD_CAP } from './util';

const KID_1 = '11111111-1111-7111-8111-111111111111';
const KID_2 = '22222222-2222-7222-8222-222222222222';
const PARENT = '33333333-3333-7333-8333-333333333333';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const app = express();
app.use(express.json());
app.use('/parent/decisions', decisionsRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VALIDATION_ERROR' ? 400 : err.code === 'FORBIDDEN' ? 403 : 500;
    res.status(status).json({ error: err.code });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

beforeAll(() => {
  runMigrations();
  const insertUser = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertUser.run(KID_1, 'Boy1', 'kid', 1, 2013, NOW.toISOString());
  insertUser.run(KID_2, 'Boy2', 'kid', 1, 2015, NOW.toISOString());
  insertUser.run(PARENT, 'Parent', 'parent', 0, null, NOW.toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM decision_nudges');
  db.exec('DELETE FROM guard_decisions');
  db.exec('DELETE FROM guard_spot_checks');
  db.exec('DELETE FROM guard_eval');
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM requests');
  deleteQueueAdd.mockReset().mockResolvedValue(undefined);
  notify.mockReset().mockResolvedValue(undefined);
});

function seedCandidate(id: string, opts: {
  userId?: string; status?: string; verdict?: string | null; createdAt?: string; yt?: string;
} = {}): void {
  const yt = opts.yt ?? id;
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, source_type, url, external_id, title, channel,
       status, guard_verdict, created_at, scored_at)
    VALUES (?, ?, 'topic_search', ?, ?, 'Placeholder title', 'Placeholder channel', ?, ?, ?, ?)
  `).run(
    id, opts.userId ?? KID_1, `https://www.youtube.com/watch?v=${yt}`, yt,
    opts.status ?? 'guard_pending', opts.verdict === undefined ? 'uncertain' : opts.verdict,
    opts.createdAt ?? daysAgo(1), opts.createdAt ?? daysAgo(1),
  );
}

function seedRequest(id: string, opts: {
  userId?: string; status?: string; verdict?: string; source?: string; requestedAt?: string; yt?: string;
} = {}): void {
  const yt = opts.yt ?? id;
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, title, channel, status, guard_verdict,
       file_path, requested_at)
    VALUES (?, ?, ?, ?, ?, 'Placeholder title', 'Placeholder channel', ?, ?, ?, ?)
  `).run(
    id, opts.userId ?? KID_1, opts.source ?? 'recommended', `https://www.youtube.com/watch?v=${yt}`, yt,
    opts.status ?? 'guard_pending', opts.verdict ?? 'uncertain', `/videos/${yt}.mp4`,
    opts.requestedAt ?? daysAgo(1),
  );
}

function seedEval(opts: {
  url: string; verdict: string; candidateId?: string | null; requestId?: string | null;
  userId?: string | null; scores?: boolean; at?: string;
}): string {
  const id = `eval-${Math.random().toString(36).slice(2)}`;
  const scores = opts.scores
    ? JSON.stringify({ dimensions: { language: 0, violence: 2, frightening: 1, sexual: 0, substances: 0, dangerous: 0, commercial: 1, attitude: 0 } })
    : null;
  db.prepare(`
    INSERT INTO guard_eval
      (eval_id, request_id, url, gemma_verdict, gemma_reason, prompt_version, request_type,
       rubric_scores_json, user_id, candidate_id, scored_at, created_at)
    VALUES (?, ?, ?, ?, 'Placeholder reason', 'candidate-v3', ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.requestId ?? null, opts.url, opts.verdict,
    opts.requestId ? 'video' : 'candidate', scores,
    opts.userId ?? null, opts.candidateId ?? null, opts.at ?? daysAgo(1), opts.at ?? daysAgo(1),
  );
  return id;
}

const status = (table: 'candidate_pool' | 'requests', id: string) => db.prepare(
  table === 'candidate_pool'
    ? 'SELECT status, guard_verdict FROM candidate_pool WHERE candidate_id = ?'
    : 'SELECT status, guard_verdict, decided_by FROM requests WHERE request_id = ?',
).get(id) as { status: string; guard_verdict: string | null; decided_by?: string };

const decisions = () => db.prepare('SELECT * FROM guard_decisions ORDER BY decided_at').all() as Array<Record<string, unknown>>;

const queue = (mode: 'today' | 'catch_up' = 'today', focus?: 'escalations' | 'spot_checks') =>
  readDecisionQueue({ mode, focus, now: NOW });

describe('parent-only access', () => {
  it('refuses a kid id with 403 and an unknown id with 404', async () => {
    expect((await supertest(app).get(`/parent/decisions/queue?userId=${KID_1}`)).status).toBe(403);
    expect((await supertest(app).get('/parent/decisions/queue?userId=00000000-0000-7000-8000-000000000000')).status).toBe(404);
    const res = await supertest(app).post('/parent/decisions').send({
      userId: KID_2, decisions: [{ subjectType: 'candidate', subjectId: 'x', verdict: 'clear_yes' }],
    });
    expect(res.status).toBe(403);
  });

  it('serves the queue to a parent', async () => {
    // The route reads the real clock.
    seedCandidate('c1', { createdAt: new Date().toISOString() });
    const res = await supertest(app).get(`/parent/decisions/queue?userId=${PARENT}`);
    expect(res.status).toBe(200);
    expect((res.body as { cards: unknown[] }).cards).toHaveLength(1);
  });

  it('rejects a malformed decision body', async () => {
    const res = await supertest(app).post('/parent/decisions').send({ userId: PARENT, decisions: [] });
    expect(res.status).toBe(400);
  });
});

describe('Escalations', () => {
  it('lists parked candidates and parked slate picks with the guard reason and scores', () => {
    seedCandidate('c1');
    seedEval({ url: 'https://www.youtube.com/watch?v=c1', verdict: 'uncertain', candidateId: 'c1', userId: KID_1, scores: true });
    seedRequest('r1');
    seedEval({ url: 'https://www.youtube.com/watch?v=r1', verdict: 'uncertain', requestId: 'r1', userId: KID_1 });

    const q = queue();
    expect(q.cards.map((c) => c.source)).toEqual(['escalation', 'escalation']);
    const c1 = q.cards.find((c) => c.youtubeId === 'c1')!;
    expect(c1.subjects[0]!.guard).toMatchObject({ verdict: 'uncertain', reason: 'Placeholder reason' });
    expect(c1.subjects[0]!.guard!.scores).toMatchObject({ violence: 2 });
    expect(c1.subjects[0]!.guard!.evalId).not.toBeNull();
    expect(c1.thumbnailUrl).toContain('c1');
  });

  it('leaves escalations older than 14 days to catch-up', () => {
    seedCandidate('recent', { createdAt: daysAgo(2) });
    seedCandidate('old', { createdAt: daysAgo(20) });
    expect(queue().cards.map((c) => c.youtubeId)).toEqual(['recent']);
    expect(queue('catch_up', 'escalations').cards.map((c) => c.youtubeId)).toEqual(['recent', 'old']);
    expect(queue().counts).toMatchObject({ escalations: 2, escalationsRecent: 1 });
  });

  it('groups a video parked for both kids into one card', () => {
    seedCandidate('c-k1', { userId: KID_1, yt: 'shared' });
    seedCandidate('c-k2', { userId: KID_2, yt: 'shared' });
    const [card] = queue().cards;
    expect(queue().cards).toHaveLength(1);
    expect(card!.subjects.map((s) => s.kidName).sort()).toEqual(['Boy1', 'Boy2']);
    expect(card!.subjects.find((s) => s.userId === KID_2)!.ageBand).toBe('10-12');
  });

  it('caps the daily queue at 15 cards', () => {
    for (let i = 0; i < 20; i++) seedCandidate(`c${String(i).padStart(2, '0')}`);
    expect(queue().cards).toHaveLength(DAILY_CARD_CAP);
    expect(queue('catch_up', 'escalations').cards).toHaveLength(20);
  });

  it('allowing a parked candidate makes it slate-eligible and records the label', async () => {
    seedCandidate('c1');
    const evalId = seedEval({ url: 'https://www.youtube.com/watch?v=c1', verdict: 'uncertain', candidateId: 'c1', userId: KID_1 });

    const out = await recordDecision(PARENT, { subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_yes' }, NOW);

    expect(out).toMatchObject({ source: 'escalation', effect: 'eligible', alreadyDecided: false });
    expect(status('candidate_pool', 'c1')).toEqual({ status: 'scored', guard_verdict: 'clear_yes' });
    expect(decisions()).toEqual([expect.objectContaining({
      subject_type: 'candidate', subject_id: 'c1', user_id: KID_1, source: 'escalation',
      human_verdict: 'clear_yes', guard_verdict: 'uncertain', age_band: '13-15',
      rubric_version: RUBRIC_VERSION, decided_by: PARENT, eval_id: evalId, youtube_id: 'c1',
    })]);
    const labelled = db.prepare('SELECT human_verdict, human_labelled_at FROM guard_eval WHERE eval_id = ?').get(evalId);
    expect(labelled).toEqual({ human_verdict: 'clear_yes', human_labelled_at: NOW.toISOString() });
    expect(queue().cards).toHaveLength(0);
  });

  it('does not label an older URL-only verdict row, which either kid could own', async () => {
    seedCandidate('c1');
    const evalId = seedEval({ url: 'https://www.youtube.com/watch?v=c1', verdict: 'uncertain' });
    const out = await recordDecision(PARENT, { subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_no' }, NOW);
    expect(out.guard.reason).toBe('Placeholder reason');
    expect(decisions()[0]).toMatchObject({ eval_id: null });
    expect(db.prepare('SELECT human_verdict FROM guard_eval WHERE eval_id = ?').get(evalId)).toEqual({ human_verdict: null });
  });

  it('blocking a parked candidate rejects it', async () => {
    seedCandidate('c1');
    const out = await recordDecision(PARENT, { subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_no' }, NOW);
    expect(out.effect).toBe('blocked');
    expect(status('candidate_pool', 'c1')).toEqual({ status: 'guard_rejected', guard_verdict: 'clear_no' });
  });

  it('allowing a parked slate pick shows it and notifies the kid', async () => {
    seedRequest('r1');
    const out = await recordDecision(PARENT, { subjectType: 'request', subjectId: 'r1', verdict: 'clear_yes' }, NOW);
    expect(out.effect).toBe('shown');
    expect(status('requests', 'r1')).toMatchObject({ status: 'ready', guard_verdict: 'uncertain', decided_by: PARENT });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('blocking a parked slate pick removes it and its file', async () => {
    seedRequest('r1');
    const out = await recordDecision(PARENT, { subjectType: 'request', subjectId: 'r1', verdict: 'clear_no' }, NOW);
    expect(out.effect).toBe('removed');
    expect(status('requests', 'r1').status).toBe('deleted');
    expect(deleteQueueAdd).toHaveBeenCalledWith('delete', { requestId: 'r1', filePath: '/videos/r1.mp4' }, expect.anything());
  });

  it('keeps a shared file when the other kid still has the video', async () => {
    seedRequest('r-k1', { userId: KID_1, yt: 'shared' });
    seedRequest('r-k2', { userId: KID_2, yt: 'shared', status: 'ready', verdict: 'clear_yes' });
    const out = await recordDecision(PARENT, { subjectType: 'request', subjectId: 'r-k1', verdict: 'clear_no' }, NOW);
    expect(out.effect).toBe('removed');
    expect(status('requests', 'r-k1').status).toBe('deleted');
    expect(status('requests', 'r-k2').status).toBe('ready');
    expect(deleteQueueAdd).not.toHaveBeenCalled();
  });

  it('removes a shared file once no live request is left on it', async () => {
    seedRequest('r-k1', { userId: KID_1, yt: 'shared' });
    seedRequest('r-k2', { userId: KID_2, yt: 'shared' });
    await recordDecision(PARENT, { subjectType: 'request', subjectId: 'r-k1', verdict: 'clear_no' }, NOW);
    await recordDecision(PARENT, { subjectType: 'request', subjectId: 'r-k2', verdict: 'clear_no' }, NOW);
    expect(deleteQueueAdd).toHaveBeenCalledTimes(1);
    expect(deleteQueueAdd).toHaveBeenCalledWith('delete', { requestId: 'r-k2', filePath: '/videos/shared.mp4' }, expect.anything());
  });

  it('records a second decision on the same subject once only', async () => {
    seedCandidate('c1');
    await recordDecision(PARENT, { subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_yes' }, NOW);
    const again = await recordDecision(PARENT, { subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_no' }, NOW);
    expect(again.alreadyDecided).toBe(true);
    expect(decisions()).toHaveLength(1);
    expect(status('candidate_pool', 'c1').status).toBe('scored');
  });
});

describe('Spot checks', () => {
  function seedRecentVerdicts(): void {
    for (let i = 0; i < 6; i++) seedCandidate(`yes${i}`, { status: 'scored', verdict: 'clear_yes', createdAt: daysAgo(2) });
    for (let i = 0; i < 3; i++) seedCandidate(`no${i}`, { status: 'guard_rejected', verdict: 'clear_no', createdAt: daysAgo(3) });
    seedCandidate('stale', { status: 'scored', verdict: 'clear_yes', createdAt: daysAgo(10) });
  }

  it('draws 4 clear-yes and 1 clear-no from the last 7 days, verdict hidden', () => {
    seedRecentVerdicts();
    const cards = queue().cards;
    expect(cards).toHaveLength(5);
    expect(cards.every((c) => c.source === 'spot_check')).toBe(true);
    expect(cards.every((c) => c.subjects.every((s) => s.guard === null))).toBe(true);
    const drawn = db.prepare('SELECT guard_verdict, COUNT(*) AS n FROM guard_spot_checks GROUP BY guard_verdict').all();
    expect(drawn).toEqual(expect.arrayContaining([
      { guard_verdict: 'clear_yes', n: 4 },
      { guard_verdict: 'clear_no', n: 1 },
    ]));
    expect(cards.map((c) => c.youtubeId)).not.toContain('stale');
  });

  it('keeps the same draw across reloads within the day', () => {
    seedRecentVerdicts();
    const first = queue().cards.map((c) => c.key);
    const second = queue().cards.map((c) => c.key);
    expect(second).toEqual(first);
    expect((db.prepare('SELECT COUNT(*) AS n FROM guard_spot_checks').get() as { n: number }).n).toBe(5);
  });

  it('keeps the spot checks inside the cap when escalations alone would fill it', () => {
    seedRecentVerdicts();
    for (let i = 0; i < 20; i++) seedCandidate(`parked${String(i).padStart(2, '0')}`);
    const cards = queue().cards;
    expect(cards).toHaveLength(DAILY_CARD_CAP);
    expect(cards.filter((c) => c.source === 'spot_check')).toHaveLength(5);
    expect(cards.slice(0, 10).every((c) => c.source === 'escalation')).toBe(true);
  });

  it('caps Today per day: decided escalations use up the allowance across reloads', async () => {
    seedRecentVerdicts();
    for (let i = 0; i < 20; i++) seedCandidate(`parked${String(i).padStart(2, '0')}`);
    for (const card of queue().cards.filter((c) => c.source === 'escalation').slice(0, 3)) {
      const s = card.subjects[0]!;
      await recordDecision(PARENT, { subjectType: s.subjectType, subjectId: s.subjectId, verdict: 'clear_yes' }, NOW);
    }
    expect(queue().cards.filter((c) => c.source === 'escalation')).toHaveLength(7);

    for (const card of queue().cards.filter((c) => c.source === 'escalation')) {
      const s = card.subjects[0]!;
      await recordDecision(PARENT, { subjectType: s.subjectType, subjectId: s.subjectId, verdict: 'clear_yes' }, NOW);
    }
    const after = queue().cards;
    expect(after.filter((c) => c.source === 'escalation')).toHaveLength(0);
    expect(after.filter((c) => c.source === 'spot_check')).toHaveLength(5);
    // The rest of the backlog is still there for catch-up.
    expect(queue('catch_up', 'escalations').cards).toHaveLength(10);
  });

  it('keeps the unfinished half of a two-kid card after the allowance is used', async () => {
    for (let i = 0; i < 14; i++) seedCandidate(`parked${String(i).padStart(2, '0')}`, { createdAt: daysAgo(2) });
    seedCandidate('both-k1', { userId: KID_1, yt: 'both', createdAt: daysAgo(3) });
    seedCandidate('both-k2', { userId: KID_2, yt: 'both', createdAt: daysAgo(3) });
    const first = queue().cards;
    expect(first).toHaveLength(DAILY_CARD_CAP);
    for (const card of first.filter((c) => c.youtubeId !== 'both')) {
      const s = card.subjects[0]!;
      await recordDecision(PARENT, { subjectType: s.subjectType, subjectId: s.subjectId, verdict: 'clear_yes' }, NOW);
    }
    await recordDecision(PARENT, { subjectType: 'candidate', subjectId: 'both-k1', verdict: 'clear_yes' }, NOW);

    const after = queue().cards;
    expect(after).toHaveLength(1);
    expect(after[0]!.subjects.map((s) => s.subjectId)).toEqual(['both-k2']);
  });

  it('puts escalations before spot checks', () => {
    seedRecentVerdicts();
    seedCandidate('parked');
    expect(queue().cards[0]!.source).toBe('escalation');
  });

  it('reveals the guard verdict in the decision outcome', async () => {
    seedRecentVerdicts();
    const card = queue().cards[0]!;
    const s = card.subjects[0]!;
    const out = await recordDecision(PARENT, { subjectType: s.subjectType, subjectId: s.subjectId, verdict: 'clear_yes' }, NOW);
    expect(out.source).toBe('spot_check');
    expect(['clear_yes', 'clear_no']).toContain(out.guard.verdict);
  });

  it('an approved clear-no candidate becomes eligible; a denied clear-yes one leaves the pool', async () => {
    seedCandidate('no1', { status: 'guard_rejected', verdict: 'clear_no' });
    seedCandidate('yes1', { status: 'scored', verdict: 'clear_yes' });
    queue();
    await recordDecision(PARENT, { subjectType: 'candidate', subjectId: 'no1', verdict: 'clear_yes' }, NOW);
    await recordDecision(PARENT, { subjectType: 'candidate', subjectId: 'yes1', verdict: 'clear_no' }, NOW);
    expect(status('candidate_pool', 'no1')).toEqual({ status: 'scored', guard_verdict: 'clear_yes' });
    expect(status('candidate_pool', 'yes1')).toEqual({ status: 'guard_rejected', guard_verdict: 'clear_no' });
    expect(decisions().map((d) => d['source'])).toEqual(['spot_check', 'spot_check']);
  });

  it('a denied clear-yes slate pick leaves the feed; a kid request records a label only', async () => {
    seedRequest('pick', { status: 'ready', verdict: 'clear_yes', source: 'recommended' });
    seedRequest('own', { status: 'ready', verdict: 'clear_yes', source: 'share_sheet' });
    queue();
    const pick = await recordDecision(PARENT, { subjectType: 'request', subjectId: 'pick', verdict: 'clear_no' }, NOW);
    const own = await recordDecision(PARENT, { subjectType: 'request', subjectId: 'own', verdict: 'clear_no' }, NOW);
    expect(pick.effect).toBe('removed');
    expect(status('requests', 'pick').status).toBe('deleted');
    expect(own.effect).toBe('label_only');
    expect(status('requests', 'own').status).toBe('ready');
    expect(decisions()).toHaveLength(2);
  });

  it('refuses a subject that is neither parked nor drawn', async () => {
    seedCandidate('free', { status: 'scored', verdict: 'clear_yes' });
    await expect(recordDecision(PARENT, { subjectType: 'candidate', subjectId: 'free', verdict: 'clear_yes' }, NOW))
      .rejects.toThrow(/not in the Decisions queue/);
    expect(decisions()).toHaveLength(0);
  });

  it('catch-up draws further batches from older history', async () => {
    for (let i = 0; i < 12; i++) seedCandidate(`old-yes${i}`, { status: 'scored', verdict: 'clear_yes', createdAt: daysAgo(60) });
    for (let i = 0; i < 3; i++) seedCandidate(`old-no${i}`, { status: 'guard_rejected', verdict: 'clear_no', createdAt: daysAgo(60) });
    expect(queue().cards).toHaveLength(0);

    const first = queue('catch_up', 'spot_checks').cards;
    expect(first).toHaveLength(10);
    expect(first.every((c) => c.source === 'catch_up')).toBe(true);
    for (const c of first) {
      const s = c.subjects[0]!;
      await recordDecision(PARENT, { subjectType: s.subjectType, subjectId: s.subjectId, verdict: 'clear_yes' }, NOW);
    }
    const second = queue('catch_up', 'spot_checks').cards;
    expect(second.length).toBe(5);
    expect(second.map((c) => c.key)).not.toEqual(expect.arrayContaining(first.map((c) => c.key)));
    expect(decisions().every((d) => d['source'] === 'catch_up')).toBe(true);
  });
});

describe('Spot checks on a request a parent later sent (#217)', () => {
  it('drops the drawn card and refuses a stale decision', async () => {
    seedRequest('picked', { status: 'watched', verdict: 'clear_yes', requestedAt: daysAgo(2) });
    const drawn = queue().cards.filter((c) => c.source === 'spot_check');
    expect(drawn.flatMap((c) => c.subjects.map((s) => s.subjectId))).toContain('picked');

    // The kid's copy was recycled, then a parent sent the video: the row is
    // now a parent pick.
    db.prepare(`UPDATE requests SET source = 'parent_pick', sent_by = ?, status = 'ready' WHERE request_id = 'picked'`)
      .run(PARENT);

    expect(queue().cards.flatMap((c) => c.subjects.map((s) => s.subjectId))).not.toContain('picked');
    await expect(recordDecision(PARENT, { subjectType: 'request', subjectId: 'picked', verdict: 'clear_yes' }, NOW))
      .rejects.toThrow(/not in the Decisions queue/);
    expect(decisions()).toEqual([]);
  });
});

describe('Block channel', () => {
  const BLOCKED_ID = 'UCblockedblockedblocked0';
  const OTHER_ID = 'UCotherotherotherother00';

  const setCandidateChannel = (id: string, channelId: string | null, channel = 'Placeholder channel') =>
    db.prepare('UPDATE candidate_pool SET channel_id = ?, channel = ? WHERE candidate_id = ?').run(channelId, channel, id);
  const setRequestChannel = (id: string, channelId: string | null, channel = 'Placeholder channel') =>
    db.prepare('UPDATE requests SET youtube_channel_id = ?, channel = ? WHERE request_id = ?').run(channelId, channel, id);

  const blockCard = (userId: string, subjects: Array<{ subjectType: string; subjectId: string }>) =>
    supertest(app).post('/parent/decisions/block-channel').send({ userId, subjects });

  // The blocked name would otherwise hide later tests' placeholder cards.
  afterEach(() => {
    db.exec('DELETE FROM blocked_channels');
  });

  it('refuses a kid with 403 and an unknown id with 404, and blocks nothing', async () => {
    seedCandidate('c1');
    setCandidateChannel('c1', BLOCKED_ID);
    expect((await blockCard(KID_1, [{ subjectType: 'candidate', subjectId: 'c1' }])).status).toBe(403);
    expect((await blockCard('00000000-0000-7000-8000-000000000000', [{ subjectType: 'candidate', subjectId: 'c1' }])).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM blocked_channels').get()).toEqual({ n: 0 });
    expect(status('candidate_pool', 'c1')).toMatchObject({ status: 'guard_pending' });
  });

  it('carries the channel id on each card', () => {
    seedCandidate('c1');
    setCandidateChannel('c1', BLOCKED_ID);
    seedRequest('r1');
    setRequestChannel('r1', OTHER_ID);
    const byVideo = new Map(queue().cards.map((c) => [c.youtubeId, c.channelId]));
    expect(byVideo.get('c1')).toBe(BLOCKED_ID);
    expect(byVideo.get('r1')).toBe(OTHER_ID);
  });

  it("blocks the card's video like Block, blocks the channel, and clears its other cards and pool rows", async () => {
    seedCandidate('card', { userId: KID_1 });
    setCandidateChannel('card', BLOCKED_ID);
    seedCandidate('same-channel-k2', { userId: KID_2 });
    setCandidateChannel('same-channel-k2', BLOCKED_ID);
    seedCandidate('same-channel-scored', { userId: KID_2, status: 'scored', verdict: 'clear_yes' });
    setCandidateChannel('same-channel-scored', BLOCKED_ID);
    seedRequest('same-channel-parked-pick');
    setRequestChannel('same-channel-parked-pick', BLOCKED_ID);
    seedCandidate('other', { userId: KID_1 });
    setCandidateChannel('other', OTHER_ID, 'Other placeholder channel');

    const res = await blockCard(PARENT, [{ subjectType: 'candidate', subjectId: 'card' }]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      channel: { channelId: BLOCKED_ID, displayName: 'Placeholder channel' },
      alreadyBlocked: false,
      poolRowsRemoved: 2,
      outcomes: [{ subjectId: 'card', effect: 'blocked' }],
    });
    // The card's own video: exactly what Block records.
    expect(status('candidate_pool', 'card')).toEqual({ status: 'guard_rejected', guard_verdict: 'clear_no' });
    expect(decisions()).toEqual([expect.objectContaining({
      subject_id: 'card', human_verdict: 'clear_no', decided_by: PARENT, source: 'escalation',
    })]);
    // The channel: blocked by this parent, other kids' queued rows out.
    expect(db.prepare('SELECT blocked_by FROM blocked_channels WHERE channel_id = ?').get(BLOCKED_ID)).toEqual({ blocked_by: PARENT });
    expect(status('candidate_pool', 'same-channel-k2')).toMatchObject({ status: 'guard_rejected' });
    expect(status('candidate_pool', 'same-channel-scored')).toMatchObject({ status: 'guard_rejected' });
    // Every other card from the channel has left the queue.
    expect(queue().cards.map((c) => c.youtubeId)).toEqual(['other']);
    expect(queue().counts.escalations).toBe(1);
  });

  it('refuses a card with no channel id and changes nothing', async () => {
    seedCandidate('c1');
    const res = await blockCard(PARENT, [{ subjectType: 'candidate', subjectId: 'c1' }]);
    expect(res.status).toBe(400);
    expect(decisions()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM blocked_channels').get()).toEqual({ n: 0 });
  });
});

describe('Reason chips', () => {
  const post = (decisions: Array<Record<string, unknown>>) =>
    supertest(app).post('/parent/decisions').send({ userId: PARENT, decisions });

  it('serves the rubric dimensions with the queue, in rubric order', () => {
    expect(queue().reasons).toEqual({
      dimensions: DIMENSIONS.map((d) => ({ key: d.key, label: d.label })),
      textMax: 280,
    });
  });

  it('records the chips and note with the decision', async () => {
    seedCandidate('c1');
    const res = await post([{
      subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_no',
      reasonDimensions: ['violence', 'frightening', 'violence'], reasonText: '  Too intense for this age  ',
    }]);
    expect(res.status).toBe(200);
    expect(decisions()).toEqual([expect.objectContaining({
      subject_id: 'c1', human_verdict: 'clear_no',
      reason_dimensions_json: JSON.stringify(['violence', 'frightening']),
      reason_text: 'Too intense for this age',
    })]);
  });

  it('records a note on its own, or chips on their own', async () => {
    seedCandidate('c1');
    seedCandidate('c2');
    await post([{ subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_yes', reasonText: 'Fine' }]);
    await post([{ subjectType: 'candidate', subjectId: 'c2', verdict: 'clear_no', reasonDimensions: ['commercial'] }]);
    const byId = new Map(decisions().map((d) => [d['subject_id'], d]));
    expect(byId.get('c1')).toMatchObject({ reason_dimensions_json: null, reason_text: 'Fine' });
    expect(byId.get('c2')).toMatchObject({ reason_dimensions_json: '["commercial"]', reason_text: null });
  });

  it('a bare decision still works and stores no reason', async () => {
    seedCandidate('c1');
    const res = await post([{ subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_yes' }]);
    expect(res.status).toBe(200);
    expect(decisions()).toEqual([expect.objectContaining({
      subject_id: 'c1', reason_dimensions_json: null, reason_text: null,
    })]);
  });

  it('treats an empty chip list and a blank note as no reason', async () => {
    seedCandidate('c1');
    await post([{ subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_yes', reasonDimensions: [], reasonText: '   ' }]);
    expect(decisions()).toEqual([expect.objectContaining({ reason_dimensions_json: null, reason_text: null })]);
  });

  it('refuses a dimension that is not in the rubric, and records nothing', async () => {
    seedCandidate('c1');
    for (const key of ['gore', 'self_harm', 'adult_game']) {
      const res = await post([{ subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_no', reasonDimensions: ['violence', key] }]);
      expect(res.status).toBe(400);
    }
    expect(decisions()).toEqual([]);
    expect(status('candidate_pool', 'c1')).toMatchObject({ status: 'guard_pending' });
  });

  it('refuses a note over 280 characters', async () => {
    seedCandidate('c1');
    const res = await post([{ subjectType: 'candidate', subjectId: 'c1', verdict: 'clear_no', reasonText: 'x'.repeat(281) }]);
    expect(res.status).toBe(400);
    expect(decisions()).toEqual([]);
  });

  it('records the same reason for each kid on a "same for both" card', async () => {
    seedCandidate('both-k1', { userId: KID_1, yt: 'both' });
    seedCandidate('both-k2', { userId: KID_2, yt: 'both' });
    const reason = { reasonDimensions: ['language'], reasonText: 'Swearing' };
    await post([
      { subjectType: 'candidate', subjectId: 'both-k1', verdict: 'clear_no', ...reason },
      { subjectType: 'candidate', subjectId: 'both-k2', verdict: 'clear_no', ...reason },
    ]);
    expect(decisions().map((d) => [d['reason_dimensions_json'], d['reason_text']])).toEqual([
      ['["language"]', 'Swearing'],
      ['["language"]', 'Swearing'],
    ]);
  });

  it('records a Spot check reason with the source it was drawn under', async () => {
    seedCandidate('sc', { status: 'scored', verdict: 'clear_yes', createdAt: daysAgo(2) });
    const card = queue().cards.find((c) => c.source === 'spot_check')!;
    await post([{ ...card.subjects.map((x) => ({ subjectType: x.subjectType, subjectId: x.subjectId }))[0]!, verdict: 'clear_no', reasonDimensions: ['dangerous'] }]);
    expect(decisions()).toEqual([expect.objectContaining({
      source: 'spot_check', reason_dimensions_json: '["dangerous"]',
    })]);
  });

  describe('on Block channel', () => {
    afterEach(() => {
      db.exec('DELETE FROM blocked_channels');
    });

    it("records the card's reason on each kid's Block", async () => {
      seedCandidate('bc-k1', { userId: KID_1, yt: 'bc' });
      seedCandidate('bc-k2', { userId: KID_2, yt: 'bc' });
      db.prepare("UPDATE candidate_pool SET channel_id = 'UCreasonreasonreason000' WHERE candidate_id LIKE 'bc-%'").run();
      const res = await supertest(app).post('/parent/decisions/block-channel').send({
        userId: PARENT,
        subjects: [{ subjectType: 'candidate', subjectId: 'bc-k1' }, { subjectType: 'candidate', subjectId: 'bc-k2' }],
        reasonDimensions: ['attitude'],
        reasonText: 'Not for us',
      });
      expect(res.status).toBe(200);
      expect(decisions().map((d) => [d['subject_id'], d['human_verdict'], d['reason_dimensions_json'], d['reason_text']])).toEqual([
        ['bc-k1', 'clear_no', '["attitude"]', 'Not for us'],
        ['bc-k2', 'clear_no', '["attitude"]', 'Not for us'],
      ]);
    });

    it('refuses an unknown dimension and blocks nothing', async () => {
      seedCandidate('bc');
      db.prepare("UPDATE candidate_pool SET channel_id = 'UCreasonreasonreason000' WHERE candidate_id = 'bc'").run();
      const res = await supertest(app).post('/parent/decisions/block-channel').send({
        userId: PARENT, subjects: [{ subjectType: 'candidate', subjectId: 'bc' }], reasonDimensions: ['nope'],
      });
      expect(res.status).toBe(400);
      expect(decisions()).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM blocked_channels').get()).toEqual({ n: 0 });
    });
  });
});

describe('Daily nudge', () => {
  // 18:00 UTC is 19:00 in London in September (BST).
  const EVENING = new Date('2026-09-25T18:00:00.000Z');
  const TZ = 'Europe/London';
  const PARENT_2 = '44444444-4444-7444-8444-444444444444';

  beforeAll(() => {
    db.prepare(
      'INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(PARENT_2, 'Parent2', 'parent', 0, null, NOW.toISOString());
  });

  it("counts exactly the cards in Today's queue", () => {
    seedCandidate('e1');
    seedCandidate('both-k1', { userId: KID_1, yt: 'both' });
    seedCandidate('both-k2', { userId: KID_2, yt: 'both' });
    seedCandidate('sc', { status: 'scored', verdict: 'clear_yes', createdAt: daysAgo(2) });
    const today = readDecisionQueue({ mode: 'today', now: EVENING }).cards;
    // Two escalation cards (one for both kids) and one spot check.
    expect(today).toHaveLength(3);
    expect(countDecisionsWaiting(EVENING)).toBe(today.length);
  });

  it('notifies each parent once with the count when decisions wait', async () => {
    seedCandidate('e1');
    seedCandidate('e2');
    const result = await sendDecisionsNudge(EVENING, TZ);
    expect(result).toEqual({ count: 2, notified: [PARENT, PARENT_2] });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith({ kind: 'decisions_waiting', count: 2 }, PARENT);
    expect(notify).toHaveBeenCalledWith({ kind: 'decisions_waiting', count: 2 }, PARENT_2);
    // Never a kid.
    expect(notify.mock.calls.map((c) => c[1])).not.toContain(KID_1);
  });

  it('carries a count only: no titles, channels or kid names', async () => {
    seedCandidate('e1');
    await sendDecisionsNudge(EVENING, TZ);
    for (const [event] of notify.mock.calls) {
      expect(Object.keys(event as object).sort()).toEqual(['count', 'kind']);
    }
  });

  it('sends nothing when the queue is empty', async () => {
    const result = await sendDecisionsNudge(EVENING, TZ);
    expect(result).toEqual({ count: 0, notified: [] });
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends at most once a day, and again the next day', async () => {
    seedCandidate('e1');
    await sendDecisionsNudge(EVENING, TZ);
    // A second firing the same evening (a restart, a changed schedule).
    const again = await sendDecisionsNudge(new Date('2026-09-25T20:30:00.000Z'), TZ);
    expect(again.notified).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(2);

    const nextDay = await sendDecisionsNudge(new Date('2026-09-26T18:00:00.000Z'), TZ);
    expect(nextDay.notified).toEqual([PARENT, PARENT_2]);
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it("keys the day in the nudge's time zone, not UTC", () => {
    // 23:30 UTC on the 25th is 00:30 on the 26th in London.
    expect(nudgeDay(new Date('2026-09-25T23:30:00.000Z'), TZ)).toBe('2026-09-26');
    expect(nudgeDay(new Date('2026-09-25T23:30:00.000Z'), 'UTC')).toBe('2026-09-25');
  });
});
