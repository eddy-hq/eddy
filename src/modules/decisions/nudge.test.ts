import { describe, expect, it, vi } from 'vitest';

// Scheduler registration only; the nudge itself is covered against a real
// in-memory DB in decisions.integration.test.ts.

const mocks = vi.hoisted(() => ({
  upsert: vi.fn().mockResolvedValue(undefined),
  workers: [] as Array<{ close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }>,
}));

vi.mock('../../config', () => ({
  config: { DECISIONS_NUDGE_CRON: '0 19 * * *', DECISIONS_NUDGE_TZ: 'Europe/London' },
}));
vi.mock('../../db/client', () => ({ db: {} }));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => {
    const w = { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
    mocks.workers.push(w);
    return w;
  }),
}));
vi.mock('../../queue', () => ({ redis: {}, decisionsQueue: { upsertJobScheduler: mocks.upsert } }));
vi.mock('../notifications', () => ({ getNotifications: () => ({ notify: vi.fn() }) }));
vi.mock('../users', () => ({ listParentIds: () => [] }));
vi.mock('./queue', () => ({ readDecisionQueue: () => ({ cards: [] }) }));

import { DECISIONS_NUDGE_JOB_ID, startDecisionsNudgeScheduler, stopDecisionsNudgeScheduler } from './nudge';

describe('startDecisionsNudgeScheduler', () => {
  it('upserts one scheduler at the configured time and zone, and stops cleanly', async () => {
    startDecisionsNudgeScheduler();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith(
      DECISIONS_NUDGE_JOB_ID,
      { pattern: '0 19 * * *', tz: 'Europe/London' },
      { name: 'nudge', data: {} },
    );
    // BullMQ custom ids take 0 or exactly 2 colons.
    expect(DECISIONS_NUDGE_JOB_ID).not.toContain(':');
    expect(mocks.workers).toHaveLength(1);

    await stopDecisionsNudgeScheduler();
    expect(mocks.workers[0]!.close).toHaveBeenCalledTimes(1);
  });
});
