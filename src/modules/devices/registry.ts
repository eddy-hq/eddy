import crypto from 'crypto';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { NotFoundError } from '../../errors';

// The devices table's home. Everything that reads or writes a device row goes
// through here; the routers validate, this file owns the SQL.
//
// A row is one enrolled device (ADR-0016): who it belongs to, the hash of the
// credential it presents, and — once the iOS shell has registered for push —
// its APNs token. Rows from before enrolment existed carry a token and no
// credential; they still receive pushes and never authenticate.

export type ApnsEnvironment = 'sandbox' | 'production';

export const APNS_ENVIRONMENTS: readonly ApnsEnvironment[] = ['sandbox', 'production'];
export const DEVICE_TYPES: readonly string[] = ['phone', 'tablet', 'tv', 'desktop'];

export interface PushRegistration {
  apnsToken: string;
  apnsEnvironment: ApnsEnvironment;
  deviceType: string;
}

// The push identity, and nothing else — the sender has no business with the
// owner's name or the device's.
export interface PushDevice {
  deviceId: string;
  apnsToken: string;
  apnsEnvironment: ApnsEnvironment;
}

export interface CredentialedDevice {
  deviceId: string;
  ownerUserId: string;
}

export interface DeviceSummary {
  deviceId: string;
  ownerUserId: string;
  displayName: string;
  deviceType: string;
  enrolled: boolean;
  push: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

// Short, non-reversible stand-in for a device token in a log line. A token is a
// credential: it is never logged whole.
export function tokenFingerprint(apnsToken: string): string {
  return crypto.createHash('sha256').update(apnsToken).digest('hex').slice(0, 8);
}

// A new enrolled device. The caller has already checked the invite; this only
// writes the row.
export function enrolDevice(input: {
  ownerUserId: string;
  deviceType: string;
  credentialHash: string;
}): string {
  const deviceId = uuidv7();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO devices
       (device_id, display_name, owner_user_id, device_type, created_at, last_seen_at, credential_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(deviceId, `Eddy on ${input.deviceType}`, input.ownerUserId, input.deviceType, now, now, input.credentialHash);
  return deviceId;
}

export function findDeviceByCredentialHash(credentialHash: string): CredentialedDevice | undefined {
  const row = db
    .prepare('SELECT device_id, owner_user_id FROM devices WHERE credential_hash = ?')
    .get(credentialHash) as { device_id: string; owner_user_id: string } | undefined;
  return row ? { deviceId: row.device_id, ownerUserId: row.owner_user_id } : undefined;
}

// Attaches (or refreshes) the APNs token on an enrolled device's own row. APNs
// guarantees one token, one device, so a token already held elsewhere — a
// restored backup, a handed-down phone, or the device's own pre-enrolment
// push-only row — comes off that row first. A credentialed row keeps its
// credential and just loses the token; a push-only row has nothing else worth
// keeping and goes.
export function registerPush(deviceId: string, registration: PushRegistration): void {
  db.transaction(() => {
    db.prepare(
      'DELETE FROM devices WHERE apns_token = ? AND device_id <> ? AND credential_hash IS NULL'
    ).run(registration.apnsToken, deviceId);
    db.prepare(
      `UPDATE devices SET apns_token = NULL, apns_environment = NULL
        WHERE apns_token = ? AND device_id <> ?`
    ).run(registration.apnsToken, deviceId);

    const result = db
      .prepare(
        `UPDATE devices
            SET apns_token = ?, apns_environment = ?, device_type = ?,
                display_name = ?, last_seen_at = ?
          WHERE device_id = ?`
      )
      .run(
        registration.apnsToken,
        registration.apnsEnvironment,
        registration.deviceType,
        `Eddy on ${registration.deviceType}`,
        new Date().toISOString(),
        deviceId
      );
    if (result.changes === 0) throw new NotFoundError('device');
  })();
}

// Sign-out. A device may only be deleted by its owner; anyone else gets the
// same 404 as a device that does not exist. Deleting the row revokes its
// credential.
export function deleteDevice(deviceId: string, ownerUserId: string): void {
  const result = db
    .prepare('DELETE FROM devices WHERE device_id = ? AND owner_user_id = ?')
    .run(deviceId, ownerUserId);
  if (result.changes === 0) throw new NotFoundError('device');
}

// For the one caller that has no user in hand: APNs telling the sender a token
// is dead. The push identity goes; an enrolled device stays signed in, and
// re-registers a fresh token next time the app is opened.
export function forgetDevice(deviceId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM devices WHERE device_id = ? AND credential_hash IS NULL').run(deviceId);
    db.prepare(
      'UPDATE devices SET apns_token = NULL, apns_environment = NULL WHERE device_id = ?'
    ).run(deviceId);
  })();
}

// Operator revocation, from the M4's shell (src/scripts/devices.ts).
export function revokeDevice(deviceId: string): void {
  const result = db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
  if (result.changes === 0) throw new NotFoundError('device');
}

export function listDevices(): DeviceSummary[] {
  const rows = db
    .prepare(
      `SELECT device_id, owner_user_id, display_name, device_type, created_at, last_seen_at,
              credential_hash IS NOT NULL AS enrolled, apns_token IS NOT NULL AS push
         FROM devices
        ORDER BY owner_user_id, created_at`
    )
    .all() as Array<{
    device_id: string;
    owner_user_id: string;
    display_name: string;
    device_type: string;
    created_at: string;
    last_seen_at: string | null;
    enrolled: number;
    push: number;
  }>;
  return rows.map((r) => ({
    deviceId: r.device_id,
    ownerUserId: r.owner_user_id,
    displayName: r.display_name,
    deviceType: r.device_type,
    enrolled: r.enrolled === 1,
    push: r.push === 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }));
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
