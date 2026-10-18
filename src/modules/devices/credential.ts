import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthenticatedError } from '../../errors';
import { logger } from '../../logger';
import { resolveUserById, type UserRow } from '../users';
import { findDeviceByCredentialHash } from './registry';

// The acting user comes from the device credential, never from the request
// body or query string (ADR-0016).
//
// A credential is 32 random bytes, base64url. The browser carries it in an
// HttpOnly cookie; the iOS shell's native code sends it as a bearer token, and
// injects the same cookie into its web view. The server stores only its hash.

export const CREDENTIAL_COOKIE = 'eddy_device';

// Chrome caps a cookie's lifetime at 400 days whatever Max-Age says, so the
// cookie is re-issued on every GET /devices/me (the PWA's boot call) and a
// device in use never ages out.
export const CREDENTIAL_COOKIE_MAX_AGE_SECS = 400 * 24 * 60 * 60;

// The identity keys a client may still send. Older clients put the acting user
// in every request; it is now a claim to check, not an identity to trust.
export const IDENTITY_KEYS = ['userId', 'user'] as const;

const CREDENTIAL_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function mintCredential(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashCredential(credential: string): string {
  return crypto.createHash('sha256').update(credential).digest('hex');
}

// Bearer header first (the shell's native requests), then the cookie (the
// browser and the shell's web view). Anything not shaped like a credential is
// treated as absent rather than looked up.
export function credentialFromHeaders(headers: {
  authorization?: string | undefined;
  cookie?: string | undefined;
}): string | null {
  const auth = headers.authorization;
  if (auth) {
    const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    return match && CREDENTIAL_SHAPE.test(match[1]!) ? match[1]! : null;
  }

  for (const part of (headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== CREDENTIAL_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return CREDENTIAL_SHAPE.test(value) ? value : null;
  }
  return null;
}

export function credentialCookie(credential: string, secure: boolean): string {
  return [
    `${CREDENTIAL_COOKIE}=${credential}`,
    'Path=/',
    `Max-Age=${CREDENTIAL_COOKIE_MAX_AGE_SECS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

// Every identity claim in the request, from either place a client has ever
// put one. Repeated query keys arrive as arrays and are flattened, so
// `?userId=me&userId=someone-else` can't slip the second past the check.
export function identityClaims(query: unknown, body: unknown): unknown[] {
  const claims: unknown[] = [];
  for (const source of [query, body]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of IDENTITY_KEYS) {
      const value = (source as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (Array.isArray(value)) claims.push(...value);
      else claims.push(value);
    }
  }
  return claims;
}

// A claim names the actor by id or, for the older share-sheet path, by display
// name. Either way it can only ever agree with the credential.
export function claimMatchesActor(
  claim: unknown,
  actor: Pick<UserRow, 'user_id' | 'display_name'>
): boolean {
  if (typeof claim !== 'string') return false;
  const value = claim.trim().toLowerCase();
  return value === actor.user_id.toLowerCase() || value === actor.display_name.toLowerCase();
}

interface Binding {
  actor: UserRow;
  deviceId: string;
}

const bindings = new WeakMap<Request, Binding>();

// Exposed so tests that exercise a router directly can stand in for the
// credential lookup. Production code binds only through `requireDevice`.
export function bindActor(req: Request, actor: UserRow, deviceId: string): void {
  bindings.set(req, { actor, deviceId });
}

export function isSecureRequest(req: Request): boolean {
  return req.secure || req.get('x-forwarded-proto') === 'https';
}

// Resolves the credential to its device and owner, then refuses any request
// whose own identity claims disagree. 401 with no usable credential, 403 for a
// mismatched claim — a device set up for one person can't ask as another.
export function requireDevice(req: Request, _res: Response, next: NextFunction): void {
  try {
    const binding = authenticate(req);
    const mismatch = identityClaims(req.query, req.body).some(
      (c) => !claimMatchesActor(c, binding.actor)
    );
    if (mismatch) {
      // The device and the path, never the claimed value: it may be another
      // household member's id.
      logger.warn({ deviceId: binding.deviceId, path: req.path }, 'Request claimed a different user');
      throw new ForbiddenError('This device is set up for someone else');
    }
    bindings.set(req, binding);
    next();
  } catch (err) {
    next(err);
  }
}

// For routes that are parent-only throughout and name a household member as
// the *subject*, not the actor (the discovery preview's `?user=`). The actor
// still comes from the credential and must be a parent; the claim check is
// what doesn't apply.
export function requireParentDevice(req: Request, _res: Response, next: NextFunction): void {
  try {
    const binding = authenticate(req);
    if (binding.actor.role !== 'parent') throw new ForbiddenError('This is for parents only');
    bindings.set(req, binding);
    next();
  } catch (err) {
    next(err);
  }
}

// Why a request was refused, for diagnosing a client that sends the wrong
// thing. Never the credential: at most the first 8 hex characters of its
// hash, enough to tell two clients' credentials apart and to match a
// device row, not enough to stand in for one.
function logRefused(req: Request, reason: string, hashPrefix?: string): void {
  logger.warn({ method: req.method, path: req.path, reason, hashPrefix }, 'Credential refused');
}

function authenticate(req: Request): Binding {
  const authorization = req.get('authorization');
  const credential = credentialFromHeaders({ authorization, cookie: req.get('cookie') });
  if (!credential) {
    logRefused(req, authorization ? 'bearer_malformed' : 'missing_or_malformed_cookie');
    throw new UnauthenticatedError();
  }

  const hash = hashCredential(credential);
  const device = findDeviceByCredentialHash(hash);
  if (!device) {
    logRefused(req, authorization ? 'bearer_unknown' : 'cookie_unknown', hash.slice(0, 8));
    throw new UnauthenticatedError();
  }

  return { actor: resolveUserById(device.ownerUserId), deviceId: device.deviceId };
}

export function actorOf(req: Request): UserRow {
  const binding = bindings.get(req);
  if (!binding) throw new UnauthenticatedError();
  return binding.actor;
}

export function deviceIdOf(req: Request): string {
  const binding = bindings.get(req);
  if (!binding) throw new UnauthenticatedError();
  return binding.deviceId;
}

// The parent-only routes' role check, against the credential's owner.
export function requireParentActor(req: Request): UserRow {
  const actor = actorOf(req);
  if (actor.role !== 'parent') throw new ForbiddenError('This is for parents only');
  return actor;
}
