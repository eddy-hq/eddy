// Public barrel for the notifications module.
//
// The only way to send a notification is `notify(event, recipient)` — call it
// via `getNotifications().notify(...)`. Production wiring constructs the
// module once in `server.ts` via `createNotifications()` and registers it
// through `registerDefaultNotifications`. Tests can register a fake the same
// way (or rely on the lazy default).

import { createNotifications, type NotificationsModule } from './notify';

export { createNotifications } from './notify';
export type { NotificationsModule } from './notify';
export type {
  NotificationEvent,
  VideoReadyEvent,
  DownloadAlertEvent,
  ParentReviewEvent,
  CircuitOpenEvent,
} from './events';
export { generateActionToken, validateActionToken } from './tokens';

// ─── Default module accessor ────────────────────────────────────────────────
//
// Mirrors the requests/state-default seam: a lazy default constructed on first
// access, plus a `register*` hook so server.ts can swap in the
// production-wired module at boot. Callers reach `notify` via
// `getNotifications()` so the registered module is read at call time, not
// captured at import.

let _defaultModule: NotificationsModule | null = null;

function defaultModule(): NotificationsModule {
  if (_defaultModule === null) {
    _defaultModule = createNotifications();
  }
  return _defaultModule;
}

export function getNotifications(): NotificationsModule {
  return defaultModule();
}

export function registerDefaultNotifications(mod: NotificationsModule): void {
  _defaultModule = mod;
}
