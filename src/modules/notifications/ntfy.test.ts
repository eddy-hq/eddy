import { describe, it, expect, beforeEach, vi } from 'vitest';

// The mocked config is mutable so individual tests can flip NTFY_BASE_URL on
// and off to exercise the early-return branch. vi.hoisted keeps both the
// config object and the warn spy accessible to the hoisted vi.mock factories.
const { mockConfig, warnMock } = vi.hoisted(() => ({
  mockConfig: { NTFY_BASE_URL: 'https://ntfy.example/' as string | undefined },
  warnMock: vi.fn(),
}));

vi.mock('../../config', () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock('../../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { sendNtfy } from './ntfy';

interface FetchSpy {
  mock: { calls: unknown[][] };
  mockResolvedValue: (v: Response) => FetchSpy;
  mockRejectedValue: (err: unknown) => FetchSpy;
}

function mockFetchOk(): FetchSpy {
  return vi
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response('ok', { status: 200 })) as unknown as FetchSpy;
}

function lastFetchCall(spy: FetchSpy): { url: string; init: RequestInit } {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [url, init] = calls[calls.length - 1] as [string, RequestInit];
  return { url, init };
}

function headers(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('sendNtfy', () => {
  beforeEach(() => {
    mockConfig.NTFY_BASE_URL = 'https://ntfy.example/';
    warnMock.mockReset();
    vi.restoreAllMocks();
  });

  it('sets Authorization as Basic base64("user:pass")', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'user:pass',
      title: 'Hi',
      message: 'body',
    });
    const { init } = lastFetchCall(spy);
    expect(headers(init)['Authorization']).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
    );
  });

  it('sets Title, default Priority, and Content-Type: text/plain', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
    });
    const h = headers(lastFetchCall(spy).init);
    expect(h['Title']).toBe('Hello');
    expect(h['Priority']).toBe('default');
    expect(h['Content-Type']).toBe('text/plain');
  });

  it('passes through an explicit Priority when provided', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
      priority: 'max',
    });
    expect(headers(lastFetchCall(spy).init)['Priority']).toBe('max');
  });

  it('joins Tags with "," when tags are provided', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
      tags: ['eyes', 'tada'],
    });
    expect(headers(lastFetchCall(spy).init)['Tags']).toBe('eyes,tada');
  });

  it('omits the Tags header when no tags are provided', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
    });
    expect(headers(lastFetchCall(spy).init)).not.toHaveProperty('Tags');
  });

  it('omits the Tags header when tags is an empty array', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
      tags: [],
    });
    expect(headers(lastFetchCall(spy).init)).not.toHaveProperty('Tags');
  });

  it('sets the Click header when clickUrl is provided', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
      clickUrl: 'https://pwa.example/watch/abc',
    });
    expect(headers(lastFetchCall(spy).init)['Click']).toBe(
      'https://pwa.example/watch/abc',
    );
  });

  it('omits the Click header when clickUrl is not provided', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
    });
    expect(headers(lastFetchCall(spy).init)).not.toHaveProperty('Click');
  });

  it('serialises Actions with ";" between actions and the expected per-action shape', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
      actions: [
        {
          action: 'http',
          label: 'Approve',
          url: 'https://pwa.example/action/approve?token=abc',
          method: 'POST',
          clear: true,
        },
        {
          action: 'http',
          label: 'Deny',
          url: 'https://pwa.example/action/deny?token=xyz',
          method: 'POST',
          clear: true,
        },
      ],
    });
    const actions = headers(lastFetchCall(spy).init)['Actions'];
    expect(actions).toBe(
      'http, Approve, https://pwa.example/action/approve?token=abc, method=POST, clear=true; ' +
        'http, Deny, https://pwa.example/action/deny?token=xyz, method=POST, clear=true',
    );
  });

  it('omits method= and clear= from Actions when the flags are absent', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
      actions: [{ action: 'http', label: 'Open', url: 'https://pwa.example/' }],
    });
    expect(headers(lastFetchCall(spy).init)['Actions']).toBe(
      'http, Open, https://pwa.example/',
    );
  });

  it('omits the Actions header when actions is an empty array', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
      actions: [],
    });
    expect(headers(lastFetchCall(spy).init)).not.toHaveProperty('Actions');
  });

  it('sends the raw message string as the request body (not JSON)', async () => {
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'plain body — keep me raw',
    });
    const { init } = lastFetchCall(spy);
    expect(init.body).toBe('plain body — keep me raw');
    expect(init.method).toBe('POST');
  });

  it('builds the URL by joining base + topic and trimming a trailing slash on the base', async () => {
    const spy = mockFetchOk();
    mockConfig.NTFY_BASE_URL = 'https://ntfy.example/';
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
    });
    expect(lastFetchCall(spy).url).toBe('https://ntfy.example/topic-1');

    mockConfig.NTFY_BASE_URL = 'https://ntfy.example';
    await sendNtfy({
      topic: 'topic-2',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
    });
    expect(lastFetchCall(spy).url).toBe('https://ntfy.example/topic-2');
  });

  it('logs a warning and skips fetch when NTFY_BASE_URL is unset', async () => {
    mockConfig.NTFY_BASE_URL = undefined;
    const spy = mockFetchOk();
    await sendNtfy({
      topic: 'topic-1',
      credentials: 'u:p',
      title: 'Hello',
      message: 'body',
    });
    expect(spy).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw when fetch rejects — best-effort semantics', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('boom'));
    await expect(
      sendNtfy({
        topic: 'topic-1',
        credentials: 'u:p',
        title: 'Hello',
        message: 'body',
      }),
    ).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('warn-logs and does not throw on a non-OK response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500 }),
    );
    await expect(
      sendNtfy({
        topic: 'topic-1',
        credentials: 'u:p',
        title: 'Hello',
        message: 'body',
      }),
    ).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
