import { describe, it, expect, beforeEach, vi } from 'vitest';

// The wrappers used to live as `sendVideoReady` / `sendDownloadAlert` /
// `sendParentReview`. They were consolidated behind `notify(event, recipient)`
// in createNotifications; the acceptance criteria still apply to the payload
// each event kind produces, which we observe by mocking `sendNtfy`.

const { sendNtfyMock, warnMock, infoMock } = vi.hoisted(() => ({
  sendNtfyMock: vi.fn().mockResolvedValue(undefined),
  warnMock: vi.fn(),
  infoMock: vi.fn(),
}));

vi.mock('./ntfy', () => ({
  sendNtfy: sendNtfyMock,
}));

vi.mock('../../logger', () => ({
  logger: {
    info: infoMock,
    warn: warnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createNotifications, type NtfyUserConfig } from './notify';

const BASE = 'http://100.0.0.1:3737';
const USER: NtfyUserConfig = {
  userId: 'user-1',
  topic: 'eddy-user-1',
  credentials: 'u:p',
};

function build(opts?: { ntfyConfig?: ReadonlyArray<NtfyUserConfig> }) {
  return createNotifications({
    ntfyConfig: opts?.ntfyConfig ?? [USER],
    pwaBaseUrl: BASE,
  });
}

function lastSendNtfyArg(): Record<string, unknown> {
  const calls = sendNtfyMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  sendNtfyMock.mockReset();
  sendNtfyMock.mockResolvedValue(undefined);
  warnMock.mockReset();
  infoMock.mockReset();
});

describe('createNotifications — ntfy lookup by recipient', () => {
  it('skips sendNtfy and warns when the recipient has no ntfy config', async () => {
    const mod = build({ ntfyConfig: [] });
    await mod.notify(
      { kind: 'video_ready', requestId: 'req-1', title: 'Some video' },
      'user-1',
    );
    expect(sendNtfyMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('skips sendNtfy and warns when the recipient does not match any configured user', async () => {
    const mod = build({ ntfyConfig: [USER] });
    await mod.notify(
      { kind: 'video_ready', requestId: 'req-1', title: 'Some video' },
      'someone-else',
    );
    expect(sendNtfyMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('skips sendNtfy and warns when the matched user has an empty topic', async () => {
    const mod = build({ ntfyConfig: [{ ...USER, topic: '' }] });
    await mod.notify(
      { kind: 'video_ready', requestId: 'req-1', title: 'Some video' },
      'user-1',
    );
    expect(sendNtfyMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('skips sendNtfy and warns when the matched user has empty credentials', async () => {
    const mod = build({ ntfyConfig: [{ ...USER, credentials: '' }] });
    await mod.notify(
      { kind: 'video_ready', requestId: 'req-1', title: 'Some video' },
      'user-1',
    );
    expect(sendNtfyMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('passes the matched user topic and credentials through to sendNtfy', async () => {
    const mod = build();
    await mod.notify(
      { kind: 'video_ready', requestId: 'req-1', title: 'Some video' },
      'user-1',
    );
    const arg = lastSendNtfyArg();
    expect(arg['topic']).toBe('eddy-user-1');
    expect(arg['credentials']).toBe('u:p');
  });
});

describe('createNotifications — video_ready', () => {
  it('uses priority default, tag tada, and clickUrl pointing at /watch/<requestId>', async () => {
    const mod = build();
    await mod.notify(
      { kind: 'video_ready', requestId: 'req-42', title: 'Some video' },
      'user-1',
    );
    const arg = lastSendNtfyArg();
    expect(arg['priority']).toBe('default');
    expect(arg['tags']).toEqual(['tada']);
    expect(arg['clickUrl']).toBe(`${BASE}/watch/req-42`);
    expect(arg['message']).toBe('Some video');
  });
});

describe('createNotifications — download_alert', () => {
  it('uses priority high and tag warning when action is "failed"', async () => {
    const mod = build();
    await mod.notify(
      {
        kind: 'download_alert',
        requestId: 'req-1',
        title: 'A stuck thing',
        stuckMins: 12,
        action: 'failed',
      },
      'user-1',
    );
    const arg = lastSendNtfyArg();
    expect(arg['priority']).toBe('high');
    expect(arg['tags']).toEqual(['warning']);
  });

  it('uses priority default and tag arrows_counterclockwise when action is "re-enqueued"', async () => {
    const mod = build();
    await mod.notify(
      {
        kind: 'download_alert',
        requestId: 'req-1',
        title: 'A stuck thing',
        stuckMins: 12,
        action: 're-enqueued',
      },
      'user-1',
    );
    const arg = lastSendNtfyArg();
    expect(arg['priority']).toBe('default');
    expect(arg['tags']).toEqual(['arrows_counterclockwise']);
  });

  it('uses priority default and tag arrows_counterclockwise when action is "alert"', async () => {
    const mod = build();
    await mod.notify(
      {
        kind: 'download_alert',
        requestId: 'req-1',
        title: 'A stuck thing',
        stuckMins: 12,
        action: 'alert',
      },
      'user-1',
    );
    const arg = lastSendNtfyArg();
    expect(arg['priority']).toBe('default');
    expect(arg['tags']).toEqual(['arrows_counterclockwise']);
  });
});

describe('createNotifications — parent_review', () => {
  it('builds approve and deny action URLs from the token contract', async () => {
    const mod = build();
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
      'user-1',
    );
    const arg = lastSendNtfyArg();
    const actions = arg['actions'] as Array<{
      action: string;
      label: string;
      url: string;
      method?: string;
      clear?: boolean;
    }>;
    expect(actions).toHaveLength(2);
    expect(actions[0].label).toBe('Approve');
    expect(actions[0].url).toBe(`${BASE}/action/approve?token=tok-approve`);
    expect(actions[1].label).toBe('Deny');
    expect(actions[1].url).toBe(`${BASE}/action/deny?token=tok-deny`);
  });

  it('uses priority max, tag eyes, and two http actions in Approve-then-Deny order', async () => {
    const mod = build();
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
      'user-1',
    );
    const arg = lastSendNtfyArg();
    expect(arg['priority']).toBe('max');
    expect(arg['tags']).toEqual(['eyes']);
    const actions = arg['actions'] as Array<{
      action: string;
      method?: string;
      clear?: boolean;
    }>;
    expect(actions).toHaveLength(2);
    expect(actions[0].action).toBe('http');
    expect(actions[0].method).toBe('POST');
    expect(actions[0].clear).toBe(true);
    expect(actions[1].action).toBe('http');
    expect(actions[1].method).toBe('POST');
    expect(actions[1].clear).toBe(true);
  });
});
