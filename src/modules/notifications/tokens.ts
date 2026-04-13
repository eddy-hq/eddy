import crypto from 'crypto';
import { config } from '../../config';
import { db } from '../../db/client';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Generates a short-lived signed action token and records its hash in used_tokens.
// handler: identifies which endpoint processes the action (e.g. 'approve', 'deny')
export function generateActionToken(handler: string, userId: string): string {
  const expires = Date.now() + TOKEN_TTL_MS;
  const payload = `${handler}:${userId}:${expires}`;
  const sig = crypto
    .createHmac('sha256', config.TOKEN_SECRET)
    .update(payload)
    .digest('hex');
  const token = `${Buffer.from(payload).toString('base64url')}.${sig}`;

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare(
    'INSERT OR IGNORE INTO used_tokens (token_hash, handler, user_id, used_at) VALUES (?, ?, ?, ?)'
  ).run(hash, handler, userId, new Date(expires).toISOString()); // used_at holds expiry until redeemed

  return token;
}

export type TokenValidationResult =
  | { ok: true; handler: string; userId: string }
  | { ok: false; reason: string };

export function validateActionToken(token: string): TokenValidationResult {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return { ok: false, reason: 'malformed' };

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString();
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const parts = payload.split(':');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [handler, userId, expiresStr] = parts as [string, string, string];

  // Verify signature
  const expected = crypto
    .createHmac('sha256', config.TOKEN_SECRET)
    .update(payload)
    .digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
      return { ok: false, reason: 'invalid signature' };
    }
  } catch {
    return { ok: false, reason: 'invalid signature' };
  }

  // Check expiry
  if (Date.now() > parseInt(expiresStr, 10)) {
    return { ok: false, reason: 'expired' };
  }

  // Check single-use: mark used now, reject if already used
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare('SELECT used_at FROM used_tokens WHERE token_hash = ?').get(hash) as
    | { used_at: string }
    | undefined;

  if (!row) return { ok: false, reason: 'unknown token' };

  // If used_at is in the past (already redeemed), reject
  const usedAt = new Date(row.used_at).getTime();
  const expiry = parseInt(expiresStr, 10);
  if (usedAt < expiry - TOKEN_TTL_MS + 1000) {
    // already redeemed (used_at was updated to actual use time)
    return { ok: false, reason: 'already used' };
  }

  // Mark as redeemed
  db.prepare('UPDATE used_tokens SET used_at = ? WHERE token_hash = ?').run(
    new Date().toISOString(),
    hash
  );

  return { ok: true, handler, userId };
}
