import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { RUBRIC_VERSION } from '../guard';
import { decisionsRouter, readDecisionQueue, recordDecision } from './index';
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
  userId?: string; status?: string; verdict?: string; source?: string; requestedAt?: string;
} = {}): void {
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, title, channel, status, guard_verdict,
       file_path, requested_at)
    VALUES (?, ?, ?, ?, ?, 'Placeholder title', 'Placeholder channel', ?, ?, ?, ?)
  `).run(
    id, opts.userId ?? KID_1, opts.source ?? 'recommended', `https://www.youtube.com/watch?v=${id}`, id,
    opts.status ?? 'guard_pending', opts.verdict ?? 'uncertain', `/videos/${id}.mp4`,
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
