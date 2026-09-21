import { z } from 'zod';
import { logger } from '../../logger';
import type { NotificationEvent } from './events';
import type { NotificationsModule } from './notify';

// The Ubuntu worker raises two ops alerts — the circuit breaker and the
// download failure streak — but has neither the database nor the APNs key, so
// it cannot deliver them itself. It hands them to the M4 over the signed
// internal channel, and the M4's wired notify() does the rest.

export const RELAY_PATH = '/internal/notify';

// Only the kinds the worker raises. Anything user-facing (video_ready,
// parent_review) originates on the M4 and has no business arriving this way.
const relayedEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('circuit_open'),
    consecutiveTrips: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('download_failure_streak'),
    consecutiveFailures: z.number().int().nonnegative(),
    lastError: z.string().max(500),
  }).strict(),
]);

const relayPayloadSchema = z.object({
  event: relayedEventSchema,
  recipient: z.string().uuid(),
}).strict();

export type RelayPayload = z.infer<typeof relayPayloadSchema>;

// Returns null for anything that is not a well-formed relayable alert.
export function parseRelayPayload(body: unknown): RelayPayload | null {
  const parsed = relayPayloadSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export function isRelayable(event: NotificationEvent): boolean {
  return relayedEventSchema.safeParse(event).success;
}

type PostSigned = (path: string, payload: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;

// The worker's notifications module. Logs every event locally first, so an
// unreachable M4 still leaves a trace on the box that raised the alert, then
// relays what the M4 will accept. Never throws: an alert that cannot be
// delivered must not fail the download path that raised it.
export function createRelayNotifications(post: PostSigned): NotificationsModule {
  return {
    async notify(event, recipient) {
      logger.warn({ recipient, kind: event.kind }, 'Notification (relayed to the M4 for delivery)');
      if (!isRelayable(event)) {
        logger.warn({ kind: event.kind }, 'Notification kind is not relayable from the worker; logged only');
        return;
      }
      try {
        await post(RELAY_PATH, { event, recipient }, { timeoutMs: 10_000 });
      } catch (err) {
        logger.error({ err, kind: event.kind }, 'Notification relay to the M4 failed; logged only');
      }
    },
  };
}
