import express, { type Request as ExpressRequest } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Download-time second pass on slate picks (Phase 6a), end to end on the M4
// side: the worker's signed /guard/score and /downloaded callbacks, the
// second-pass job the guard queue runs, and what the kid's feed shows after.
// Real state machine and migrations on an in-memory DB; Ollama, the queues,
// notifications and person capture are mocked. Nothing here reaches yt-dlp,
// the Data API or a live model.

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
  config: {
    INTERNAL_HMAC_SECRET: 'test-secret',
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
  },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

const { guardQueueAdd, notify, ensurePersonForChannel } = vi.hoisted(() => ({
  guardQueueAdd: vi.fn(),
  notify: vi.fn(),
  ensurePersonForChannel: vi.fn(),
}));

vi.mock('../../queue', () => ({
  redis: { get: vi.fn(), del: vi.fn(), set: vi.fn() },
  downloadQueue: { getJob: vi.fn(), add: vi.fn().mockResolvedValue(undefined) },
  deleteQueue: { add: vi.fn().mockResolvedValue(undefined) },
  guardQueue: { add: guardQueueAdd },
  discoveryQueue: {},
  thumbsQueue: {},
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify }),
  parseRelayPayload: vi.fn(),
}));

vi.mock('../people/registry', () => ({
  ensurePersonForChannel,
  applyChannelInfoToPerson: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../watchdog', () => ({ checkStuckDownloads: vi.fn() }));

import { db } from '../../db/client';
import { deleteQueue } from '../../queue';
import { runMigrations } from '../../db/migrate';
import { ollamaGenerate } from '../../ollama';
import { sign } from '../../signed-channel';
import { internalRouter } from '../internal';
import { requestsRouter } from '../requests';
import {
  runDownloadSecondPass,
  DOWNLOAD_SECOND_PASS_JOB,
  SECOND_PASS_PROMPT_VERSION,
  SECOND_PASS_NO_TRANSCRIPT_PROMPT_VERSION,
  SECOND_PASS_FAILED_REASON,
  GUARD_SCORING_ERROR_REASON,
  AGE_RESTRICTED_REASON,
} from './index';

const app = express();
app.use(express.json({
  verify: (req: ExpressRequest & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use('/internal', internalRouter);
app.use('/requests', requestsRouter);

const KID_ID = '11111111-1111-7111-8111-111111111111';
const ADULT_ID = '22222222-2222-7222-8222-222222222222';
const TRANSCRIPT = 'placeholder transcript words for the second pass';

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  const insertUser = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertUser.run(KID_ID, 'Boy1', 'kid', 1, 2013, now);
  insertUser.run(ADULT_ID, 'Parent', 'parent', 0, null, now);
});

beforeEach(() => {
  db.exec('DELETE FROM guard_eval');
  db.exec('DELETE FROM requests');
  db.exec('DELETE FROM video_metadata');
  vi.mocked(ollamaGenerate).mockReset();
  guardQueueAdd.mockReset().mockResolvedValue(undefined);
  notify.mockReset().mockResolvedValue(undefined);
  ensurePersonForChannel.mockReset().mockReturnValue({ personId: 'person-1', created: false });
});

function seedRequest(requestId: string, opts: { userId?: string; source?: string } = {}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, title, status, decided_by, decided_at, requested_at, added_at)
     VALUES (?, ?, ?, ?, ?, ?, 'downloading', 'auto', ?, ?, ?)`,
  ).run(
    requestId,
    opts.userId ?? KID_ID,
    opts.source ?? 'recommended',
    `https://www.youtube.com/watch?v=${requestId}`,
    requestId,
    'Placeholder title',
    now,
    now,
    now,
  );
}

function seedMetadata(youtubeId: string, opts: { ageRestricted?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO video_metadata
       (youtube_id, description, tags_json, category_id, age_restricted, made_for_kids, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(youtubeId, 'Stored description', JSON.stringify(['placeholder-tag']), '27', opts.ageRestricted ? 1 : 0, 1, new Date().toISOString());
}

async function postSignedJson(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return supertest(app)
    .post(path)
    .set('content-type', 'application/json')
    .set('x-eddy-signature', sign(body))
    .send(body);
}

async function workerDownloaded(requestId: string, transcript: string | null = TRANSCRIPT) {
  const res = await postSignedJson(`/internal/videos/${requestId}/downloaded`, {
    requestId,
    youtubeId: requestId,
    filePath: `/videos/${requestId}.mp4`,
    nginxUrl: `http://mediaserver/videos/${requestId}.mp4`,
    thumbnailUrl: null,
    title: 'Placeholder title',
    channel: 'Placeholder channel',
    youtubeChannelId: 'UCplaceholder',
    description: 'yt-dlp description',
    durationSecs: 120,
    transcript,
    publishedAt: null,
    fileSizeBytes: 1000,
  });
  expect(res.status).toBe(204);
}

function row(requestId: string) {
  return db.prepare(
    'SELECT status, guard_verdict, guard_reason, file_path, transcript FROM requests WHERE request_id = ?',
  ).get(requestId) as { status: string; guard_verdict: string | null; guard_reason: string | null; file_path: string | null; transcript: string | null };
}

function evals(requestId: string) {
  return db.prepare(
    'SELECT gemma_verdict, gemma_reason, prompt_version, request_type FROM guard_eval WHERE request_id = ? ORDER BY scored_at',
  ).all(requestId) as Array<{ gemma_verdict: string; gemma_reason: string; prompt_version: string; request_type: string }>;
}

async function feedIds(userId: string): Promise<string[]> {
  const res = await supertest(app).get(`/requests/feed?userId=${userId}`);
  expect(res.status).toBe(200);
  const body = res.body as { days: Array<{ cards?: Array<{ request_id: string }> }> };
  return body.days.flatMap((d) => (d.cards ?? []).map((c) => c.request_id));
}

async function listIds(userId: string): Promise<string[]> {
  const res = await supertest(app).get(`/requests?userId=${userId}`);
  expect(res.status).toBe(200);
  return (res.body as { requests: Array<{ request_id: string }> }).requests.map((r) => r.request_id);
}

function verdictJson(verdict: string): string {
  return JSON.stringify({ reason: 'Placeholder reason.', verdict, confidence: 0.8 });
}

describe('download-time second pass: kid slate picks', () => {
  it('skips the shadow score at /guard/score so Gemma is only asked once, after download', async () => {
    seedRequest('pick-deferred');
    const res = await postSignedJson('/internal/guard/score', {
      requestId: 'pick-deferred',
      url: 'https://www.youtube.com/watch?v=pick-deferred',
      title: 'Placeholder title',
      channel: 'Placeholder channel',
      description: 'd',
      transcript: TRANSCRIPT,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ proceed: true, verdict: 'deferred' });
    expect(ollamaGenerate).not.toHaveBeenCalled();
    expect(evals('pick-deferred')).toHaveLength(0);
  });

  it('holds a downloaded pick out of sight in guard_review and queues the second pass', async () => {
    seedRequest('pick-queued');
    await workerDownloaded('pick-queued');

    expect(row('pick-queued').status).toBe('guard_review');
    expect(guardQueueAdd).toHaveBeenCalledWith(
      DOWNLOAD_SECOND_PASS_JOB,
      { requestId: 'pick-queued' },
      { jobId: 'second-pass-pick-queued' },
    );
    expect(notify).not.toHaveBeenCalled();
    expect(ensurePersonForChannel).not.toHaveBeenCalled();
    expect(await feedIds(KID_ID)).not.toContain('pick-queued');
    expect(await listIds(KID_ID)).not.toContain('pick-queued');
  });

  it('clear_yes → ready and visible, notified, guard_eval recorded with the transcript version', async () => {
    seedRequest('pick-yes');
    seedMetadata('pick-yes');
    await workerDownloaded('pick-yes');
    vi.mocked(ollamaGenerate).mockResolvedValue(verdictJson('clear_yes'));

    await runDownloadSecondPass('pick-yes');

    expect(row('pick-yes')).toMatchObject({ status: 'ready', guard_verdict: 'clear_yes' });
    expect(evals('pick-yes')).toEqual([
      { gemma_verdict: 'clear_yes', gemma_reason: 'Placeholder reason.', prompt_version: SECOND_PASS_PROMPT_VERSION, request_type: 'video' },
    ]);
    // The prompt carries the transcript and the stored Data API metadata.
    const prompt = vi.mocked(ollamaGenerate).mock.calls[0]![0];
    expect(prompt).toContain(`Transcript excerpt:\n${TRANSCRIPT}`);
    expect(prompt).toContain('Description: Stored description');
    expect(prompt).toContain('Tags: placeholder-tag');
    expect(prompt).toContain('Category: Education');
    expect(notify).toHaveBeenCalledWith(
      { kind: 'video_ready', requestId: 'pick-yes', title: 'Placeholder title' },
      KID_ID,
    );
    expect(ensurePersonForChannel).toHaveBeenCalledWith('UCplaceholder', 'Placeholder channel');
    expect(await feedIds(KID_ID)).toContain('pick-yes');
  });

  it('uncertain → parked in guard_pending with the file kept, not shown, not notified', async () => {
    seedRequest('pick-unsure');
    await workerDownloaded('pick-unsure');
    vi.mocked(ollamaGenerate).mockResolvedValue(verdictJson('uncertain'));

    await runDownloadSecondPass('pick-unsure');

    expect(row('pick-unsure')).toMatchObject({
      status: 'guard_pending',
      guard_verdict: 'uncertain',
      file_path: '/videos/pick-unsure.mp4',
    });
    expect(notify).not.toHaveBeenCalled();
    expect(await feedIds(KID_ID)).not.toContain('pick-unsure');
    expect(await listIds(KID_ID)).not.toContain('pick-unsure');
    const single = await supertest(app).get('/requests/pick-unsure');
    expect(single.body.videoUrl).toBeNull();
  });

  it('clear_no → parked in guard_pending (an Escalation, not a rejection)', async () => {
    seedRequest('pick-no', { source: 'channel_subscription' });
    await workerDownloaded('pick-no');
    vi.mocked(ollamaGenerate).mockResolvedValue(verdictJson('clear_no'));

    await runDownloadSecondPass('pick-no');

    expect(row('pick-no')).toMatchObject({ status: 'guard_pending', guard_verdict: 'clear_no' });
    expect(evals('pick-no')[0]!.gemma_verdict).toBe('clear_no');
    expect(await feedIds(KID_ID)).not.toContain('pick-no');
  });

  it('guard error → parked, with the scoring-error reason recorded', async () => {
    seedRequest('pick-error');
    await workerDownloaded('pick-error');
    vi.mocked(ollamaGenerate).mockRejectedValue(new Error('ollama down'));

    await runDownloadSecondPass('pick-error');

    expect(row('pick-error')).toMatchObject({
      status: 'guard_pending',
      guard_verdict: 'uncertain',
      guard_reason: GUARD_SCORING_ERROR_REASON,
    });
    expect(evals('pick-error')[0]!.gemma_reason).toBe(GUARD_SCORING_ERROR_REASON);
    expect(await feedIds(KID_ID)).not.toContain('pick-error');
  });

  it('missing transcript → guarded on metadata alone and recorded as such', async () => {
    seedRequest('pick-notx');
    await workerDownloaded('pick-notx', null);
    vi.mocked(ollamaGenerate).mockResolvedValue(verdictJson('clear_yes'));

    await runDownloadSecondPass('pick-notx');

    expect(evals('pick-notx')).toEqual([
      expect.objectContaining({ gemma_verdict: 'clear_yes', prompt_version: SECOND_PASS_NO_TRANSCRIPT_PROMPT_VERSION }),
    ]);
    const prompt = vi.mocked(ollamaGenerate).mock.calls[0]![0];
    expect(prompt).not.toContain('Transcript excerpt');
    // No stored metadata: falls back to yt-dlp's description.
    expect(prompt).toContain('Description: yt-dlp description');
    expect(row('pick-notx').status).toBe('ready');
  });

  it('a blank transcript counts as missing', async () => {
    seedRequest('pick-blank');
    await workerDownloaded('pick-blank', '   ');
    vi.mocked(ollamaGenerate).mockResolvedValue(verdictJson('uncertain'));

    await runDownloadSecondPass('pick-blank');

    expect(evals('pick-blank')[0]!.prompt_version).toBe(SECOND_PASS_NO_TRANSCRIPT_PROMPT_VERSION);
  });

  it('age-restricted metadata → clear_no by rule with no model call, parked', async () => {
    seedRequest('pick-age');
    seedMetadata('pick-age', { ageRestricted: true });
    await workerDownloaded('pick-age');

    await runDownloadSecondPass('pick-age');

    expect(ollamaGenerate).not.toHaveBeenCalled();
    expect(row('pick-age')).toMatchObject({ status: 'guard_pending', guard_verdict: 'clear_no', guard_reason: AGE_RESTRICTED_REASON });
    expect(evals('pick-age')).toHaveLength(1);
  });

  it('parks the pick when the second pass cannot be queued', async () => {
    seedRequest('pick-noqueue');
    guardQueueAdd.mockRejectedValue(new Error('redis down'));

    await workerDownloaded('pick-noqueue');

    expect(row('pick-noqueue')).toMatchObject({ status: 'guard_pending', guard_reason: SECOND_PASS_FAILED_REASON });
    expect(await feedIds(KID_ID)).not.toContain('pick-noqueue');
  });

  it('cannot be cancelled while awaiting the second pass, so the file never surfaces uncleared', async () => {
    seedRequest('pick-cancel');
    await workerDownloaded('pick-cancel');

    const cancel = await supertest(app).post('/requests/pick-cancel/cancel');

    expect(cancel.status).toBe(409);
    expect(row('pick-cancel').status).toBe('guard_review');
    expect(await feedIds(KID_ID)).not.toContain('pick-cancel');
    const single = await supertest(app).get('/requests/pick-cancel');
    expect(single.body.videoUrl).toBeNull();

    // The second pass still decides.
    vi.mocked(ollamaGenerate).mockResolvedValue(verdictJson('uncertain'));
    await runDownloadSecondPass('pick-cancel');
    expect(row('pick-cancel').status).toBe('guard_pending');
  });

  it('a second run of the job is a no-op once the pick is resolved', async () => {
    seedRequest('pick-twice');
    await workerDownloaded('pick-twice');
    vi.mocked(ollamaGenerate).mockResolvedValue(verdictJson('uncertain'));
    await runDownloadSecondPass('pick-twice');
    vi.mocked(ollamaGenerate).mockResolvedValue(verdictJson('clear_yes'));

    await runDownloadSecondPass('pick-twice');

    expect(row('pick-twice').status).toBe('guard_pending');
    expect(evals('pick-twice')).toHaveLength(1);
  });
});

describe('download-time second pass: everything else is unchanged', () => {
  it('a kid-initiated request keeps the shadow score and goes straight to ready', async () => {
    seedRequest('kid-share', { source: 'share_sheet' });
    vi.mocked(ollamaGenerate).mockResolvedValue(verdictJson('clear_no'));

    const res = await postSignedJson('/internal/guard/score', {
      requestId: 'kid-share',
      url: 'https://www.youtube.com/watch?v=kid-share',
      title: 'Placeholder title',
      channel: 'Placeholder channel',
      description: 'd',
      transcript: TRANSCRIPT,
    });
    // Shadow mode: the verdict is recorded but never blocks.
    expect(res.body).toMatchObject({ proceed: true, verdict: 'clear_no' });
    expect(evals('kid-share')).toEqual([expect.objectContaining({ prompt_version: 'v2', request_type: 'video' })]);

    await workerDownloaded('kid-share');

    expect(row('kid-share').status).toBe('ready');
    expect(guardQueueAdd).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await feedIds(KID_ID)).toContain('kid-share');
  });

  it("an adult's slate pick is not second-passed", async () => {
    seedRequest('adult-pick', { userId: ADULT_ID });

    await workerDownloaded('adult-pick');

    expect(row('adult-pick').status).toBe('ready');
    expect(guardQueueAdd).not.toHaveBeenCalled();
  });
});

describe('download-time second pass: Blocked channel', () => {
  const blockPlaceholderChannel = () => db.prepare(
    'INSERT OR IGNORE INTO blocked_channels (channel_id, display_name, blocked_by, blocked_at) VALUES (?, ?, ?, ?)',
  ).run('UCplaceholder', 'Placeholder channel', ADULT_ID, new Date().toISOString());

  beforeEach(() => {
    vi.mocked(deleteQueue.add).mockClear();
  });

  afterEach(() => {
    db.exec('DELETE FROM blocked_channels');
  });

  it('rejects a pick whose channel was blocked after download, without a model call, and removes the file', async () => {
    seedRequest('pick-blocked');
    await workerDownloaded('pick-blocked');
    blockPlaceholderChannel();

    await runDownloadSecondPass('pick-blocked');

    // A slate pick the kid never asked for leaves every surface.
    expect(row('pick-blocked')).toMatchObject({ status: 'deleted', file_path: null });
    expect(ollamaGenerate).not.toHaveBeenCalled();
    expect(deleteQueue.add).toHaveBeenCalledWith(
      'delete', { requestId: 'pick-blocked', filePath: '/videos/pick-blocked.mp4' }, expect.anything(),
    );
    expect(notify).not.toHaveBeenCalled();
    expect(await feedIds(KID_ID)).not.toContain('pick-blocked');
  });

  it('does not clear a pick whose channel was blocked while the guard ran', async () => {
    seedRequest('pick-raced');
    await workerDownloaded('pick-raced');
    vi.mocked(ollamaGenerate).mockImplementation(async () => {
      blockPlaceholderChannel();
      return verdictJson('clear_yes');
    });

    await runDownloadSecondPass('pick-raced');

    expect(row('pick-raced').status).toBe('deleted');
    expect(notify).not.toHaveBeenCalled();
  });
});
