// Device identity in the PWA (ADR-0016). The server knows who this device is
// from its credential cookie; the PWA still carries `?userId=` in the URL
// because every page reads it from there. These helpers keep the two agreeing,
// and pull a setup invite out of whatever a person pastes.

// An invite is an ADR-0005 signed token: base64url payload, a dot, a hex HMAC.
const INVITE_SHAPE = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;

// The invite in a URL's query string, if it carries a well-formed one.
export function inviteFromSearch(search: string): string | null {
  const invite = new URLSearchParams(search).get('invite');
  return invite && INVITE_SHAPE.test(invite) ? invite : null;
}

// A pasted setup link, a bare invite, or a line of text with a link in it.
export function parseSetupInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (INVITE_SHAPE.test(trimmed)) return trimmed;
  const match = /[?&]invite=([A-Za-z0-9_-]+\.[0-9a-f]{64})(?![0-9a-f])/.exec(trimmed);
  return match ? match[1]! : null;
}

// The query string with the device's own user in `userId`, or null when it
// already says so. A `user=` alias or someone else's id is replaced rather than
// sent: the server refuses a request that names anyone but the device's owner.
export function reconcileIdentitySearch(search: string, actorUserId: string): string | null {
  const params = new URLSearchParams(search);
  const ids = params.getAll('userId');
  if (ids.length === 1 && ids[0] === actorUserId && !params.has('user')) return null;

  params.delete('user');
  params.delete('userId');
  params.set('userId', actorUserId);
  return `?${params.toString()}`;
}

// What the server records the device as. A guess from the browser is enough:
// it only names the row in `npm run devices -- list`.
export function guessDeviceType(userAgent: string): 'phone' | 'tablet' | 'desktop' {
  if (/iPad|Tablet/i.test(userAgent)) return 'tablet';
  if (/iPhone|Android.+Mobile|Mobile/i.test(userAgent)) return 'phone';
  return 'desktop';
}
