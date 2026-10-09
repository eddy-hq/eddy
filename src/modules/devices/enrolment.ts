import { ForbiddenError } from '../../errors';
import { logger } from '../../logger';
import { generateActionToken, validateActionToken } from '../notifications';
import { resolveUserById, resolveUserByIdOrName } from '../users';
import { hashCredential, mintCredential } from './credential';
import { enrolDevice } from './registry';

// Who vouches for a device the first time (ADR-0016): whoever holds a shell on
// the M4. An invite is an ADR-0005 signed token — HMAC over the user and an
// expiry, recorded in `used_tokens`, one hour, single use — minted by
// `npm run devices -- invite <user>` and opened on the device being set up.
// Redeeming it creates the device row and hands back the credential.

export const INVITE_HANDLER = 'enrol';

export interface Enrolment {
  deviceId: string;
  userId: string;
  displayName: string;
  credential: string;
}

// `user` is an id or a display name: the operator types it at a terminal.
export function createInvite(user: string): { token: string; userId: string; displayName: string } {
  const row = resolveUserByIdOrName(user);
  return {
    token: generateActionToken(INVITE_HANDLER, row.user_id),
    userId: row.user_id,
    displayName: row.display_name,
  };
}

// One message for every way an invite can fail. Which way it failed is logged;
// the person holding the device only needs to know to ask for a new link.
const REJECTED = 'This setup link has expired or has already been used. Ask a parent for a new one.';

export function redeemInvite(token: string, deviceType: string): Enrolment {
  const result = validateActionToken(token);
  if (!result.ok) {
    logger.info({ reason: result.reason }, 'Device invite rejected');
    throw new ForbiddenError(REJECTED);
  }
  if (result.handler !== INVITE_HANDLER) {
    // A notification action token is signed with the same key; it is not an
    // invite, and redeeming it here has already spent it — which is the right
    // outcome for a token that turned up somewhere it shouldn't.
    logger.warn({ handler: result.handler }, 'Non-invite token presented as an invite');
    throw new ForbiddenError(REJECTED);
  }

  const user = resolveUserById(result.userId);
  const credential = mintCredential();
  const deviceId = enrolDevice({
    ownerUserId: user.user_id,
    deviceType,
    credentialHash: hashCredential(credential),
  });

  logger.info({ deviceId, userId: user.user_id, deviceType }, 'Device enrolled');
  return { deviceId, userId: user.user_id, displayName: user.display_name, credential };
}
