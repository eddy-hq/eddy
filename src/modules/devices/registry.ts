import crypto from 'crypto';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { NotFoundError } from '../../errors';

// The devices table's home. Everything that reads or writes a device row goes
// through here; the router validates, this file owns the SQL.

export type ApnsEnvironment = 'sandbox' | 'production';

export const APNS_ENVIRONMENTS: readonly ApnsEnvironment[] = ['sandbox', 'production'];
export const DEVICE_TYPES: readonly string[] = ['phone', 'tablet', 'tv', 'desktop'];

export interface DeviceRegistration {
  // Supplied by the app once it has one; the first registration leaves it out
  // and keeps the id we return.
  deviceId?: string;
  ownerUserId: string;
  displayName: string;
  deviceType: string;
  apnsToken: string;
  apnsEnvironment: ApnsEnvironment;
}

// The push identity, and nothing else — the sender has no business with the
// owner's name or the device's.
export interface PushDevice {
  deviceId: string;
  apnsToken: string;
  apnsEnvironment: ApnsEnvironment;
}

interface DeviceRow {
  device_id: string;
  owner_user_id: string;
}

// Short, non-reversible stand-in for a device token in a log line. A token is a
// credential: it is never logged whole.
export function tokenFingerprint(apnsToken: string): string {
  return crypto.createHash('sha256').update(apnsToken).digest('hex').slice(0, 8);
}

const INSERT_SQL = `
  INSERT INTO devices
    (device_id, display_name, owner_user_id, device_type, created_at, apns_token, apns_environment, last_seen_at)
  VALUES
    (@device_id, @display_name, @owner_user_id, @device_type, @now, @apns_token, @apns_environment, @now)
  ON CONFLICT(device_id) DO UPDATE SET
    display_name     = excluded.display_name,
    device_type      = excluded.device_type,
    apns_token       = excluded.apns_token,
    apns_environment = excluded.apns_environment,
    last_seen_at     = excluded.last_seen_at
`;

// Registers (or re-registers) a device and returns its id. Idempotent in both
// directions: the same device id re-registers in place, and a token already
// held by another row moves to this one rather than duplicating — a restored
// backup or a handed-down phone keeps APNs' "one token, one device" rule true.
// Re-registering a device id owned by someone else is a 404, not a takeover.
export function upsertDevice(registration: DeviceRegistration): string {
  const tx = db.transaction((reg: DeviceRegistration): string => {
    let deviceId = reg.deviceId;

    if (deviceId !== undefined) {
      const claimed = db
        .prepare('SELECT device_id, owner_user_id FROM devices WHERE device_id = ?')
        .get(deviceId) as DeviceRow | undefined;
      if (claimed && claimed.owner_user_id !== reg.ownerUserId) throw new NotFoundError('device');
    } else {
      const byToken = db
        .prepare('SELECT device_id, owner_user_id FROM devices WHERE apns_token = ?')
        .get(reg.apnsToken) as DeviceRow | undefined;
      // Only reuse the row when the owner matches; a token that has moved to
      // another household member starts a fresh row below, and the delete that
      // follows takes the stale one away.
      deviceId = byToken && byToken.owner_user_id === reg.ownerUserId ? byToken.device_id : uuidv7();
    }

    db.prepare('DELETE FROM devices WHERE apns_token = ? AND device_id <> ?').run(
      reg.apnsToken,
      deviceId
    );

    db.prepare(INSERT_SQL).run({
      device_id: deviceId,
      display_name: reg.displayName,
      owner_user_id: reg.ownerUserId,
      device_type: reg.deviceType,
      apns_token: reg.apnsToken,
      apns_environment: reg.apnsEnvironment,
      now: new Date().toISOString(),
    });

    return deviceId;
  });

  return tx(registration);
}

// Sign-out. A device may only be deleted by its owner; anyone else gets the
// same 404 as a device that does not exist.
export function deleteDevice(deviceId: string, ownerUserId: string): void {
  const result = db
    .prepare('DELETE FROM devices WHERE device_id = ? AND owner_user_id = ?')
    .run(deviceId, ownerUserId);
  if (result.changes === 0) throw new NotFoundError('device');
}

// Unconditional removal, for the one caller that has no user in hand: APNs
// telling the sender a token is dead.
export function forgetDevice(deviceId: string): void {
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
}

export function listPushDevices(userId: string): PushDevice[] {
  const rows = db
    .prepare(
      `SELECT device_id, apns_token, apns_environment
         FROM devices
        WHERE owner_user_id = ? AND apns_token IS NOT NULL AND apns_environment IS NOT NULL`
    )
    .all(userId) as Array<{
    device_id: string;
    apns_token: string;
    apns_environment: string;
  }>;

  return rows
    .filter((r): r is typeof r & { apns_environment: ApnsEnvironment } =>
      (APNS_ENVIRONMENTS as readonly string[]).includes(r.apns_environment)
    )
    .map((r) => ({
      deviceId: r.device_id,
      apnsToken: r.apns_token,
      apnsEnvironment: r.apns_environment,
    }));
}
