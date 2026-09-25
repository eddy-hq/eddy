import { generateKeyPairSync } from 'crypto';
import http2 from 'http2';
import type { AddressInfo } from 'net';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The HTTP/2 layer and the clock are injected, so nothing here touches the
// network or the filesystem. What is pinned: the exact bytes that would go to
// Apple, and that a provider JWT is minted once and reused.

import {
  createApnsSender,
  createHttp2Client,
  apnsSettingsFrom,
  buildApnsPayload,
  ApnsConnectionError,
  APNS_HOSTS,
  type ApnsHttpClient,
  type ApnsHttpResponse,
  type ApnsTarget,
} from './apns';

const SETTINGS = {
  keyPath: '/nowhere/key.p8',
  keyId: 'KEYID00000',
  teamId: 'TEAMID0000',
  topic: 'app.eddyhq.Eddy',
};

// A throwaway P-256 key — the same shape as an APNs .p8, generated per run so
// nothing resembling a credential is committed.
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const DEVICE: ApnsTarget = {
  deviceId: 'device-1',
  apnsToken: 'c'.repeat(64),
  apnsEnvironment: 'production',
};

type Sent = Parameters<ApnsHttpClient['post']>[0];

function fakeClient(responses: ApnsHttpResponse[] = []) {
  const sent: Sent[] = [];
  const client: ApnsHttpClient = {
    post: vi.fn(async (input: Sent) => {
      sent.push(input);
      return responses.shift() ?? { status: 200 };
    }),
  };
  return { client, sent };
}

// Counted rather than mocked, so the JWT-reuse assertions are about how often
// the key was read, with no mock typing in the way.
let keyReads = 0;
const readKey = (_keyPath: string): string => {
  keyReads += 1;
  return KEY_PEM;
};

beforeEach(() => {
  keyReads = 0;
});

describe('the payload that transits Apple', () => {
  it('carries the placeholder copy and the opaque id, and nothing else', async () => {
    const { client, sent } = fakeClient();
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => 0 });

    await sender.send(DEVICE, 'message-id-1');

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body)).toEqual({
      aps: {
        alert: { title: 'Eddy', body: 'Something new in Eddy' },
        'mutable-content': 1,
        sound: 'default',
      },
      m: 'message-id-1',
    });
  });

  it('leaks nothing about the notification into the payload or the headers', async () => {
    const { client, sent } = fakeClient();
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => 0 });

    await sender.send(DEVICE, 'message-id-2');

    const wire = `${sent[0]!.body} ${JSON.stringify(sent[0]!.headers)}`;
    for (const secret of [
      'A Very Identifiable Video',
      'A Channel',
      'Ready to watch',
      DEVICE.deviceId,
      'req-7',
    ]) {
      expect(wire).not.toContain(secret);
    }
    // The payload's only variable is the message id.
    expect(buildApnsPayload('message-id-2')).toBe(sent[0]!.body);
  });

  it('posts to the host matching the device’s environment, with the bundle id as topic', async () => {
    const { client, sent } = fakeClient();
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => 0 });

    await sender.send(DEVICE, 'm1');
    await sender.send({ ...DEVICE, apnsEnvironment: 'sandbox' }, 'm2');

    expect(sent[0]!.host).toBe(APNS_HOSTS.production);
    expect(sent[1]!.host).toBe(APNS_HOSTS.sandbox);
    expect(sent[0]!.path).toBe(`/3/device/${DEVICE.apnsToken}`);
    expect(sent[0]!.headers['apns-topic']).toBe('app.eddyhq.Eddy');
    expect(sent[0]!.headers['apns-push-type']).toBe('alert');
  });
});

describe('the provider JWT', () => {
  it('is minted once and reused across sends', async () => {
    const { client, sent } = fakeClient();
    let clock = 1_000_000;
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => clock });

    await sender.send(DEVICE, 'm1');
    clock += 30 * 60 * 1000;
    await sender.send(DEVICE, 'm2');

    expect(keyReads).toBe(1);
    expect(sent[1]!.headers['authorization']).toBe(sent[0]!.headers['authorization']);
    expect(sent[0]!.headers['authorization']).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('is refreshed well inside Apple’s hour', async () => {
    const { client, sent } = fakeClient();
    let clock = 1_000_000;
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => clock });

    await sender.send(DEVICE, 'm1');
    clock += 55 * 60 * 1000;
    await sender.send(DEVICE, 'm2');

    expect(keyReads).toBe(2);
    expect(sent[1]!.headers['authorization']).not.toBe(sent[0]!.headers['authorization']);
  });

  it('signs ES256 with the key id and team id in it', async () => {
    const { client, sent } = fakeClient();
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => 1_700_000_000_000 });

    await sender.send(DEVICE, 'm1');

    const jwt = sent[0]!.headers['authorization']!.replace('bearer ', '');
    const [header, claims] = jwt.split('.') as [string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: SETTINGS.keyId,
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: SETTINGS.teamId,
      iat: 1_700_000_000,
    });
  });
});

