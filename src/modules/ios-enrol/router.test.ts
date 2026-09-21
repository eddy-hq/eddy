import fs from 'fs';
import path from 'path';
import express from 'express';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above the imports, so the temp root is named without them.
const root = vi.hoisted(() => `${process.env['TMPDIR'] ?? '/tmp'}/eddy-enrol-${process.pid}`);

vi.mock('../../config', () => ({ config: { IOS_DIST_PATH: path.join(root, 'ios') } }));
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { iosEnrolRouter, enrolledDevicesPath } from './router';

const app = express();
app.use(express.json());
app.use('/ios', iosEnrolRouter);

const signedReply = (udid: string) =>
  Buffer.from(`\x30\x82junk<plist><dict><key>PRODUCT</key><string>iPhone14,5</string><key>UDID</key><string>${udid}</string></dict></plist>junk`, 'latin1');

beforeEach(() => fs.rmSync(enrolledDevicesPath(), { force: true }));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('iosEnrolRouter', () => {
  it('serves a profile that posts back to the host it was fetched from', async () => {
    const res = await supertest(app)
      .get('/ios/enrol.mobileconfig')
      .set('Host', 'eddy.example.test')
      .set('X-Forwarded-Proto', 'https');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-apple-aspen-config');
    expect(res.text).toContain('<string>https://eddy.example.test/ios/enrol</string>');
  });

  it('records the UDID beside the served directory, not inside it', async () => {
    const res = await supertest(app)
      .post('/ios/enrol')
      .set('Content-Type', 'application/pkcs7-signature')
      .send(signedReply('00008110-000A1B2C3D4E801E'));
    expect(res.status).toBe(301);
    expect(res.headers['location']).toBe('/ios/enrolled');

    const lines = fs.readFileSync(enrolledDevicesPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ udid: '00008110-000A1B2C3D4E801E', product: 'iPhone14,5' });
    expect(enrolledDevicesPath().startsWith(path.join(root, 'ios') + path.sep)).toBe(false);
  });

  it('writes nothing for a reply without a usable UDID', async () => {
    const res = await supertest(app)
      .post('/ios/enrol')
      .set('Content-Type', 'application/pkcs7-signature')
      .send(signedReply('nope'));
    expect(res.headers['location']).toBe('/ios/enrol');
    expect(fs.existsSync(enrolledDevicesPath())).toBe(false);
  });
});
