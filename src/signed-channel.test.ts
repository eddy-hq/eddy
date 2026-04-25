import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';

vi.mock('./config', () => ({
  config: {
    INTERNAL_HMAC_SECRET: 'a'.repeat(32),
    M4_INTERNAL_URL: 'http://m4.local:3737',
  },
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sign, verify, verifySignedJson, postSigned } from './signed-channel';

const SECRET = 'a'.repeat(32);

function expectedSig(body: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

describe('sign + verify', () => {
  it('round-trips a signed body', () => {
    const body = JSON.stringify({ hello: 'world' });
    const sig = sign(body);
    expect(sig).toBe(expectedSig(body));
    expect(verify(Buffer.from(body), sig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = JSON.stringify({ hello: 'world' });
    const sig = sign(body);
    const tampered = Buffer.from(JSON.stringify({ hello: 'mars' }));
    expect(verify(tampered, sig)).toBe(false);
  });

  it('rejects a body signed with the wrong secret', () => {
    const body = JSON.stringify({ hello: 'world' });
    const wrongSig = `sha256=${crypto.createHmac('sha256', 'b'.repeat(32)).update(body).digest('hex')}`;
    expect(verify(Buffer.from(body), wrongSig)).toBe(false);
  });

  it('rejects a malformed signature header without throwing', () => {
    const body = Buffer.from('hi');
    expect(verify(body, 'not-a-signature')).toBe(false);
    expect(verify(body, '')).toBe(false);
  });
});

interface MockReq {
  headers: Record<string, string | undefined>;
  rawBody?: Buffer;
  path: string;
}
interface MockRes {
  statusCode: number;
  body: unknown;
  status: (n: number) => MockRes;
  json: (b: unknown) => MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(n) { this.statusCode = n; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

describe('verifySignedJson', () => {
  it('calls the inner handler with parsed body when the signature is valid', async () => {
    const payload = { foo: 'bar' };
    const raw = Buffer.from(JSON.stringify(payload));
    const handler = vi.fn();
    const wrapped = verifySignedJson<typeof payload>(handler);
    const req: MockReq = {
      headers: { 'x-eddy-signature': sign(raw.toString()) },
      rawBody: raw,
      path: '/internal/test',
    };
    const res = mockRes();
    await wrapped(req as never, res as never);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![2]).toEqual(payload);
  });

  it('401s when the signature header is missing', async () => {
    const handler = vi.fn();
    const wrapped = verifySignedJson(handler);
    const req: MockReq = { headers: {}, rawBody: Buffer.from('{}'), path: '/p' };
    const res = mockRes();
    await wrapped(req as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('400s when rawBody is missing', async () => {
    const handler = vi.fn();
    const wrapped = verifySignedJson(handler);
    const req: MockReq = {
      headers: { 'x-eddy-signature': sign('') },
      path: '/p',
    };
    const res = mockRes();
    await wrapped(req as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('401s when the signature does not match', async () => {
    const handler = vi.fn();
    const wrapped = verifySignedJson(handler);
    const raw = Buffer.from('{"a":1}');
    const req: MockReq = {
      headers: { 'x-eddy-signature': 'sha256=deadbeef' },
      rawBody: raw,
      path: '/p',
    };
    const res = mockRes();
    await wrapped(req as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('400s when the body is valid HMAC but invalid JSON', async () => {
    const handler = vi.fn();
    const wrapped = verifySignedJson(handler);
    const raw = Buffer.from('not-json');
    const req: MockReq = {
      headers: { 'x-eddy-signature': sign(raw.toString()) },
      rawBody: raw,
      path: '/p',
    };
    const res = mockRes();
    await wrapped(req as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('postSigned', () => {
  it('signs the body and POSTs to M4_INTERNAL_URL + path', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url, init) => {
        captured.url = url as string;
        captured.init = init;
        return Promise.resolve(new Response(null, { status: 204 }));
      });
    try {
      await postSigned('/internal/foo', { hello: 'world' });
      expect(captured.url).toBe('http://m4.local:3737/internal/foo');
      const body = captured.init?.body as string;
      const headers = captured.init?.headers as Record<string, string>;
      expect(body).toBe('{"hello":"world"}');
      expect(headers['X-Eddy-Signature']).toBe(expectedSig(body));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when the response is non-2xx', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('err', { status: 500 }));
    try {
      await expect(postSigned('/internal/foo', {})).rejects.toThrow(/500/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
