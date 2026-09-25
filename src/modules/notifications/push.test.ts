import { describe, it, expect, beforeEach, vi } from 'vitest';

// notify() with the APNs transport wired. Ports and sender are injected, so
// these tests touch neither the database nor the network — what they pin is the
// contract around the transport: the log line survives, the content stays here,
// a dead token costs the device its row, and a send failure never reaches the
// caller.

const { warnMock, infoMock, errorMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  infoMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: { info: infoMock, warn: warnMock, error: errorMock, debug: vi.fn() },
}));

import { generateKeyPairSync } from 'crypto';
import http2 from 'http2';
import type { AddressInfo } from 'net';
import { createNotifications, contentFor, type NotificationPorts } from './notify';
import { ApnsConnectionError, createApnsSender, createHttp2Client } from './apns';
import type { ApnsSendResult, ApnsSender, ApnsTarget } from './apns';
import type { NotificationContent } from './messages';

const RECIPIENT = 'user-1';
const DEVICE: ApnsTarget = {
  deviceId: 'device-1',
  apnsToken: 'd'.repeat(64),
  apnsEnvironment: 'production',
};
const VIDEO_READY = {
  kind: 'video_ready',
  requestId: 'req-1',
  title: 'A Very Identifiable Video',
} as const;

function fakePorts(devices: ApnsTarget[] = [DEVICE]) {
  const recorded: Array<{ messageId: string; userId: string; content: NotificationContent }> = [];
  const forgotten: string[] = [];
  const ports: NotificationPorts = {
    listPushDevices: () => devices,
    recordMessage: (messageId, userId, content) => {
      recorded.push({ messageId, userId, content });
    },
    forgetDevice: (deviceId) => {
      forgotten.push(deviceId);
    },
  };
  return { ports, recorded, forgotten };
}

function fakeSender(results: ApnsSendResult[] = []) {
  const sends: Array<{ target: ApnsTarget; messageId: string }> = [];
  const sender: ApnsSender = {
    send: vi.fn(async (target: ApnsTarget, messageId: string): Promise<ApnsSendResult> => {
      sends.push({ target, messageId });
      return results.shift() ?? { ok: true };
    }),
  };
  return { sender, sends };
}

beforeEach(() => {
  warnMock.mockReset();
  infoMock.mockReset();
  errorMock.mockReset();
});

