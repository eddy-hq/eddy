import { Router, Request, Response } from 'express';
import { logger } from '../../logger';
import { ValidationError } from '../../errors';
import {
  actorOf,
  credentialCookie,
  credentialFromHeaders,
  deviceIdOf,
  isSecureRequest,
  requireDevice,
} from './credential';
import { redeemInvite } from './enrolment';
import {
  registerPush,
  deleteDevice,
  tokenFingerprint,
  APNS_ENVIRONMENTS,
  DEVICE_TYPES,
  type ApnsEnvironment,
} from './registry';

export const devicesRouter = Router();

// Enrolment and the device's own row (ADR-0016). `POST /devices/enrol` is the
// one route here that takes no credential — it is how a device gets one.
// Everything else acts on the device the credential names, for the user who
// owns it; a `userId` in the request is checked by `requireDevice`, never
// trusted.
//
// A device token is a credential and a device identifier: it is never logged in
// full, only as a short hash prefix.

// APNs tokens are hex; 32 bytes historically, longer on newer iOS. Bound it
// rather than pin a length.
const TOKEN_REGEX = /^[0-9a-f]{64,200}$/i;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function deviceTypeFrom(value: unknown): string {
  const deviceType = value === undefined ? 'phone' : requiredString(value, 'deviceType');
  if (!DEVICE_TYPES.includes(deviceType)) {
    throw new ValidationError(`deviceType must be one of ${DEVICE_TYPES.join(', ')}`);
  }
  return deviceType;
}

// POST /devices/enrol — { invite, deviceType?, deliver?: 'cookie' | 'body' }
//
// The browser (and the shell's web view) takes the credential as an HttpOnly
// cookie and never sees it. The shell's native code asks for it in the body,
// keeps it in the Keychain for its extensions, and sets the same cookie on its
// web view itself.
devicesRouter.post('/enrol', (req: Request, res: Response) => {
  const body = req.body as { invite?: unknown; deviceType?: unknown; deliver?: unknown };
  const invite = requiredString(body.invite, 'invite');
  const deviceType = deviceTypeFrom(body.deviceType);
  const deliver = body.deliver === undefined ? 'cookie' : body.deliver;
  if (deliver !== 'cookie' && deliver !== 'body') {
    throw new ValidationError("deliver must be 'cookie' or 'body'");
  }

  const enrolment = redeemInvite(invite, deviceType);

  res.setHeader('Set-Cookie', credentialCookie(enrolment.credential, isSecureRequest(req)));
  res.status(200).json({
    deviceId: enrolment.deviceId,
    userId: enrolment.userId,
    displayName: enrolment.displayName,
    ...(deliver === 'body' ? { credential: enrolment.credential } : {}),
  });
});

// GET /devices/me — who this device acts as. The PWA's first call: a 401 means
// "show the setup screen", a 200 tells it whose app it is. Re-issues the cookie
// so a browser in daily use never reaches the cookie's expiry.
devicesRouter.get('/me', requireDevice, (req: Request, res: Response) => {
  const actor = actorOf(req);
  if (!req.get('authorization')) {
    const fromCookie = credentialFromHeaders({ cookie: req.get('cookie') });
    if (fromCookie) res.setHeader('Set-Cookie', credentialCookie(fromCookie, isSecureRequest(req)));
  }
  res.status(200).json({
    deviceId: deviceIdOf(req),
    userId: actor.user_id,
    displayName: actor.display_name,
    role: actor.role,
  });
});

// POST /devices — attach this device's push identity to its own row.
devicesRouter.post('/', requireDevice, (req: Request, res: Response) => {
  const body = req.body as {
    deviceType?: unknown;
    apnsToken?: unknown;
    apnsEnvironment?: unknown;
  };
  const actor = actorOf(req);
  const deviceId = deviceIdOf(req);

  const apnsToken = requiredString(body.apnsToken, 'apnsToken');
  if (!TOKEN_REGEX.test(apnsToken)) throw new ValidationError('apnsToken must be hex');

  const apnsEnvironment = requiredString(body.apnsEnvironment, 'apnsEnvironment');
  if (!(APNS_ENVIRONMENTS as readonly string[]).includes(apnsEnvironment)) {
    throw new ValidationError("apnsEnvironment must be 'sandbox' or 'production'");
  }

  registerPush(deviceId, {
    apnsToken,
    apnsEnvironment: apnsEnvironment as ApnsEnvironment,
    deviceType: deviceTypeFrom(body.deviceType),
  });

  logger.info(
    { deviceId, userId: actor.user_id, apnsEnvironment, token: tokenFingerprint(apnsToken) },
    'Device registered for push'
  );

  res.status(200).json({ deviceId });
});

// DELETE /devices/:deviceId — sign-out. Deleting the row revokes its
// credential. Owner-only; anyone else sees the same 404 as a missing device.
// `DELETE /devices/me` is the calling device's own row: the iOS shell's
// Disconnect, which knows its credential but not necessarily its row id.
devicesRouter.delete('/:deviceId', requireDevice, (req: Request, res: Response) => {
  const actor = actorOf(req);
  const param = requiredString(req.params['deviceId'], 'deviceId');
  const deviceId = param === 'me' ? deviceIdOf(req) : param;

  deleteDevice(deviceId, actor.user_id);

  logger.info({ deviceId, userId: actor.user_id }, 'Device removed');
  res.status(204).end();
});
