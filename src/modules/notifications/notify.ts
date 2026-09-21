import { v7 as uuidv7 } from 'uuid';
import { logger } from '../../logger';
import type { NotificationEvent } from './events';
import type { ApnsSender, ApnsSendResult, ApnsTarget } from './apns';
import type { NotificationContent } from './messages';

// The one notification channel.
//
// ntfy was removed in September 2026: unused since the first week, and its TLS
// certificate expired on 2026-07-12 so every send had been failing silently
// since. APNs through the native iOS shell (ADR-0013) is its replacement — and
// with no sender wired (no APNs key configured) a notification is still a
// structured log line and nothing leaves the M4.
//
// ADR-0003 still holds: exactly one channel, everything goes through
// `notify(event, recipient)`, replace the transport rather than augment it.
//
// What gets logged is deliberately narrow — the event kind, the recipient's
// user_id and correlation ids. No titles, channel names, requester names,
// tokens or any other free text: a kid's consumption detail must not end up in
// `logs/`. The same rule, harder, applies to what goes to Apple: the push
// carries placeholder copy and a random id, and the real content is stored here
// for the device's own Notification Service Extension to fetch back (ADR-0004).
//
// DB access lives behind `ports` rather than being imported directly, so this
// file stays free of the database and the transport is wired once in
// `server.ts`, visible at the boot site like the requests module's ports.

export interface NotificationsModule {
  notify(event: NotificationEvent, recipient: string): Promise<void>;
}

export interface NotificationPorts {
  listPushDevices(userId: string): ApnsTarget[];
  recordMessage(messageId: string, userId: string, content: NotificationContent): void;
  forgetDevice(deviceId: string): void;
}

export interface NotificationsOptions {
  // Absent (or null) keeps the log-only behaviour exactly as it was.
  sender?: ApnsSender | null;
  ports?: NotificationPorts;
  newMessageId?: () => string;
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

// The real, human-readable content for an event. It is written to the M4's own
// database and served back over the tailnet to the recipient's device — it is
// never part of the push payload, so the free text dropped from `detailsFor`
// above belongs here.
export function contentFor(event: NotificationEvent): NotificationContent {
  switch (event.kind) {
    case 'video_ready':
      return {
        title: 'Ready to watch',
        body: event.title,
        actionUrl: `/watch/${event.requestId}`,
      };

    case 'parent_review':
      return {
        title: 'Needs a grown-up',
        body: `${event.requesterName} asked for "${event.title}"`,
        actionUrl: '/admin',
      };

    case 'download_alert':
      return {
        title: 'A download needs a look',
        body: `Stuck for ${event.stuckMins} minutes (${event.action}).`,
        actionUrl: '/admin',
      };

    case 'circuit_open':
      return {
        title: 'Downloads paused',
        body: `yt-dlp was blocked ${event.consecutiveTrips} times in a row. Downloads stay paused until you resume them.`,
        actionUrl: '/admin',
      };

    case 'download_failure_streak':
      return {
        title: 'Downloads are failing',
        body: `${event.consecutiveFailures} downloads failed in a row. Last error: ${event.lastError}`,
        actionUrl: '/admin',
      };

    default: {
      const _exhaustive: never = event;
      throw new Error(
        `Unhandled notification event kind: ${(_exhaustive as { kind: string }).kind}`,
      );
    }
  }
}

// createNotifications — factory returning the public `notify(event, recipient)`
// adapter. With no options it is the log-only transport, unchanged. Given a
// sender and ports it also pushes: one message row, then one opaque push per
// registered device.
export function createNotifications(options: NotificationsOptions = {}): NotificationsModule {
  const { sender = null, ports, newMessageId = uuidv7 } = options;
  const pushing = sender !== null && ports !== undefined;

  async function push(event: NotificationEvent, recipient: string): Promise<void> {
    if (sender === null || ports === undefined) return;

    const devices = ports.listPushDevices(recipient);
    if (devices.length === 0) return;

    // Random, and random every time: the id means nothing off the M4.
    const messageId = newMessageId();
    ports.recordMessage(messageId, recipient, contentFor(event));

    for (const device of devices) {
      let result: ApnsSendResult;
      try {
        result = await sender.send(device, messageId);
      } catch (err) {
        // A timeout or a dropped connection on one device must not cost the
        // recipient's other devices their push.
        logger.warn({ err, deviceId: device.deviceId }, 'APNs send threw; continuing with the next device');
        continue;
      }
      if (result.ok) continue;

      if (result.deviceGone) {
        // Apple says this token is dead — the app was deleted, or the token was
        // reissued. Drop the row rather than keep pushing into the void.
        ports.forgetDevice(device.deviceId);
        logger.info({ deviceId: device.deviceId, status: result.status }, 'Device token rejected by APNs; device removed');
        continue;
      }

      logger.warn(
        { deviceId: device.deviceId, status: result.status, reason: result.reason },
        'APNs send failed',
      );
    }
  }

  async function notify(event: NotificationEvent, recipient: string): Promise<void> {
    // Every notification is logged, whatever the transport does next.
    const fields = { recipient, kind: event.kind, ...detailsFor(event) };
    const message = pushing ? 'Notification' : 'Notification (log-only — no delivery channel)';
    if (levelFor(event.kind) === 'warn') {
      logger.warn(fields, message);
    } else {
      logger.info(fields, message);
    }

    // A transport failure is never the caller's problem: a stuck download
    // alert that cannot be delivered must not fail the watchdog that raised it.
    try {
      await push(event, recipient);
    } catch (err) {
      logger.error({ err, recipient, kind: event.kind }, 'Notification delivery failed');
    }
  }

  return { notify };
}
