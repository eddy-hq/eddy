import { logger } from '../../logger';
import { sendNtfy, type NtfyAction, type NtfyPriority } from './ntfy';
import type { NotificationEvent } from './events';

// One ntfy topic + credentials pair per user. The notifications module never
// reaches into `config` for this — production wiring builds the array in
// `config.ts` from the per-user env vars and injects it at construction.
export interface NtfyUserConfig {
  userId: string;
  topic: string;
  credentials: string;
}

export interface NotificationsModule {
  notify(event: NotificationEvent, recipient: string): Promise<void>;
}

export interface CreateNotificationsOptions {
  ntfyConfig: ReadonlyArray<NtfyUserConfig>;
  // Base URL for click-through and action links. e.g. `http://100.x.x.x:3737`.
  pwaBaseUrl: string;
}

interface NtfyPayload {
  title: string;
  message: string;
  priority?: NtfyPriority;
  tags?: string[];
  clickUrl?: string;
  actions?: NtfyAction[];
}

// createNotifications — factory that owns the user→topic lookup and event→payload
// mapping. Returns the public `notify(event, recipient)` adapter. ntfy stays the
// only transport; this is event-type fan-in.
export function createNotifications(opts: CreateNotificationsOptions): NotificationsModule {
  const { ntfyConfig, pwaBaseUrl } = opts;

  function ntfyConfigForUser(userId: string): NtfyUserConfig | null {
    const match = ntfyConfig.find((c) => c.userId === userId);
    // Defence-in-depth: production wiring drops entries missing either field
    // at config-build time, but the module owns the invariant on its own
    // boundary — return null if either piece is missing so callers never see
    // a partial entry.
    if (!match || !match.topic || !match.credentials) return null;
    return match;
  }

  function pwaUrl(path: string): string {
    return `${pwaBaseUrl}${path}`;
  }

  function buildPayload(event: NotificationEvent): NtfyPayload {
    switch (event.kind) {
      case 'video_ready':
        return {
          title: 'Ready to watch',
          message: event.title,
          priority: 'default',
          tags: ['tada'],
          clickUrl: pwaUrl(`/watch/${event.requestId}`),
        };

      case 'download_alert': {
        const actionLabel =
          event.action === 're-enqueued' ? 'Re-enqueued automatically' :
          event.action === 'failed'      ? 'Marked failed — needs manual retry' :
                                           'Still active — check Ubuntu worker';
        return {
          title: `Stuck download (${event.stuckMins}m)`,
          message: `${event.title}\n${actionLabel}`,
          priority: event.action === 'failed' ? 'high' : 'default',
          tags: event.action === 'failed' ? ['warning'] : ['arrows_counterclockwise'],
          clickUrl: pwaUrl(`/admin/requests/${event.requestId}`),
        };
      }

      case 'circuit_open':
        return {
          title: 'yt-dlp pipeline auto-paused',
          message:
            `The download + discovery queues auto-paused after ${event.consecutiveTrips} consecutive bot-detection trips.\n` +
            'Resume is manual: run `pipeline-pause.ts resume-if-clear` once the IP block has cleared.',
          priority: 'high',
          tags: ['rotating_light'],
          clickUrl: pwaUrl('/admin/requests'),
        };

      case 'download_failure_streak':
        return {
          title: 'Downloads failing repeatedly',
          message:
            `${event.consecutiveFailures} downloads in a row have failed.\n` +
            `Last error: ${event.lastError}\n` +
            'Mid-transfer 403s suggest a flagged guest cookie jar — move it aside (ops.md "Rotate"). Queues are NOT paused.',
          priority: 'high',
          tags: ['warning'],
          clickUrl: pwaUrl('/admin/requests'),
        };

      case 'parent_review':
        return {
          title: `${event.requesterName} wants to watch something`,
          message: `${event.title} — ${event.channel}\n${event.reason}`,
          priority: 'max',
          tags: ['eyes'],
          clickUrl: pwaUrl(`/admin/requests/${event.requestId}`),
          actions: [
            {
              action: 'http',
              label: 'Approve',
              url: `${pwaBaseUrl}/action/approve?token=${event.approveToken}`,
              method: 'POST',
              clear: true,
            },
            {
              action: 'http',
              label: 'Deny',
              url: `${pwaBaseUrl}/action/deny?token=${event.denyToken}`,
              method: 'POST',
              clear: true,
            },
          ],
        };

      default: {
        // Exhaustiveness: adding a new kind to NotificationEvent without a
        // case here is a compile error via the `never` assignment.
        const _exhaustive: never = event;
        throw new Error(`Unhandled notification event: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  async function notify(event: NotificationEvent, recipient: string): Promise<void> {
    const ntfy = ntfyConfigForUser(recipient);
    if (!ntfy) {
      logger.warn(
        { recipient, kind: event.kind },
        'ntfy not configured for recipient — skipping notification',
      );
      return;
    }

    const payload = buildPayload(event);

    await sendNtfy({
      topic: ntfy.topic,
      credentials: ntfy.credentials,
      ...payload,
    });

    logger.info(
      {
        recipient,
        kind: event.kind,
        // Not every event carries a requestId (e.g. circuit_open is pipeline-wide).
        requestId: 'requestId' in event ? event.requestId : undefined,
      },
      'Notification sent',
    );
  }

  return { notify };
}
