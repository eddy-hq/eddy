#!/usr/bin/env tsx
/**
 * npm run devices -- invite <user id | display name> [--base <Eddy address>]
 * npm run devices -- list
 * npm run devices -- revoke <device id>
 *
 * Device enrolment from the M4's shell (ADR-0016). `invite` prints a one-hour,
 * single-use setup link for that household member; open it on the device being
 * set up (a browser, or paste it into the iOS shell's setup screen). `list`
 * shows every device row and whether it is enrolled; `revoke` deletes one, and
 * its credential stops working on the next request.
 *
 * Run it on the M4: it signs with the server's TOKEN_SECRET and writes to the
 * server's database.
 */
import 'dotenv/config';
import { runMigrations } from '../db/migrate';
import { createInvite, listDevices, revokeDevice } from '../modules/devices';

/* eslint-disable no-console */

const USAGE = `Usage:
  npm run devices -- invite <user id | display name> [--base <Eddy address, e.g. https://eddy.example>]
  npm run devices -- list
  npm run devices -- revoke <device id>`;

function invite(args: string[]): void {
  const baseAt = args.indexOf('--base');
  const base = baseAt === -1 ? null : args[baseAt + 1];
  if (baseAt !== -1 && !base) throw new Error('--base needs an address');
  const user = (baseAt === -1 ? args : args.filter((_, i) => i !== baseAt && i !== baseAt + 1))[0];
  if (!user) throw new Error(USAGE);

  const { token, displayName } = createInvite(user);
  const path = `/setup?invite=${token}`;
  console.log(`Setup link for ${displayName} — single use, expires in one hour:`);
  console.log(base ? `${base.replace(/\/+$/, '')}${path}` : path);
  if (!base) console.log('(Append it to the address you open Eddy at, or pass --base.)');
}

function list(): void {
  const rows = listDevices();
  if (rows.length === 0) {
    console.log('No devices.');
    return;
  }
  for (const r of rows) {
    const state = [r.enrolled ? 'enrolled' : 'push-only, not enrolled', r.push ? 'push' : null]
      .filter(Boolean)
      .join(', ');
    console.log(`${r.deviceId}  owner ${r.ownerUserId}  ${r.deviceType}  ${state}  created ${r.createdAt}`);
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  runMigrations();
  switch (command) {
    case 'invite':
      invite(rest);
      return;
    case 'list':
      list();
      return;
    case 'revoke': {
      const deviceId = rest[0];
      if (!deviceId) throw new Error(USAGE);
      revokeDevice(deviceId);
      console.log(`Revoked ${deviceId}.`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
