import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import crypto from 'crypto';

// In-memory SQLite mirrors the `state.test.ts` harness: the `used_tokens`
// table lives in `:memory:`, the migrations run once, and each test gets a
// clean table via `beforeEach`. `config` is mocked so we can flip
// `TOKEN_SECRET` per-test without touching real env.
vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../config', () => ({
  config: {
    TOKEN_SECRET: 'a'.repeat(32),
  },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../db/client';
import { config } from '../../config';
import { runMigrations } from '../../db/migrate';
import { generateActionToken, validateActionToken } from './tokens';

const USER_ID = '11111111-1111-7111-8111-111111111111';
const TOKEN_TTL_MS = 60 * 60 * 1000;

// Forge a token that bypasses the `used_tokens` insert in `generateActionToken`.
// Used by the "unknown token" case (well-formed, signature-valid, but no row).
function signToken(handler: string, userId: string, expires: number, secret: string): string {
  const payload = `${handler}:${userId}:${expires}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM used_tokens');
  config.TOKEN_SECRET = 'a'.repeat(32);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('generateActionToken + validateActionToken — happy path', () => {
  it('round-trips: validate returns ok with the handler and userId baked in', () => {
    const token = generateActionToken('approve', USER_ID);

    const result = validateActionToken(token);

    expect(result).toEqual({ ok: true, handler: 'approve', userId: USER_ID });
  });

  it('records exactly one used_tokens row at generate time', () => {
    generateActionToken('approve', USER_ID);

    const rows = db.prepare('SELECT handler, user_id FROM used_tokens').all() as {
      handler: string;
      user_id: string;
    }[];
    expect(rows).toEqual([{ handler: 'approve', user_id: USER_ID }]);
  });

  it('updates used_at to the redemption time after a successful validate', () => {
    const token = generateActionToken('approve', USER_ID);
    const before = Date.now();

    validateActionToken(token);

    const row = db
      .prepare('SELECT used_at FROM used_tokens WHERE handler = ?')
      .get('approve') as { used_at: string };
    expect(new Date(row.used_at).getTime()).toBeGreaterThanOrEqual(before);
    // used_at is no longer the expiry — it has been moved back to "now".
    expect(new Date(row.used_at).getTime()).toBeLessThan(before + TOKEN_TTL_MS);
  });
});

describe('validateActionToken — malformed inputs', () => {
  it('rejects a token with no "."', () => {
    expect(validateActionToken('no-dot-here')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a token whose payload has fewer than 3 colon-separated parts', () => {
    const payload = `approve:${USER_ID}`; // only 2 parts
    const sig = crypto.createHmac('sha256', config.TOKEN_SECRET).update(payload).digest('hex');
    const token = `${Buffer.from(payload).toString('base64url')}.${sig}`;

    expect(validateActionToken(token)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a token whose payload has more than 3 colon-separated parts', () => {
    const payload = `approve:${USER_ID}:${Date.now() + TOKEN_TTL_MS}:extra`;
    const sig = crypto.createHmac('sha256', config.TOKEN_SECRET).update(payload).digest('hex');
    const token = `${Buffer.from(payload).toString('base64url')}.${sig}`;

    expect(validateActionToken(token)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects when the base64 payload decodes to something with no colons', () => {
    // "not-a-payload" base64-decodes cleanly but produces a single-part string.
    const payloadB64 = Buffer.from('not-a-payload').toString('base64url');
    const sig = 'deadbeef';
    expect(validateActionToken(`${payloadB64}.${sig}`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects when the base64 payload contains characters outside the base64url alphabet', () => {
    // Spaces, `+`, `/`, `=` are all outside base64url. Node's Buffer.from
    // currently tolerates these by skipping them, so the failure mode falls
    // through to the colon-count check — but the test pins the externally
    // observable behaviour for the "bad base64" case so a stricter decoder
    // would still report `malformed` rather than e.g. silently advancing to
    // signature verification with a partly-decoded payload.
    const sig = 'deadbeef';
    expect(validateActionToken(`not a valid base64!.${sig}`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('validateActionToken — signature failures', () => {
  it('rejects when a single byte of the signature is flipped', () => {
    const token = generateActionToken('approve', USER_ID);
    const dot = token.lastIndexOf('.');
    const sig = token.slice(dot + 1);
    // Flip the first hex character of the signature — swap '0' for '1' etc.
    const firstChar = sig[0]!;
    const flipped = (firstChar === '0' ? '1' : '0') + sig.slice(1);
    const tampered = `${token.slice(0, dot + 1)}${flipped}`;

    expect(validateActionToken(tampered)).toEqual({ ok: false, reason: 'invalid signature' });
  });

  it('rejects when TOKEN_SECRET has changed between generate and validate', () => {
    const token = generateActionToken('approve', USER_ID);

    // Rotate the secret — the row stays in used_tokens, but the signature
    // no longer verifies under the new key.
    config.TOKEN_SECRET = 'b'.repeat(32);

    expect(validateActionToken(token)).toEqual({ ok: false, reason: 'invalid signature' });
  });

  it('rejects a length-mismatched signature without throwing (timingSafeEqual try/catch)', () => {
    // Build a payload and attach a signature that is the wrong length —
    // `crypto.timingSafeEqual` throws on length mismatch and the catch
    // converts that into a clean "invalid signature" verdict.
    const expires = Date.now() + TOKEN_TTL_MS;
    const payload = `approve:${USER_ID}:${expires}`;
    const payloadB64 = Buffer.from(payload).toString('base64url');
    const shortSig = 'ab';
    const token = `${payloadB64}.${shortSig}`;

    expect(validateActionToken(token)).toEqual({ ok: false, reason: 'invalid signature' });
  });

  it('rejects a tampered payload whose base64 differs from the signed string', () => {
    // Sign payload A, then swap the base64 portion for payload B's encoding.
    // The signature is still well-formed hex of the right length, but it was
    // computed over a different string — so verification fails.
    const expires = Date.now() + TOKEN_TTL_MS;
    const signedPayload = `approve:${USER_ID}:${expires}`;
    const sig = crypto
      .createHmac('sha256', config.TOKEN_SECRET)
      .update(signedPayload)
      .digest('hex');

    const tamperedPayload = `deny:${USER_ID}:${expires}`;
    const tamperedB64 = Buffer.from(tamperedPayload).toString('base64url');
    const tamperedToken = `${tamperedB64}.${sig}`;

    expect(validateActionToken(tamperedToken)).toEqual({
      ok: false,
      reason: 'invalid signature',
    });
  });
});

describe('validateActionToken — expiry', () => {
  it('rejects a token whose expiry is in the past', () => {
    vi.useFakeTimers();
    const start = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(start);

    const token = generateActionToken('approve', USER_ID);

    // Advance past the 1-hour TTL by a comfortable margin.
    vi.setSystemTime(new Date(start.getTime() + TOKEN_TTL_MS + 60_000));

    expect(validateActionToken(token)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('validateActionToken — unknown token', () => {
  it('rejects a well-formed, signature-valid token with no used_tokens row', () => {
    const expires = Date.now() + TOKEN_TTL_MS;
    const token = signToken('approve', USER_ID, expires, config.TOKEN_SECRET);

    // No insert into used_tokens — this is the path where the row was
    // never recorded (or has been pruned).
    expect(validateActionToken(token)).toEqual({ ok: false, reason: 'unknown token' });
  });
});

describe('validateActionToken — single-use guarantee', () => {
  it('rejects the second validate of the same token as "already used"', () => {
    const token = generateActionToken('approve', USER_ID);

    const first = validateActionToken(token);
    const second = validateActionToken(token);

    expect(first).toEqual({ ok: true, handler: 'approve', userId: USER_ID });
    expect(second).toEqual({ ok: false, reason: 'already used' });
  });
});
