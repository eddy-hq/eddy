import crypto from 'crypto';

// A "Profile Service" payload: installing it makes the device POST its own
// attributes to `URL`, signed, and then forget the profile. It is how a device
// that cannot be cabled to a Mac reports the UDID an ad hoc profile needs.
export function buildEnrolProfile(enrolUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key><string>${escapeXml(enrolUrl)}</string>
    <key>DeviceAttributes</key>
    <array><string>UDID</string><string>PRODUCT</string></array>
  </dict>
  <key>PayloadOrganization</key><string>Eddy</string>
  <key>PayloadDisplayName</key><string>Eddy device registration</string>
  <key>PayloadDescription</key><string>Tells the Eddy server at home this device's identifier, so the Eddy app can be signed for it. Installs nothing.</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadUUID</key><string>${crypto.randomUUID()}</string>
  <key>PayloadIdentifier</key><string>app.eddyhq.enrol</string>
  <key>PayloadType</key><string>Profile Service</string>
</dict>
</plist>
`;
}

export interface EnrolledDevice {
  udid: string;
  product: string | null;
}

// Both shapes Apple has used: 40 hex characters, and 8-16 with a dash.
const UDID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{8}-[0-9a-fA-F]{16})$/;
const PRODUCT_PATTERN = /^[A-Za-z]+\d+,\d+$/;

// The device's reply is a CMS-signed blob with the plist in the clear inside
// it. The signature is not checked — the UDID is only a candidate for the
// developer portal, and a person registers it — so the two values are lifted
// out by pattern and validated by shape.
export function extractEnrolledDevice(body: string): EnrolledDevice | null {
  const udid = /<key>UDID<\/key>\s*<string>([^<]+)<\/string>/.exec(body)?.[1];
  if (!udid || !UDID_PATTERN.test(udid)) return null;
  const product = /<key>PRODUCT<\/key>\s*<string>([^<]+)<\/string>/.exec(body)?.[1];
  return { udid, product: product && PRODUCT_PATTERN.test(product) ? product : null };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
