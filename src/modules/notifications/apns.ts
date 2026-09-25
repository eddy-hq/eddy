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

// A send that failed before APNs gave any answer: the connection was reset,
// the session was already closed or going away, the stream was cancelled
// before response headers arrived, or the request timed out. Apple never said
// no, so the push may simply not have been delivered — which is what makes it
// worth one retry on a fresh connection (see notify.ts). `code` is the
// underlying Node error code (e.g. ECONNRESET) and is the only detail that
// should be logged.
export class ApnsConnectionError extends Error {
  readonly code: string;

  constructor(code: string, message = `APNs connection failed (${code})`) {
    super(message);
    this.name = 'ApnsConnectionError';
    this.code = code;
  }
}

// Apple documents 500 InternalServerError and 503 ServiceUnavailable/Shutdown
// as "try again later". 429 TooManyRequests is also a retry-later, but it is
// about this device token specifically — resending to the same token a second
// later only adds to the count, so it is left alone.
export function isRetryableApnsStatus(status: number): boolean {
  return status === 500 || status === 503;
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}

// A session that has carried nothing for this long is not trusted with the
// next send: it is closed and a fresh one opened. The 2026-09-25 lost pushes
// were the first sends after an overnight idle, and a NAT or Apple can drop an
// idle connection without a RST, which only shows up when the next request
// dies on it. Five minutes sits under common NAT idle timeouts; Eddy sends a
// handful of pushes a day, so the cost is one TLS handshake on the first send
// after a quiet spell. Chosen over HTTP/2 PING because it needs no timers —
// nothing to keep a test process or a shutdown alive — and node's ping has no
// timeout of its own, so spotting a silently dead connection would need
// another timer on top.
const SESSION_IDLE_MS = 5 * 60 * 1000;

export interface Http2ClientOptions {
  // All of these exist for the tests, which need a local h2c server, a timeout
  // they can wait out and a clock they can move. Production passes none.
  requestTimeoutMs?: number;
  sessionIdleMs?: number;
  now?: () => number;
  connect?: (host: string) => http2.ClientHttp2Session;
}

interface CachedSession {
  session: http2.ClientHttp2Session;
  lastUsedAt: number;
}

// Production client: one HTTP/2 session per APNs host, reused across sends and
// rebuilt when it dies, when a request on it fails before any response, or
// when it has sat idle past SESSION_IDLE_MS.
export function createHttp2Client(options: Http2ClientOptions = {}): ApnsHttpClient {
  const {
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    sessionIdleMs = SESSION_IDLE_MS,
    now = Date.now,
    connect = (host: string) => http2.connect(host),
  } = options;
  const sessions = new Map<string, CachedSession>();

  function dropSession(host: string, session: http2.ClientHttp2Session): void {
    if (sessions.get(host)?.session === session) sessions.delete(host);
  }

  // Stop handing this session out. A graceful close lets any other in-flight
  // stream on it finish; on a dead connection those streams error anyway.
  function retireSession(host: string, session: http2.ClientHttp2Session): void {
    dropSession(host, session);
    if (!session.closed && !session.destroyed) session.close();
  }

  function touch(host: string, session: http2.ClientHttp2Session): void {
    const cached = sessions.get(host);
    if (cached?.session === session) cached.lastUsedAt = now();
  }

  function sessionFor(host: string): http2.ClientHttp2Session {
    const existing = sessions.get(host);
    if (existing && !existing.session.closed && !existing.session.destroyed) {
      if (now() - existing.lastUsedAt <= sessionIdleMs) return existing.session;
      retireSession(host, existing.session);
    }

    const session = connect(host);
    // A session-level error must not become an unhandled event; the next send
    // opens a fresh connection.
    session.on('error', () => {
      dropSession(host, session);
      session.destroy();
    });
    // Apple sends GOAWAY when it is shutting a connection down; nothing new
    // should be started on it.
    session.on('goaway', () => {
      dropSession(host, session);
    });
    session.on('close', () => {
      dropSession(host, session);
    });
    sessions.set(host, { session, lastUsedAt: now() });
    return session;
  }

  return {
    post({ host, path, headers, body }) {
      return new Promise<ApnsHttpResponse>((resolve, reject) => {
        let session: http2.ClientHttp2Session;
        let request: http2.ClientHttp2Stream;
        try {
          session = sessionFor(host);
          touch(host, session);
          request = session.request({
            ':method': 'POST',
            ':path': path,
            ...headers,
          });
        } catch (err) {
          // e.g. ERR_HTTP2_GOAWAY_SESSION or ERR_HTTP2_INVALID_SESSION: the
          // session went away between the liveness check and the request.
          reject(new ApnsConnectionError(codeOf(err)));
          return;
        }

        let settled = false;
        let status = 0;
        let raw = '';

        function parseReason(): string | undefined {
          if (!raw) return undefined;
          try {
            return (JSON.parse(raw) as { reason?: string }).reason;
          } catch {
            // A non-JSON body carries no failure code; the status stands alone.
            return undefined;
          }
        }

        function answered(): void {
          settled = true;
          touch(host, session);
          resolve({ status, reason: parseReason() });
        }

        // Once APNs has answered with a status, that answer stands even if the
        // stream is torn down before the body finishes: a 200 means Apple took
        // the push, and resending it would only duplicate it. Before any
        // status, it is a connection failure and the session is not reused.
        function failed(code: string, message?: string): void {
          if (settled) return;
          if (status > 0) {
            answered();
            return;
          }
          settled = true;
          retireSession(host, session);
          reject(new ApnsConnectionError(code, message));
        }

        request.setTimeout(requestTimeoutMs, () => {
          request.close(http2.constants.NGHTTP2_CANCEL);
          // A connection that dies without a RST — a Tailscale flap, a NAT
          // dropping an idle mapping — leaves a session that is neither closed
          // nor destroyed, so `sessionFor` would hand it back forever and every
          // send would time out silently. Bin the session with the request.
          dropSession(host, session);
          session.destroy();
          failed('ETIMEDOUT', 'APNs request timed out');
        });

        request.on('response', (responseHeaders) => {
          status = Number(responseHeaders[':status'] ?? 0);
        });
        request.on('data', (chunk) => {
          raw += chunk;
        });
        request.on('error', (err) => failed(codeOf(err)));
        // The normal path: `failed` resolves with the answer once a status is
        // in. A stream that ends without ever getting one is a failure too.
        request.on('end', () => failed('NO_RESPONSE'));
        // A stream closed by the peer (RST_STREAM, or a GOAWAY that excluded
        // it) can close without 'end' or 'error'; without this the promise
        // would never settle.
        request.on('close', () => failed(`STREAM_CLOSED_${request.rstCode ?? 0}`));

        request.end(body);
      });
    },
  };
}
