import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { config } from '../../config';
import { logger } from '../../logger';
import { buildEnrolProfile, extractEnrolledDevice } from './profile';

// Cable-free device registration for the iOS shell (ios/README.md). Mounted at
// /ios ahead of the static release directory. Tailnet-only like everything
// else, and unauthenticated: the worst a caller can do is add a line to a small
// file that a person reads before registering anything.

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 64 * 1024;

// Beside the served directory, not in it — /ios is a static mount.
export const enrolledDevicesPath = (): string =>
  path.join(path.dirname(config.IOS_DIST_PATH), 'ios-enrolled.jsonl');

export const iosEnrolRouter = Router();

iosEnrolRouter.get('/enrol', (_req: Request, res: Response) => {
  res.type('html').send(
    page(
      'Register this device',
      'Tap below and allow the download. Then open Settings, tap Profile Downloaded at the top, and install it.',
      '<a class="go" href="enrol.mobileconfig">Get profile</a>'
    )
  );
});

iosEnrolRouter.get('/enrol.mobileconfig', (req: Request, res: Response) => {
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  const enrolUrl = `${proto}://${req.get('host')}/ios/enrol`;
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/x-apple-aspen-config').send(buildEnrolProfile(enrolUrl));
});

iosEnrolRouter.post('/enrol', (req: Request, res: Response) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  });
  req.on('end', () => {
    const device = size <= MAX_BODY_BYTES ? extractEnrolledDevice(Buffer.concat(chunks).toString('latin1')) : null;
    if (device) {
      const file = enrolledDevicesPath();
      const existing = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (existing < MAX_FILE_BYTES) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify({ ...device, at: new Date().toISOString() })}\n`);
      }
      logger.info({ product: device.product }, 'iOS device enrolled');
    } else {
      logger.warn({ size }, 'iOS enrol POST carried no usable UDID');
    }
    // iOS follows the redirect in Safari once the profile step finishes.
    res.redirect(301, device ? '/ios/enrolled' : '/ios/enrol');
  });
});

iosEnrolRouter.get('/enrolled', (_req: Request, res: Response) => {
  res.type('html').send(
    page('Done', 'Eddy has this device now. Once it has been added to the next release, install from the Eddy install page.', '')
  );
});

function page(title: string, body: string, action: string): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font: 17px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 48px 24px;
         background: #111; color: #eee; text-align: center; }
  a.go { display: inline-block; margin: 24px 0; padding: 14px 28px; border-radius: 12px;
         background: #eee; color: #111; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<h1>${title}</h1>
<p>${body}</p>
${action}
</body>
</html>`;
}
