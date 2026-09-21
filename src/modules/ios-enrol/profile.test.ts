import { describe, expect, it } from 'vitest';
import { buildEnrolProfile, extractEnrolledDevice } from './profile';

const reply = (udid: string, product = 'iPhone14,5') =>
  `0\u0082signed-prefix<?xml version="1.0"?><plist><dict>
  <key>PRODUCT</key>
  <string>${product}</string>
  <key>UDID</key>
  <string>${udid}</string>
</dict></plist>signed-suffix`;

describe('extractEnrolledDevice', () => {
  it('reads a modern UDID out of the signed reply', () => {
    expect(extractEnrolledDevice(reply('00008110-000A1B2C3D4E801E'))).toEqual({
      udid: '00008110-000A1B2C3D4E801E',
      product: 'iPhone14,5',
    });
  });

  it('reads a 40-character UDID', () => {
    const udid = 'a'.repeat(40);
    expect(extractEnrolledDevice(reply(udid))?.udid).toBe(udid);
  });

  it('rejects a UDID of the wrong shape', () => {
    expect(extractEnrolledDevice(reply('not-a-udid'))).toBeNull();
    expect(extractEnrolledDevice(reply('00008110-000A1B2C3D4E801E"}\n{"x":1'))).toBeNull();
  });

  it('drops a product string of the wrong shape but keeps the device', () => {
    expect(extractEnrolledDevice(reply('00008110-000A1B2C3D4E801E', 'x y z'))).toEqual({
      udid: '00008110-000A1B2C3D4E801E',
      product: null,
    });
  });

  it('returns null when there is no UDID', () => {
    expect(extractEnrolledDevice('nothing here')).toBeNull();
  });
});

describe('buildEnrolProfile', () => {
  it('asks the device to post its UDID to the given URL', () => {
    const profile = buildEnrolProfile('https://example.test/ios/enrol?a=1&b=2');
    expect(profile).toContain('<string>https://example.test/ios/enrol?a=1&amp;b=2</string>');
    expect(profile).toContain('<string>Profile Service</string>');
    expect(profile).toContain('<string>UDID</string>');
  });

  it('gives each profile its own payload UUID', () => {
    const uuid = (p: string) => /PayloadUUID<\/key><string>([^<]+)/.exec(p)?.[1];
    expect(uuid(buildEnrolProfile('https://example.test'))).not.toBe(uuid(buildEnrolProfile('https://example.test')));
  });
});