describe('what APNs answers', () => {
  it('reports a dead device for 410 Gone', async () => {
    const { client } = fakeClient([{ status: 410, reason: 'Unregistered' }]);
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => 0 });

    expect(await sender.send(DEVICE, 'm1')).toEqual({
      ok: false,
      status: 410,
      reason: 'Unregistered',
      deviceGone: true,
    });
  });

  it('reports a dead device for 400 BadDeviceToken and 400 Unregistered', async () => {
    const { client } = fakeClient([
      { status: 400, reason: 'BadDeviceToken' },
      { status: 400, reason: 'Unregistered' },
    ]);
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => 0 });

    expect((await sender.send(DEVICE, 'm1')).ok).toBe(false);
    expect(await sender.send(DEVICE, 'm2')).toMatchObject({ deviceGone: true });
  });

  it('keeps the device for a failure that is not about the token', async () => {
    const { client } = fakeClient([
      { status: 400, reason: 'BadTopic' },
      { status: 503, reason: 'ServiceUnavailable' },
    ]);
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => 0 });

    expect(await sender.send(DEVICE, 'm1')).toMatchObject({ deviceGone: false });
    expect(await sender.send(DEVICE, 'm2')).toMatchObject({ deviceGone: false, status: 503 });
  });
});

describe('a provider token Apple refuses', () => {
  it('is dropped so the next send mints a fresh one', async () => {
    const { client, sent } = fakeClient([{ status: 403, reason: 'ExpiredProviderToken' }]);
    let clock = 1_000_000;
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => clock });

    const first = await sender.send(DEVICE, 'm1');
    // The device is fine — it is the credential that is stale.
    expect(first).toMatchObject({ ok: false, status: 403, deviceGone: false });

    clock += 1_000;
    await sender.send(DEVICE, 'm2');

    expect(keyReads).toBe(2);
    expect(sent[1]!.headers['authorization']).not.toBe(sent[0]!.headers['authorization']);
  });

  it('is dropped for InvalidProviderToken too', async () => {
    const { client } = fakeClient([{ status: 403, reason: 'InvalidProviderToken' }]);
    let clock = 1_000_000;
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => clock });

    await sender.send(DEVICE, 'm1');
    clock += 1_000;
    await sender.send(DEVICE, 'm2');

    expect(keyReads).toBe(2);
  });

  it('keeps the cached token for a 403 that is not about the token', async () => {
    const { client } = fakeClient([{ status: 403, reason: 'Forbidden' }]);
    let clock = 1_000_000;
    const sender = createApnsSender({ settings: SETTINGS, client, readKey, now: () => clock });

    await sender.send(DEVICE, 'm1');
    clock += 1_000;
    await sender.send(DEVICE, 'm2');

    expect(keyReads).toBe(1);
  });
});

