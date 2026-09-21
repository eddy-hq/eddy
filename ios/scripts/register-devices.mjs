#!/usr/bin/env node
// Registers devices with the developer account through the App Store Connect
// API, so nobody has to paste UDIDs into the portal. Sources, all optional:
//
//   - devices that enrolled themselves at <server>/ios/enrol (no cable needed;
//     the server appends them to ios-enrolled.jsonl beside IOS_DIST_PATH)
//   - devices cabled to this Mac and trusted, as `xcrun devicectl` sees them
//   - UDIDs given as arguments
//
//   ios/scripts/register-devices.mjs [udid ...]
//
// Needs Config/release.env (see release.env.example) with an Admin key.
// Prints only the tail of each UDID. Run release-adhoc.sh afterwards: an ad hoc
// profile only covers devices that existed when it was generated.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(projectDir, 'Config/release.env');
if (!fs.existsSync(envFile)) {
  console.error('Missing Config/release.env — copy release.env.example and fill it in.');
  process.exit(1);
}
const env = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').split('\n')
    .filter((line) => /^\s*[A-Z_]+=/.test(line))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);
const keyPath = (env.ASC_KEY_PATH ?? '').replace(/^(~|\$HOME)/, os.homedir());
if (!fs.existsSync(keyPath) || !env.ASC_KEY_ID || !env.ASC_ISSUER_ID) {
  console.error('Config/release.env needs a readable ASC_KEY_PATH plus ASC_KEY_ID and ASC_ISSUER_ID.');
  process.exit(1);
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' })}.${b64({ iss: env.ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: fs.readFileSync(keyPath), dsaEncoding: 'ieee-p1363' }).toString('base64url');
const headers = { Authorization: `Bearer ${unsigned}.${signature}`, 'Content-Type': 'application/json' };
const api = 'https://api.appstoreconnect.apple.com/v1/devices';

const tail = (udid) => `…${udid.slice(-4)}`;
const candidates = new Map(); // udid -> where it came from

for (const udid of process.argv.slice(2)) candidates.set(udid, 'argument');

const distPath = process.env.IOS_DIST_PATH ?? path.join(os.homedir(), 'data/eddy/ios');
const enrolledFile = path.join(path.dirname(distPath), 'ios-enrolled.jsonl');
if (fs.existsSync(enrolledFile)) {
  for (const line of fs.readFileSync(enrolledFile, 'utf8').split('\n').filter(Boolean)) {
    try {
      const { udid, product } = JSON.parse(line);
      if (udid && !candidates.has(udid)) candidates.set(udid, `enrolled ${product ?? ''}`.trim());
    } catch {
      // a malformed line is somebody poking the endpoint; skip it
    }
  }
}

try {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eddy-devices-')), 'devices.json');
  execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], { stdio: 'ignore' });
  for (const device of JSON.parse(fs.readFileSync(out, 'utf8')).result.devices) {
    const hw = device.hardwareProperties ?? {};
    if (hw.platform === 'iOS' && hw.udid && !candidates.has(hw.udid)) candidates.set(hw.udid, `cabled ${hw.productType ?? ''}`.trim());
  }
} catch {
  console.log('devicectl unavailable — skipping cabled devices');
}

const listed = await (await fetch(`${api}?limit=200`, { headers })).json();
if (!listed.data) {
  console.error('Could not list devices:', listed.errors?.map((e) => e.detail).join('; '));
  process.exit(1);
}
const known = new Set(listed.data.map((d) => d.attributes.udid));
console.log(`Registered before: ${known.size}`);

let count = known.size;
for (const [udid, source] of candidates) {
  if (known.has(udid)) {
    console.log(`  ${tail(udid)} (${source}): already registered`);
    continue;
  }
  count += 1;
  const res = await fetch(api, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: { type: 'devices', attributes: { name: `Eddy device ${count}`, platform: 'IOS', udid } } }),
  });
  const body = await res.json();
  console.log(`  ${tail(udid)} (${source}): ${res.ok ? `registered, ${body.data.attributes.status}` : `failed — ${body.errors?.map((e) => e.detail).join('; ')}`}`);
}
if (candidates.size === 0) console.log('  nothing to register');
