import { describe, it, expect, beforeEach, vi } from 'vitest';

// `notify(event, recipient)` is the whole contract. The transport behind it is
// log-only (ntfy removed, APNs not yet shipped), so what these tests pin is the
// log line each event kind produces: its level, and — the part that matters —
// that no title, channel, requester name or token reaches `logs/`.

const { warnMock, infoMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  infoMock: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: {
    info: infoMock,
    warn: warnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createNotifications } from './notify';

const RECIPIENT = 'user-1';

function lastFields(mock: typeof infoMock): Record<string, unknown> {
  const calls = mock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

// Every string value logged, flattened — used to assert free text never leaks.
function loggedStrings(mock: typeof infoMock): string[] {
  return Object.values(lastFields(mock))
    .filter((v): v is string => typeof v === 'string');
}

beforeEach(() => {
  warnMock.mockReset();
  infoMock.mockReset();
});

describe('createNotifications — log-only transport', () => {
  it('logs one line per notification carrying the kind and the recipient user_id', async () => {
    const mod = createNotifications();
    await mod.notify(
      { kind: 'video_ready', requestId: 'req-1', title: 'Some video' },
      RECIPIENT,
    );
    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();
    const fields = lastFields(infoMock);
    expect(fields['kind']).toBe('video_ready');
    expect(fields['recipient']).toBe(RECIPIENT);
  });

  it('never throws, whoever the recipient is — there is nothing per-user to configure', async () => {
    const mod = createNotifications();
    await expect(
      mod.notify({ kind: 'video_ready', requestId: 'req-1', title: 'Some video' }, 'nobody'),
    ).resolves.toBeUndefined();
    expect(infoMock).toHaveBeenCalledTimes(1);
  });
});

describe('createNotifications — log level by event kind', () => {
  it('logs video_ready at info', async () => {
    const mod = createNotifications();
    await mod.notify(
      { kind: 'video_ready', requestId: 'req-42', title: 'Some video' },
      RECIPIENT,
    );
    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(lastFields(infoMock)['requestId']).toBe('req-42');
  });

  it('logs parent_review at info', async () => {
    const mod = createNotifications();
    await mod.notify(
      {
        kind: 'parent_review',
        requestId: 'req-7',
        requesterName: 'Boy1',
        title: 'Something',
        channel: 'A Channel',
        reason: 'because',
        approveToken: 'tok-approve',
        denyToken: 'tok-deny',
      },
      RECIPIENT,
    );
    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(lastFields(infoMock)['requestId']).toBe('req-7');
  });

  it('logs download_alert at warn, with the stuck minutes and the action taken', async () => {
    const mod = createNotifications();
    await mod.notify(
      {
        kind: 'download_alert',
        requestId: 'req-1',
        title: 'A stuck thing',
        stuckMins: 12,
        action: 'failed',
      },
      RECIPIENT,
    );
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(infoMock).not.toHaveBeenCalled();
    const fields = lastFields(warnMock);
    expect(fields['stuckMins']).toBe(12);
    expect(fields['action']).toBe('failed');
  });

  it('logs circuit_open at warn, with the consecutive trip count', async () => {
    const mod = createNotifications();
    await mod.notify({ kind: 'circuit_open', consecutiveTrips: 3 }, RECIPIENT);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(lastFields(warnMock)['consecutiveTrips']).toBe(3);
  });

  it('logs download_failure_streak at warn, with the count and the error signature', async () => {
    const mod = createNotifications();
    await mod.notify(
      {
        kind: 'download_failure_streak',
        consecutiveFailures: 5,
        lastError: 'HTTP Error 403: Forbidden',
      },
      RECIPIENT,
    );
    expect(warnMock).toHaveBeenCalledTimes(1);
    const fields = lastFields(warnMock);
    expect(fields['consecutiveFailures']).toBe(5);
    expect(fields['lastError']).toBe('HTTP Error 403: Forbidden');
  });
});

describe('createNotifications — nothing about what a kid is watching reaches the log', () => {
  it('drops the title from video_ready', async () => {
    const mod = createNotifications();
    await mod.notify(
      { kind: 'video_ready', requestId: 'req-42', title: 'A Very Identifiable Video' },
      RECIPIENT,
    );
    expect(loggedStrings(infoMock)).not.toContain('A Very Identifiable Video');
  });

  it('drops the title from download_alert', async () => {
    const mod = createNotifications();
    await mod.notify(
      {
        kind: 'download_alert',
        requestId: 'req-1',
        title: 'A Very Identifiable Video',
        stuckMins: 12,
        action: 'alert',
      },
      RECIPIENT,
    );
    expect(loggedStrings(warnMock)).not.toContain('A Very Identifiable Video');
  });

  it('drops the requester name, title, channel, reason and both tokens from parent_review', async () => {
    const mod = createNotifications();
    await mod.notify(
      {
        kind: 'parent_review',
        requestId: 'req-7',
        requesterName: 'A Requester Name',
        title: 'A Very Identifiable Video',
        channel: 'A Channel',
        reason: 'because',
        approveToken: 'tok-approve',
        denyToken: 'tok-deny',
      },
      RECIPIENT,
    );
    const strings = loggedStrings(infoMock);
    for (const secret of [
      'A Requester Name',
      'A Very Identifiable Video',
      'A Channel',
      'because',
      'tok-approve',
      'tok-deny',
    ]) {
      expect(strings).not.toContain(secret);
    }
  });
});