describe('the HTTP/2 connection', () => {
  // A connection that dies without a RST stays `closed === false` and
  // `destroyed === false`, so a cached session would be handed back forever.
  // The stand-in here is a local h2c server that accepts streams and never
  // answers: every send times out, and the test asserts the client reconnects
  // instead of reusing the wedged session.
  it('is rebuilt after a request times out, not reused', async () => {
    const server = http2.createServer();
    const serverSessions: http2.ServerHttp2Session[] = [];
    server.on('session', (session) => serverSessions.push(session));
    server.on('stream', () => {
      // Deliberately no response.
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const host = `http://127.0.0.1:${port}`;
    const client = createHttp2Client({ requestTimeoutMs: 100 });

    try {
      const send = () => client.post({ host, path: '/3/device/token', headers: {}, body: '{}' });

      await expect(send()).rejects.toThrow(/timed out/);
      await expect(send()).rejects.toThrow(/timed out/);

      expect(serverSessions).toHaveLength(2);
    } finally {
      for (const session of serverSessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // A local h2c server whose per-stream behaviour the test scripts.
  async function localApns(
    onStream: (stream: http2.ServerHttp2Stream, index: number) => void,
  ): Promise<{
    host: string;
    sessions: http2.ServerHttp2Session[];
    close: () => Promise<void>;
  }> {
    const server = http2.createServer();
    const sessions: http2.ServerHttp2Session[] = [];
    let streams = 0;
    server.on('session', (session) => sessions.push(session));
    server.on('stream', (stream) => onStream(stream, streams++));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      host: `http://127.0.0.1:${port}`,
      sessions,
      close: async () => {
        for (const session of sessions) session.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  const ok = (stream: http2.ServerHttp2Stream) => {
    stream.respond({ ':status': 200 });
    stream.end();
  };

  it('throws an ApnsConnectionError for a reset connection, and does not reuse it', async () => {
    const apns = await localApns((stream, i) => {
      if (i === 0) {
        (stream.session!.socket as unknown as { resetAndDestroy(): void }).resetAndDestroy();
        return;
      }
      ok(stream);
    });
    const client = createHttp2Client();

    try {
      const send = () => client.post({ host: apns.host, path: '/3/device/token', headers: {}, body: '{}' });

      const failure = await send().catch((err: unknown) => err);
      // Not the exact code: depending on timing the client sees the reset as
      // ECONNRESET, a stream error, or a close with no response at all.
      expect(failure).toBeInstanceOf(ApnsConnectionError);

      expect(await send()).toEqual({ status: 200, reason: undefined });
      expect(apns.sessions).toHaveLength(2);
    } finally {
      await apns.close();
    }
  });

  it('reports a timeout as an ApnsConnectionError', async () => {
    const apns = await localApns(() => {
      // Deliberately no response.
    });
    const client = createHttp2Client({ requestTimeoutMs: 100 });

    try {
      const failure = await client
        .post({ host: apns.host, path: '/3/device/token', headers: {}, body: '{}' })
        .catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ApnsConnectionError);
      expect((failure as ApnsConnectionError).code).toBe('ETIMEDOUT');
    } finally {
      await apns.close();
    }
  });

  it('keeps an answer that arrived before the stream was torn down', async () => {
    const apns = await localApns((stream) => {
      // The server side sees its own reset as a stream error.
      stream.on('error', () => {});
      stream.respond({ ':status': 200 });
      stream.write('{');
      stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    });
    const client = createHttp2Client();

    try {
      const response = await client.post({ host: apns.host, path: '/3/device/token', headers: {}, body: '{}' });
      // Apple took the push; resending would only duplicate it.
      expect(response.status).toBe(200);
    } finally {
      await apns.close();
    }
  });

  it('reuses a session that has been used recently', async () => {
    const apns = await localApns(ok);
    let clock = 1_000_000;
    const client = createHttp2Client({ now: () => clock, sessionIdleMs: 60_000 });

    try {
      const send = () => client.post({ host: apns.host, path: '/3/device/token', headers: {}, body: '{}' });
      await send();
      clock += 59_000;
      await send();
      clock += 59_000;
      await send();

      // Idle is measured from the last send, not from when the session opened.
      expect(apns.sessions).toHaveLength(1);
    } finally {
      await apns.close();
    }
  });

  it('opens a fresh session after an idle spell, and closes the old one', async () => {
    const apns = await localApns(ok);
    let clock = 1_000_000;
    const client = createHttp2Client({ now: () => clock, sessionIdleMs: 60_000 });

    try {
      const send = () => client.post({ host: apns.host, path: '/3/device/token', headers: {}, body: '{}' });
      await send();
      const firstServerSession = apns.sessions[0]!;
      const firstClosed = new Promise<void>((resolve) => firstServerSession.on('close', () => resolve()));

      clock += 60_001;
      await send();

      expect(apns.sessions).toHaveLength(2);
      // The client closed the stale session rather than leaving it open.
      await firstClosed;
    } finally {
      await apns.close();
    }
  });
});

describe('apnsSettingsFrom', () => {
  it('returns null unless all three key settings are present', () => {
    expect(apnsSettingsFrom({ APNS_TOPIC: 'app.eddyhq.Eddy' })).toBeNull();
    expect(
      apnsSettingsFrom({ APNS_KEY_PATH: '/k.p8', APNS_KEY_ID: 'K', APNS_TOPIC: 'app.eddyhq.Eddy' })
    ).toBeNull();
  });

  it('carries the topic through when the key settings are configured', () => {
    expect(
      apnsSettingsFrom({
        APNS_KEY_PATH: '/k.p8',
        APNS_KEY_ID: 'K',
        APNS_TEAM_ID: 'T',
        APNS_TOPIC: 'app.eddyhq.Eddy',
      })
    ).toEqual({ keyPath: '/k.p8', keyId: 'K', teamId: 'T', topic: 'app.eddyhq.Eddy' });
  });
});