describe('notify() without APNs configured', () => {
  it('stays log-only: one line, no message stored, no send attempted', async () => {
    const { ports, recorded } = fakePorts();
    const { sender, sends } = fakeSender();

    // The production shape when no key is configured: ports wired, sender null.
    const mod = createNotifications({ sender: null, ports });
    await mod.notify(VIDEO_READY, RECIPIENT);

    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock.mock.calls[0]![1]).toContain('log-only');
    expect(recorded).toEqual([]);
    expect(sends).toEqual([]);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('is the default for a module constructed with no options at all', async () => {
    const mod = createNotifications();
    await expect(mod.notify(VIDEO_READY, RECIPIENT)).resolves.toBeUndefined();
    expect(infoMock).toHaveBeenCalledTimes(1);
  });
});

describe('notify() with APNs configured', () => {
  it('still logs the notification, and pushes one opaque id per device', async () => {
    const second: ApnsTarget = { ...DEVICE, deviceId: 'device-2', apnsToken: 'e'.repeat(64) };
    const { ports, recorded } = fakePorts([DEVICE, second]);
    const { sender, sends } = fakeSender();

    const mod = createNotifications({ sender, ports, newMessageId: () => 'opaque-1' });
    await mod.notify(VIDEO_READY, RECIPIENT);

    // One notification line, then one accepted line per device.
    expect(infoMock.mock.calls.map((call) => call[1])).toEqual([
      'Notification',
      'APNs push accepted',
      'APNs push accepted',
    ]);
    expect(sends.map((s) => s.messageId)).toEqual(['opaque-1', 'opaque-1']);
    expect(sends.map((s) => s.target.deviceId)).toEqual(['device-1', 'device-2']);
    expect(recorded).toEqual([
      {
        messageId: 'opaque-1',
        userId: RECIPIENT,
        content: {
          title: 'Ready to watch',
          body: 'A Very Identifiable Video',
          actionUrl: '/watch/req-1',
        },
      },
    ]);
  });

  it('uses a fresh random id for every notification', async () => {
    const { ports } = fakePorts();
    const { sender, sends } = fakeSender();
    const mod = createNotifications({ sender, ports });

    await mod.notify(VIDEO_READY, RECIPIENT);
    await mod.notify(VIDEO_READY, RECIPIENT);

    expect(sends[0]!.messageId).not.toBe(sends[1]!.messageId);
    // A UUID, not the request id it was raised for.
    expect(sends[0]!.messageId).not.toContain('req-1');
    expect(sends[0]!.messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends nothing when the recipient has no registered device', async () => {
    const { ports, recorded } = fakePorts([]);
    const { sender } = fakeSender();

    await createNotifications({ sender, ports }).notify(VIDEO_READY, RECIPIENT);

    expect(sender.send).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    expect(infoMock).toHaveBeenCalledTimes(1);
  });

  it('drops the device row when APNs says the token is dead', async () => {
    const { ports, forgotten } = fakePorts();
    const { sender } = fakeSender([
      { ok: false, status: 410, reason: 'Unregistered', deviceGone: true },
    ]);

    await createNotifications({ sender, ports }).notify(VIDEO_READY, RECIPIENT);

    expect(forgotten).toEqual(['device-1']);
  });

  it('keeps the device for a transient failure that persists, and warns', async () => {
    const { ports, forgotten } = fakePorts();
    const unavailable = { ok: false, status: 503, reason: 'ServiceUnavailable', deviceGone: false } as const;
    const { sender, sends } = fakeSender([unavailable, unavailable]);

    await createNotifications({ sender, ports, retryDelayMs: 0 }).notify(VIDEO_READY, RECIPIENT);

    expect(sends).toHaveLength(2);
    expect(forgotten).toEqual([]);
    expect(warnMock.mock.calls.map((call) => call[1])).toEqual([
      'APNs asked to retry; retrying once',
      'APNs retry answered with a failure',
      'APNs send failed',
    ]);
  });

  it('never throws into the caller when the transport blows up', async () => {
    const { ports } = fakePorts();
    const sender: ApnsSender = {
      send: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };

    await expect(
      createNotifications({ sender, ports }).notify(
        { kind: 'circuit_open', consecutiveTrips: 3 },
        RECIPIENT
      )
    ).resolves.toBeUndefined();

    // The notification was still logged (one warn); the failed send is a
    // second warn, not an error that ends the delivery loop.
    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('still pushes to the other devices when one send throws', async () => {
    const second: ApnsTarget = { ...DEVICE, deviceId: 'device-2' };
    const { ports, forgotten } = fakePorts([DEVICE, second]);
    const reached: string[] = [];
    const sender: ApnsSender = {
      send: vi.fn(async (target: ApnsTarget): Promise<ApnsSendResult> => {
        if (target.deviceId === DEVICE.deviceId) throw new Error('request timed out');
        reached.push(target.deviceId);
        return { ok: true };
      }),
    };

    await expect(
      createNotifications({ sender, ports }).notify(VIDEO_READY, RECIPIENT)
    ).resolves.toBeUndefined();

    expect(reached).toEqual(['device-2']);
    // A thrown send says nothing about the token, so the device is kept.
    expect(forgotten).toEqual([]);
  });

  it('never throws when looking up the devices fails', async () => {
    const { sender } = fakeSender();
    const ports: NotificationPorts = {
      listPushDevices: () => {
        throw new Error('database is locked');
      },
      recordMessage: vi.fn(),
      forgetDevice: vi.fn(),
    };

    await expect(
      createNotifications({ sender, ports }).notify(VIDEO_READY, RECIPIENT)
    ).resolves.toBeUndefined();
    expect(errorMock).toHaveBeenCalledTimes(1);
  });
});

describe('retrying a send', () => {
  const reset = () => new ApnsConnectionError('ECONNRESET');

  // A sender whose answers are scripted per call: an Error is thrown, a result
  // is returned.
  function scriptedSender(script: Array<ApnsSendResult | Error>) {
    const sends: string[] = [];
    const sender: ApnsSender = {
      send: vi.fn(async (target: ApnsTarget): Promise<ApnsSendResult> => {
        sends.push(target.deviceId);
        const next = script.shift() ?? { ok: true };
        if (next instanceof Error) throw next;
        return next;
      }),
    };
    return { sender, sends };
  }

  function loggedFields(mock: typeof infoMock): string {
    return JSON.stringify(mock.mock.calls);
  }

  it('retries once after a connection failure, and logs the retry and its outcome', async () => {
    const { ports } = fakePorts();
    const { sender, sends } = scriptedSender([reset(), { ok: true }]);

    await createNotifications({ sender, ports, retryDelayMs: 0 }).notify(VIDEO_READY, RECIPIENT);

    expect(sends).toEqual(['device-1', 'device-1']);
    expect(warnMock).toHaveBeenCalledWith(
      { deviceId: 'device-1', code: 'ECONNRESET' },
      'APNs connection failed; retrying once on a fresh connection',
    );
    expect(infoMock).toHaveBeenCalledWith({ deviceId: 'device-1' }, 'APNs retry succeeded');
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('waits the retry delay before the second attempt', async () => {
    vi.useFakeTimers();
    try {
      const { ports } = fakePorts();
      const { sender, sends } = scriptedSender([reset(), { ok: true }]);

      const done = createNotifications({ sender, ports, retryDelayMs: 1_000 }).notify(
        VIDEO_READY,
        RECIPIENT,
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(sends).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(sends).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after one retry, logs it, still reaches the next device, and never throws', async () => {
    const second: ApnsTarget = { ...DEVICE, deviceId: 'device-2' };
    const { ports, forgotten } = fakePorts([DEVICE, second]);
    const { sender, sends } = scriptedSender([
      reset(),
      new ApnsConnectionError('ETIMEDOUT', 'APNs request timed out'),
      { ok: true },
    ]);

    await expect(
      createNotifications({ sender, ports, retryDelayMs: 0 }).notify(VIDEO_READY, RECIPIENT),
    ).resolves.toBeUndefined();

    expect(sends).toEqual(['device-1', 'device-1', 'device-2']);
    expect(warnMock).toHaveBeenCalledWith(
      { deviceId: 'device-1', code: 'ETIMEDOUT' },
      'APNs retry failed; continuing with the next device',
    );
    expect(forgotten).toEqual([]);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('does not retry an error that is not a connection failure', async () => {
    const { ports } = fakePorts();
    const { sender, sends } = scriptedSender([new Error('key file unreadable')]);

    await createNotifications({ sender, ports, retryDelayMs: 0 }).notify(VIDEO_READY, RECIPIENT);

    expect(sends).toHaveLength(1);
    expect(warnMock.mock.calls.at(-1)![1]).toBe('APNs send threw; continuing with the next device');
  });

  it('does not retry a 400 or a 410, and a 410 still forgets the device', async () => {
    const { ports, forgotten } = fakePorts();
    const { sender, sends } = scriptedSender([
      { ok: false, status: 400, reason: 'BadTopic', deviceGone: false },
      { ok: false, status: 410, reason: 'Unregistered', deviceGone: true },
    ]);
    const mod = createNotifications({ sender, ports, retryDelayMs: 0 });

    await mod.notify(VIDEO_READY, RECIPIENT);
    await mod.notify(VIDEO_READY, RECIPIENT);

    expect(sends).toHaveLength(2);
    expect(forgotten).toEqual(['device-1']);
  });

  it('does not retry a 429 — resending to the same token only adds to it', async () => {
    const { ports } = fakePorts();
    const { sender, sends } = scriptedSender([
      { ok: false, status: 429, reason: 'TooManyRequests', deviceGone: false },
    ]);

    await createNotifications({ sender, ports, retryDelayMs: 0 }).notify(VIDEO_READY, RECIPIENT);

    expect(sends).toHaveLength(1);
  });

  it('retries a 500 or a 503 once', async () => {
    const { ports } = fakePorts();
    const { sender, sends } = scriptedSender([
      { ok: false, status: 500, reason: 'InternalServerError', deviceGone: false },
      { ok: true },
    ]);

    await createNotifications({ sender, ports, retryDelayMs: 0 }).notify(VIDEO_READY, RECIPIENT);

    expect(sends).toHaveLength(2);
    expect(infoMock).toHaveBeenCalledWith({ deviceId: 'device-1' }, 'APNs retry succeeded');
  });

  it('logs the accepted push with its message id, for matching against fetches', async () => {
    const { ports } = fakePorts();
    const { sender } = scriptedSender([{ ok: true }]);

    await createNotifications({ sender, ports, newMessageId: () => 'opaque-9' }).notify(
      VIDEO_READY,
      RECIPIENT,
    );

    expect(infoMock).toHaveBeenCalledWith(
      { messageId: 'opaque-9', deviceId: 'device-1' },
      'APNs push accepted',
    );
  });

  it('keeps content and tokens out of every retry log line', async () => {
    const { ports } = fakePorts();
    const { sender } = scriptedSender([reset(), reset()]);

    await createNotifications({ sender, ports, retryDelayMs: 0 }).notify(VIDEO_READY, RECIPIENT);

    const logged = loggedFields(warnMock) + loggedFields(infoMock);
    expect(logged).not.toContain('A Very Identifiable Video');
    expect(logged).not.toContain(DEVICE.apnsToken);
  });
});

// The real sender and HTTP/2 client against a local h2c server standing in for
// APNs, so the retry is exercised through the actual connection handling: the
// first connection is reset mid-request, as on 2026-09-25.
describe('retrying over a real HTTP/2 connection', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const settings = { keyPath: '/nowhere/key.p8', keyId: 'KEYID00000', teamId: 'TEAMID0000', topic: 'app.eddyhq.Eddy' };

  // `answer` decides per stream: reset the connection, or respond.
  async function withServer(
    answer: (streamIndex: number) => { reset: true } | { status: number; reason?: string },
    run: (connect: () => http2.ClientHttp2Session, stats: { sessions: number; streams: number }) => Promise<void>,
  ) {
    const server = http2.createServer();
    const serverSessions: http2.ServerHttp2Session[] = [];
    const stats = { sessions: 0, streams: 0 };
    server.on('session', (session) => {
      stats.sessions += 1;
      serverSessions.push(session);
    });
    server.on('stream', (stream) => {
      const decision = answer(stats.streams);
      stats.streams += 1;
      if ('reset' in decision) {
        (stream.session!.socket as unknown as { resetAndDestroy(): void }).resetAndDestroy();
        return;
      }
      stream.respond({ ':status': decision.status });
      stream.end(decision.reason ? JSON.stringify({ reason: decision.reason }) : undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const clientSessions: http2.ClientHttp2Session[] = [];
    const connect = () => {
      const session = http2.connect(`http://127.0.0.1:${port}`);
      clientSessions.push(session);
      return session;
    };
    try {
      await run(connect, stats);
    } finally {
      for (const session of clientSessions) session.destroy();
      for (const session of serverSessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function realSender(connect: () => http2.ClientHttp2Session) {
    return createApnsSender({
      settings,
      client: createHttp2Client({ connect, requestTimeoutMs: 2_000 }),
      readKey: () => keyPem,
    });
  }

  it('retries a reset connection once on a fresh one, and the push goes through', async () => {
    await withServer(
      (i) => (i === 0 ? { reset: true } : { status: 200 }),
      async (connect, stats) => {
        const { ports } = fakePorts();
        await createNotifications({ sender: realSender(connect), ports, retryDelayMs: 0 }).notify(
          VIDEO_READY,
          RECIPIENT,
        );

        expect(stats.streams).toBe(2);
        expect(stats.sessions).toBe(2);
        expect(warnMock.mock.calls[0]![0]).toMatchObject({ deviceId: 'device-1', code: 'ECONNRESET' });
        expect(infoMock).toHaveBeenCalledWith({ deviceId: 'device-1' }, 'APNs retry succeeded');
      },
    );
  });

  it('when the retry is reset too, logs it and still tries the next device', async () => {
    const second: ApnsTarget = { ...DEVICE, deviceId: 'device-2' };
    await withServer(
      (i) => (i < 2 ? { reset: true } : { status: 200 }),
      async (connect, stats) => {
        const { ports } = fakePorts([DEVICE, second]);
        await expect(
          createNotifications({ sender: realSender(connect), ports, retryDelayMs: 0 }).notify(
            VIDEO_READY,
            RECIPIENT,
          ),
        ).resolves.toBeUndefined();

        expect(stats.streams).toBe(3);
        expect(warnMock.mock.calls.map((call) => call[1])).toContain(
          'APNs retry failed; continuing with the next device',
        );
        expect(infoMock).toHaveBeenCalledWith(
          expect.objectContaining({ deviceId: 'device-2' }),
          'APNs push accepted',
        );
        expect(errorMock).not.toHaveBeenCalled();
      },
    );
  });

  it('does not retry a 410, and forgets the device', async () => {
    await withServer(
      () => ({ status: 410, reason: 'Unregistered' }),
      async (connect, stats) => {
        const { ports, forgotten } = fakePorts();
        await createNotifications({ sender: realSender(connect), ports, retryDelayMs: 0 }).notify(
          VIDEO_READY,
          RECIPIENT,
        );

        expect(stats.streams).toBe(1);
        expect(forgotten).toEqual(['device-1']);
      },
    );
  });
});

describe('contentFor', () => {
  it('gives every event kind real copy for the extension to render', () => {
    const contents: NotificationContent[] = [
      contentFor(VIDEO_READY),
      contentFor({
        kind: 'parent_review',
        requestId: 'req-7',
        requesterName: 'User1',
        title: 'A Very Identifiable Video',
        channel: 'A Channel',
        reason: 'because',
        approveToken: 'tok-approve',
        denyToken: 'tok-deny',
      }),
      contentFor({ kind: 'download_alert', requestId: 'req-1', title: 'x', stuckMins: 12, action: 'failed' }),
      contentFor({ kind: 'circuit_open', consecutiveTrips: 3 }),
      contentFor({ kind: 'download_failure_streak', consecutiveFailures: 5, lastError: 'HTTP Error 403' }),
      contentFor({ kind: 'decisions_waiting', count: 3 }),
    ];

    for (const content of contents) {
      expect(content.title.length).toBeGreaterThan(0);
      expect(content.body.length).toBeGreaterThan(0);
    }
  });

  it('keeps the action tokens out of the stored content', () => {
    const content = contentFor({
      kind: 'parent_review',
      requestId: 'req-7',
      requesterName: 'User1',
      title: 'A Very Identifiable Video',
      channel: 'A Channel',
      reason: 'because',
      approveToken: 'tok-approve',
      denyToken: 'tok-deny',
    });

    expect(JSON.stringify(content)).not.toContain('tok-approve');
    expect(JSON.stringify(content)).not.toContain('tok-deny');
  });

  it('says only how many decisions wait, and links to /decisions', () => {
    expect(contentFor({ kind: 'decisions_waiting', count: 3 })).toEqual({
      title: 'Decisions',
      body: '3 decisions waiting',
      actionUrl: '/decisions',
    });
    expect(contentFor({ kind: 'decisions_waiting', count: 1 }).body).toBe('1 decision waiting');
  });
});
