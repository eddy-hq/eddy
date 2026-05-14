// Public barrel for the notifications module.
//
// The only way to send a notification is `notify(event, recipient)` — call it
// via `getNotifications().notify(...)`. Production wiring constructs the
// module once in `server.ts` via `createNotifications({ ntfyConfig, pwaBaseUrl })`
// and registers it through `registerDefaultNotifications`. Tests can register
// a fake the same way (or rely on the lazy default, which is built from `config`
// on first access).

import { config } from '../../config';
import { createNotifications, type NotificationsModule } from './notify';

export { createNotifications } from './notify';
export type { NotificationsModule, NtfyUserConfig, CreateNotificationsOptions } from './notify';
export type {
  NotificationEvent,
  VideoReadyEvent,
  DownloadAlertEvent,
  ParentReviewEvent,
} from './events';
export { generateActionToken, validateActionToken } from './tokens';

// ─── Default module accessor ────────────────────────────────────────────────
//
// Mirrors the requests/state-default seam: a lazy default constructed from the
// real config on first access, plus a `register*` hook so server.ts can swap
// in the production-wired module at boot. Callers reach `notify` via
// `getNotifications()` so the registered module is read at call time, not
// captured at import.

let _defaultModule: NotificationsModule | null = null;

function defaultModule(): NotificationsModule {
  if (_defaultModule === null) {
    _defaultModule = createNotifications({
      ntfyConfig: config.ntfyUserConfig,
      pwaBaseUrl: `http://${config.TAILSCALE_IP}:${config.PORT}`,
    });
  }
  return _defaultModule;
}

export function getNotifications(): NotificationsModule {
  return defaultModule();
}

export function registerDefaultNotifications(mod: NotificationsModule): void {
  _defaultModule = mod;
}
