import { logger } from '../../logger';
import type { NotificationEvent } from './events';

// Log-only notification transport.
//
// ntfy was removed in September 2026: unused since the first week, and its TLS
// certificate expired on 2026-07-12 so every send had been failing silently
// since. APNs through the native iOS shell (ADR-0013) becomes the one channel
// when it ships; until then a notification is a structured log line and nothing
// leaves the M4.
//
// ADR-0003 still holds: exactly one channel, everything goes through
// `notify(event, recipient)`, replace the transport rather than augment it.
//
// What gets logged is deliberately narrow — the event kind, the recipient's
// user_id and correlation ids. No titles, channel names, requester names,
// tokens or any other free text: a kid's consumption detail must not end up in
// `logs/`.

export interface NotificationsModule {
  notify(event: NotificationEvent, recipient: string): Promise<void>;
}

type LogLevel = 'info' | 'warn';

// Ops alerts log at warn so they stand out in `logs/`; the events a person is
// waiting on log at info.
function levelFor(kind: NotificationEvent['kind']): LogLevel {
  switch (kind) {
    case 'download_alert':
    case 'download_failure_streak':
    case 'circuit_open':
      return 'warn';
    case 'video_ready':
    case 'parent_review':
      return 'info';
  }
}

// Safe-to-log fields per event kind. Anything free-text about what someone is
// watching (title, channel, requesterName, reason) and anything secret (the
// action tokens) is dropped here rather than filtered downstream.
function detailsFor(event: NotificationEvent): Record<string, unknown> {
  switch (event.kind) {
    case 'video_ready':
      return { requestId: event.requestId };

    case 'parent_review':
      return { requestId: event.requestId };

    case 'download_alert':
      return {
        requestId: event.requestId,
        stuckMins: event.stuckMins,
        action: event.action,
      };

    case 'circuit_open':
      return { consecutiveTrips: event.consecutiveTrips };

    case 'download_failure_streak':
      // `lastError` is already reduced to the first line of a yt-dlp failure
      // (see `summariseError`) — a pipeline signature, not user attribution.
      return {
        consecutiveFailures: event.consecutiveFailures,
        lastError: event.lastError,
      };

    default: {
      // Exhaustiveness: adding a new kind to NotificationEvent without a case
      // here is a compile error via the `never` assignment. The message carries
      // the kind only — an unhandled event must not leak its payload.
      const _exhaustive: never = event;
      throw new Error(
        `Unhandled notification event kind: ${(_exhaustive as { kind: string }).kind}`,
      );
    }
  }
}

// createNotifications — factory returning the public `notify(event, recipient)`
// adapter. Takes no wiring: the log-only transport has nothing per-user to
// configure. Kept as a factory (rather than a bare function) so the boot-site
// wiring in `server.ts` and the register seam survive the APNs transport
// landing.
export function createNotifications(): NotificationsModule {
  async function notify(event: NotificationEvent, recipient: string): Promise<void> {
    const fields = { recipient, kind: event.kind, ...detailsFor(event) };
    if (levelFor(event.kind) === 'warn') {
      logger.warn(fields, 'Notification (log-only — no delivery channel)');
    } else {
      logger.info(fields, 'Notification (log-only — no delivery channel)');
    }
  }

  return { notify };
}
