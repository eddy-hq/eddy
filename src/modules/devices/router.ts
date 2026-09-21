import { Router, Request, Response } from 'express';
import { logger } from '../../logger';
import { ValidationError } from '../../errors';
import { resolveUserById } from '../users';
import {
  upsertDevice,
  deleteDevice,
  tokenFingerprint,
  APNS_ENVIRONMENTS,
  DEVICE_TYPES,
  type ApnsEnvironment,
} from './registry';

export const devicesRouter = Router();

// Identity is the same `userId` UUID every other router resolves — this is an
// app-only route, so the UUID-only lookup (not the display-name convenience the
// share sheet needs) is the right one.
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

// POST /devices — register or re-register this device's push identity.
devicesRouter.post('/', (req: Request, res: Response) => {
  const body = req.body as {
    userId?: unknown;
    deviceId?: unknown;
    displayName?: unknown;
    deviceType?: unknown;
    apnsToken?: unknown;
    apnsEnvironment?: unknown;
  };

  const user = resolveUserById(body.userId);

  const apnsToken = requiredString(body.apnsToken, 'apnsToken');
  if (!TOKEN_REGEX.test(apnsToken)) throw new ValidationError('apnsToken must be hex');

  const apnsEnvironment = requiredString(body.apnsEnvironment, 'apnsEnvironment');
  if (!(APNS_ENVIRONMENTS as readonly string[]).includes(apnsEnvironment)) {
    throw new ValidationError("apnsEnvironment must be 'sandbox' or 'production'");
  }

  const deviceType = body.deviceType === undefined ? 'phone' : requiredString(body.deviceType, 'deviceType');
  if (!DEVICE_TYPES.includes(deviceType)) {
    throw new ValidationError(`deviceType must be one of ${DEVICE_TYPES.join(', ')}`);
  }

  // Optional on purpose: the app has no reason to send us what the household
  // calls a phone, so the default is generic.
  const displayName =
    body.displayName === undefined ? `Eddy on ${deviceType}` : requiredString(body.displayName, 'displayName');

  const deviceId = upsertDevice({
    deviceId: body.deviceId === undefined ? undefined : requiredString(body.deviceId, 'deviceId'),
    ownerUserId: user.user_id,
    displayName,
    deviceType,
    apnsToken,
    apnsEnvironment: apnsEnvironment as ApnsEnvironment,
  });

  logger.info(
    { deviceId, userId: user.user_id, apnsEnvironment, token: tokenFingerprint(apnsToken) },
    'Device registered for push'
  );

  res.status(200).json({ deviceId });
});

// DELETE /devices/:deviceId — sign-out, or the app discarding an invalidated
// token. Owner-only; anyone else sees the same 404 as a missing device.
devicesRouter.delete('/:deviceId', (req: Request, res: Response) => {
  const { userId } = req.query as { userId?: unknown };
  const user = resolveUserById(userId);
  const deviceId = requiredString(req.params['deviceId'], 'deviceId');

  deleteDevice(deviceId, user.user_id);

  logger.info({ deviceId, userId: user.user_id }, 'Device removed');
  res.status(204).end();
});
