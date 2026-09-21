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

import { createNotifications, contentFor, type NotificationPorts } from './notify';
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

    expect(infoMock).toHaveBeenCalledTimes(1);
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

  it('keeps the device for a transient failure, and warns', async () => {
    const { ports, forgotten } = fakePorts();
    const { sender } = fakeSender([
      { ok: false, status: 503, reason: 'ServiceUnavailable', deviceGone: false },
    ]);

    await createNotifications({ sender, ports }).notify(VIDEO_READY, RECIPIENT);

    expect(forgotten).toEqual([]);
    expect(warnMock).toHaveBeenCalledTimes(1);
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

    // The notification was still logged; only the delivery failed.
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(errorMock).toHaveBeenCalledTimes(1);
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
});
