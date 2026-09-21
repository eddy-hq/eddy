#!/usr/bin/env node
// SPIKE: send one mutable push straight to APNs, to trigger the notification
// service extension on a device (brief §21, open question 4). No Eddy server
// involved. Reads the APNs auth key from gitignored ios/Config/apns.env:
//
//   APNS_KEY_PATH=/absolute/path/outside/the/repo/AuthKey_XXXX.p8
//   APNS_KEY_ID=<key id>
//   APNS_TEAM_ID=<team id>
//
//   node ios/scripts/spike-send-push.mjs <device-token>            # OTA (ad hoc) build
//   node ios/scripts/spike-send-push.mjs <device-token> --sandbox  # Xcode cable build
//
// Prints the APNs status only — never the token, key id or team id.
import { readFileSync } from 'node:fs';
import { createSign, randomUUID } from 'node:crypto';
import http2 from 'node:http2';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOPIC = 'app.eddyhq.Eddy';
const here = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const args = process.argv.slice(2);
const sandbox = args.includes('--sandbox');
const deviceToken = args.find((a) => !a.startsWith('--'));
if (!deviceToken || !/^[0-9a-f]{64,}$/i.test(deviceToken)) {
  console.error('usage: spike-send-push.mjs <device-token-hex> [--sandbox]');
  process.exit(2);
}

const env = loadEnv(path.join(here, '../Config/apns.env'));
for (const k of ['APNS_KEY_PATH', 'APNS_KEY_ID', 'APNS_TEAM_ID']) {
  if (!env[k]) {
    console.error(`ios/Config/apns.env is missing ${k}`);
    process.exit(2);
  }
}

const b64url = (v) => Buffer.from(v).toString('base64url');
const header = b64url(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID }));
const claims = b64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
const signature = createSign('SHA256')
  .update(`${header}.${claims}`)
  .sign({ key: readFileSync(env.APNS_KEY_PATH), dsaEncoding: 'ieee-p1363' })
  .toString('base64url');
const jwt = `${header}.${claims}.${signature}`;

// The shape stage 4 will send: an opaque id and placeholder copy, nothing else.
const payload = JSON.stringify({
  aps: { alert: { title: 'Eddy', body: 'Something new in Eddy' }, 'mutable-content': 1, sound: 'default' },
  m: randomUUID(),
});

const host = sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
const client = http2.connect(host);
client.on('error', (err) => {
  console.error(`connection failed: ${err.code ?? err.message}`);
  process.exit(1);
});
const req = client.request({
  ':method': 'POST',
  ':path': `/3/device/${deviceToken}`,
  authorization: `bearer ${jwt}`,
  'apns-topic': TOPIC,
  'apns-push-type': 'alert',
  'apns-priority': '10',
});
let status;
let body = '';
req.on('response', (h) => { status = h[':status']; });
req.on('data', (d) => { body += d; });
req.on('end', () => {
  const reason = body ? JSON.parse(body).reason : null;
  console.log(`${sandbox ? 'sandbox' : 'production'}: HTTP ${status}${reason ? ` — ${reason}` : ''} at ${new Date().toISOString()}`);
  client.close();
  process.exit(status === 200 ? 0 : 1);
});
req.end(payload);
