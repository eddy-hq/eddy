import fs from 'fs';
import { createSign } from 'crypto';
import http2 from 'http2';

// The APNs transport behind notify() (ADR-0013). Nothing in here knows what a
// notification is about: a send is a device token, an environment, and an
// opaque message id. The content stays on the M4 and is fetched back by the
// Notification Service Extension through GET /notifications/:messageId
// (ADR-0004).
//
// No new dependency: node's http2 and crypto are all this needs.

export const PLACEHOLDER_TITLE = 'Eddy';
export const PLACEHOLDER_BODY = 'Something new in Eddy';

export const APNS_HOSTS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;

// Apple rejects a provider token older than an hour and refuses one minted more
// than once every 20 minutes, so a JWT is cached and reused across sends and
// refreshed well inside the window — never minted per push.
const JWT_MAX_AGE_MS = 50 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 10_000;

export interface ApnsHttpResponse {
  status: number;
  // APNs' own failure code, e.g. 'BadDeviceToken' — absent on a 200.
  reason?: string;
}

// The seam the tests replace. One POST, no connection management leaking out.
export interface ApnsHttpClient {
  post(input: {
    host: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<ApnsHttpResponse>;
}

export interface ApnsSettings {
  keyPath: string;
  keyId: string;
  teamId: string;
  topic: string;
}

export interface ApnsTarget {
  deviceId: string;
  apnsToken: string;
  apnsEnvironment: 'sandbox' | 'production';
}

export type ApnsSendResult =
  | { ok: true }
  // `deviceGone` means Apple says this token will never work again, so the
  // device row goes.
  | { ok: false; status: number; reason?: string; deviceGone: boolean };

export interface ApnsSender {
  send(target: ApnsTarget, messageId: string): Promise<ApnsSendResult>;
}

export interface ApnsSenderDeps {
  settings: ApnsSettings;
  client?: ApnsHttpClient;
  now?: () => number;
  readKey?: (keyPath: string) => string | Buffer;
}

// The entire payload that transits Apple: placeholder copy plus a random id.
// No title, channel, name, request id or YouTube id — ever. Exported so the
// test can assert on the exact JSON.
export function buildApnsPayload(messageId: string): string {
  return JSON.stringify({
    aps: {
      alert: { title: PLACEHOLDER_TITLE, body: PLACEHOLDER_BODY },
      'mutable-content': 1,
      sound: 'default',
    },
    m: messageId,
  });
}

// Reads the optional APNs settings off a config-shaped object, returning null
// when the key settings are absent — the log-only case. Pure, so config never
// has to be imported here.
export function apnsSettingsFrom(env: {
  APNS_KEY_PATH?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC: string;
}): ApnsSettings | null {
  if (!env.APNS_KEY_PATH || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return null;
  return {
    keyPath: env.APNS_KEY_PATH,
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    topic: env.APNS_TOPIC,
  };
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

interface TokenProvider {
  current(): string;
  // Drops the cached JWT so the next send re-reads the key file and mints
  // again, rather than reattaching a token Apple has already refused.
  invalidate(): void;
}

function createTokenProvider(
  settings: ApnsSettings,
  now: () => number,
  readKey: (keyPath: string) => string | Buffer
): TokenProvider {
  let cached: { jwt: string; issuedAt: number } | null = null;

  return {
    current() {
      const at = now();
      if (cached && at - cached.issuedAt < JWT_MAX_AGE_MS) return cached.jwt;

      const header = base64url(JSON.stringify({ alg: 'ES256', kid: settings.keyId }));
      const claims = base64url(
        JSON.stringify({ iss: settings.teamId, iat: Math.floor(at / 1000) })
      );
      const signature = createSign('SHA256')
        .update(`${header}.${claims}`)
        .sign({ key: readKey(settings.keyPath), dsaEncoding: 'ieee-p1363' })
        .toString('base64url');

      cached = { jwt: `${header}.${claims}.${signature}`, issuedAt: at };
      return cached.jwt;
    },

    invalidate() {
      cached = null;
    },
  };
}

export function createApnsSender(deps: ApnsSenderDeps): ApnsSender {
  const {
    settings,
    client = createHttp2Client(),
    now = Date.now,
    readKey = (keyPath: string) => fs.readFileSync(keyPath),
  } = deps;

  const token = createTokenProvider(settings, now, readKey);

  return {
    async send(target, messageId) {
      const response = await client.post({
        host: APNS_HOSTS[target.apnsEnvironment],
        path: `/3/device/${target.apnsToken}`,
        headers: {
          authorization: `bearer ${token.current()}`,
          'apns-topic': settings.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
        },
        body: buildApnsPayload(messageId),
      });

      if (response.status === 200) return { ok: true };

      // A 403 about the provider token means the cached JWT is no longer
      // acceptable — the key was rotated, or this machine's clock has drifted
      // out of Apple's window. Without this the same stale JWT would be
      // reattached to every send until the 50-minute cache expired, so every
      // push would fail while both the devices and the config looked healthy.
      // The next send mints a fresh one; this one is still reported as failed.
      if (
        response.status === 403 &&
        (response.reason === 'ExpiredProviderToken' ||
          response.reason === 'InvalidProviderToken')
      ) {
        token.invalidate();
      }

      // 410 Gone, and the two 400s that mean the same thing: this token is dead.
      const deviceGone =
        response.status === 410 ||
        (response.status === 400 &&
          (response.reason === 'BadDeviceToken' || response.reason === 'Unregistered'));

      return { ok: false, status: response.status, reason: response.reason, deviceGone };
    },
  };
}

export interface Http2ClientOptions {
  // Both exist for the wedged-session test, which needs a local h2c server and
  // a timeout it can wait out. Production passes neither.
  requestTimeoutMs?: number;
  connect?: (host: string) => http2.ClientHttp2Session;
}

// Production client: one HTTP/2 session per APNs host, reused across sends and
// rebuilt when it dies.
export function createHttp2Client(options: Http2ClientOptions = {}): ApnsHttpClient {
  const { requestTimeoutMs = REQUEST_TIMEOUT_MS, connect = (host: string) => http2.connect(host) } =
    options;
  const sessions = new Map<string, http2.ClientHttp2Session>();

  function dropSession(host: string, session: http2.ClientHttp2Session): void {
    if (sessions.get(host) === session) sessions.delete(host);
  }

  function sessionFor(host: string): http2.ClientHttp2Session {
    const existing = sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = connect(host);
    // A session-level error must not become an unhandled event; the next send
    // opens a fresh connection.
    session.on('error', () => {
      dropSession(host, session);
      session.destroy();
    });
    session.on('close', () => {
      dropSession(host, session);
    });
    sessions.set(host, session);
    return session;
  }

  return {
    post({ host, path, headers, body }) {
      return new Promise<ApnsHttpResponse>((resolve, reject) => {
        const session = sessionFor(host);
        const request = session.request({
          ':method': 'POST',
          ':path': path,
          ...headers,
        });

        request.setTimeout(requestTimeoutMs, () => {
          request.close(http2.constants.NGHTTP2_CANCEL);
          // A connection that dies without a RST — a Tailscale flap, a NAT
          // dropping an idle mapping — leaves a session that is neither closed
          // nor destroyed, so `sessionFor` would hand it back forever and every
          // send would time out silently. Bin the session with the request.
          dropSession(host, session);
          session.destroy();
          reject(new Error('APNs request timed out'));
        });

        let status = 0;
        let raw = '';
        request.on('response', (responseHeaders) => {
          status = Number(responseHeaders[':status'] ?? 0);
        });
        request.on('data', (chunk) => {
          raw += chunk;
        });
        request.on('error', reject);
        request.on('end', () => {
          let reason: string | undefined;
          if (raw) {
            try {
              reason = (JSON.parse(raw) as { reason?: string }).reason;
            } catch {
              // A non-JSON body carries no failure code; the status stands alone.
            }
          }
          resolve({ status, reason });
        });

        request.end(body);
      });
    },
  };
}
