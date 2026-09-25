import express, { NextFunction, Request, Response } from 'express';
import supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// GET /notifications/:messageId — the route the Notification Service Extension
// calls to turn an opaque push into real content. In-memory SQLite, same
// harness as the other DB-touching tests.

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

const { infoMock } = vi.hoisted(() => ({ infoMock: vi.fn() }));

vi.mock('../../logger', () => ({
  logger: { info: infoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { notificationsRouter } from './router';
import { recordMessage, readMessage, MESSAGE_TTL_MS } from './messages';

const RECIPIENT = '11111111-1111-7111-8111-111111111111';
const SOMEONE_ELSE = '22222222-2222-7222-8222-222222222222';

const app = express();
app.use(express.json());
app.use('/notifications', notificationsRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.code });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

const request = supertest(app);

beforeAll(() => {
  runMigrations();
  const insertUser = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertUser.run(RECIPIENT, 'User1', 'kid', 12, new Date().toISOString());
  insertUser.run(SOMEONE_ELSE, 'User2', 'parent', 0, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM notification_messages');
  infoMock.mockReset();
});

function fetchLogs(): Array<[Record<string, unknown>, string]> {
  return infoMock.mock.calls.filter((call) => call[1] === 'Notification message fetch') as Array<
    [Record<string, unknown>, string]
  >;
}

describe('the fetch log line', () => {
  it('logs the message id and "found", and none of the content', async () => {
    recordMessage('opaque-log-1', RECIPIENT, {
      title: 'Ready to watch',
      body: 'A Very Identifiable Video',
      actionUrl: '/watch/req-1',
    });

    await request.get('/notifications/opaque-log-1').query({ userId: RECIPIENT });

    const logs = fetchLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toEqual({ messageId: 'opaque-log-1', outcome: 'found' });
    const line = JSON.stringify(logs[0]);
    for (const leak of ['Ready to watch', 'A Very Identifiable Video', '/watch/req-1', 'User1', RECIPIENT]) {
      expect(line).not.toContain(leak);
    }
  });

  it('logs "not_found" for someone else’s, an unknown or an expired id', async () => {
    recordMessage('opaque-log-2', RECIPIENT, { title: 'Ready to watch', body: 'Something' });

    await request.get('/notifications/opaque-log-2').query({ userId: SOMEONE_ELSE });
    await request.get('/notifications/never-sent').query({ userId: RECIPIENT });

    expect(fetchLogs().map(([fields]) => fields)).toEqual([
      { messageId: 'opaque-log-2', outcome: 'not_found' },
      { messageId: 'never-sent', outcome: 'not_found' },
    ]);
    expect(JSON.stringify(fetchLogs())).not.toContain('User2');
  });

  it('logs "user_rejected" when the caller is not a known user', async () => {
    await request.get('/notifications/opaque-log-3');

    expect(fetchLogs().map(([fields]) => fields)).toEqual([
      { messageId: 'opaque-log-3', outcome: 'user_rejected' },
    ]);
  });
});

describe('GET /notifications/:messageId', () => {
  it('returns the content to its recipient', async () => {
    recordMessage('opaque-1', RECIPIENT, {
      title: 'Ready to watch',
      body: 'A Very Identifiable Video',
      actionUrl: '/watch/req-1',
    });

    const res = await request.get('/notifications/opaque-1').query({ userId: RECIPIENT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      title: 'Ready to watch',
      body: 'A Very Identifiable Video',
      actionUrl: '/watch/req-1',
    });
  });

  it('omits actionUrl when the event has no destination', async () => {
    recordMessage('opaque-2', RECIPIENT, { title: 'Downloads paused', body: 'Blocked 3 times.' });

    const res = await request.get('/notifications/opaque-2').query({ userId: RECIPIENT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'Downloads paused', body: 'Blocked 3 times.' });
  });

  it('404s for another household member, revealing nothing', async () => {
    recordMessage('opaque-3', RECIPIENT, { title: 'Ready to watch', body: 'A Very Identifiable Video' });

    const res = await request.get('/notifications/opaque-3').query({ userId: SOMEONE_ELSE });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('A Very Identifiable Video');
  });

  it('404s for an id that does not exist — the same answer as someone else’s', async () => {
    const res = await request.get('/notifications/never-sent').query({ userId: RECIPIENT });
    expect(res.status).toBe(404);
  });

  it('404s once the message has expired', async () => {
    const longAgo = Date.now() - MESSAGE_TTL_MS - 1000;
    recordMessage('opaque-4', RECIPIENT, { title: 'Ready to watch', body: 'Old news' }, longAgo);

    const res = await request.get('/notifications/opaque-4').query({ userId: RECIPIENT });
    expect(res.status).toBe(404);
  });

  it('400s without a userId', async () => {
    recordMessage('opaque-5', RECIPIENT, { title: 'Ready to watch', body: 'Something' });
    expect((await request.get('/notifications/opaque-5')).status).toBe(400);
  });
});

describe('the message store', () => {
  it('prunes messages past their TTL when the next one is written', () => {
    const longAgo = Date.now() - MESSAGE_TTL_MS - 1000;
    recordMessage('old', RECIPIENT, { title: 'Old', body: 'Old' }, longAgo);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notification_messages').get()).toEqual({ n: 1 });

    recordMessage('new', RECIPIENT, { title: 'New', body: 'New' });

    const rows = db.prepare('SELECT message_id FROM notification_messages').all();
    expect(rows).toEqual([{ message_id: 'new' }]);
  });

  it('readMessage returns null for a recipient mismatch rather than the row', () => {
    recordMessage('opaque-6', RECIPIENT, { title: 'Ready to watch', body: 'Something' });

    expect(readMessage('opaque-6', SOMEONE_ELSE)).toBeNull();
    expect(readMessage('opaque-6', RECIPIENT)).toEqual({ title: 'Ready to watch', body: 'Something' });
  });
});
