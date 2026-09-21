// Public barrel for the notifications module.
//
// The only way to send a notification is `notify(event, recipient)` — call it
// via `getNotifications().notify(...)`. Production wiring constructs the
// module once in `server.ts` via `createNotifications()` and registers it
// through `registerDefaultNotifications`. Tests can register a fake the same
// way (or rely on the lazy default).

import { createNotifications, type NotificationsModule } from './notify';

export { createNotifications, contentFor } from './notify';
export type {
  NotificationsModule,
  NotificationPorts,
  NotificationsOptions,
} from './notify';
export {
  createApnsSender,
  createHttp2Client,
  apnsSettingsFrom,
  buildApnsPayload,
  APNS_HOSTS,
  PLACEHOLDER_TITLE,
  PLACEHOLDER_BODY,
} from './apns';
export type {
  ApnsSender,
  ApnsSettings,
  ApnsTarget,
  ApnsHttpClient,
  ApnsHttpResponse,
  ApnsSendResult,
} from './apns';
export { recordMessage, readMessage, MESSAGE_TTL_MS } from './messages';
export type { NotificationContent } from './messages';
export { notificationsRouter } from './router';
export { createRelayNotifications, parseRelayPayload, RELAY_PATH } from './relay';
export type { RelayPayload } from './relay';
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
