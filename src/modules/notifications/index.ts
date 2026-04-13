import { config } from '../../config';
import { logger } from '../../logger';
import { sendNtfy } from './ntfy';
export { generateActionToken, validateActionToken } from './tokens';

interface UserNtfyConfig {
  topic: string;
  credentials: string;
}

// Maps a user_id to their ntfy topic + credentials.
// Returns null if ntfy is not configured for that user.
function ntfyConfigForUser(userId: string): UserNtfyConfig | null {
  const pairs: Array<{ id: string; topic?: string; creds?: string }> = [
    { id: config.USER_ID_STEVE, topic: config.NTFY_TOPIC_STEVE, creds: config.NTFY_CREDS_STEVE },
    { id: config.USER_ID_BOY1,  topic: config.NTFY_TOPIC_BOY1,  creds: config.NTFY_CREDS_BOY1 },
    { id: config.USER_ID_BOY2,  topic: config.NTFY_TOPIC_BOY2,  creds: config.NTFY_CREDS_BOY2 },
  ];

  const match = pairs.find((p) => p.id === userId);
  if (!match?.topic || !match.creds) return null;
  return { topic: match.topic, credentials: match.creds };
}

function pwaUrl(path: string): string {
  return `http://${config.TAILSCALE_IP}:${config.PORT}${path}`;
}

// Sent to a kid when their video is downloaded and ready to watch.
export async function sendVideoReady(
  userId: string,
  requestId: string,
  title: string,
): Promise<void> {
  const ntfy = ntfyConfigForUser(userId);
  if (!ntfy) {
    logger.warn({ userId }, 'ntfy not configured for user — skipping video-ready notification');
    return;
  }

  await sendNtfy({
    topic: ntfy.topic,
    credentials: ntfy.credentials,
    title: 'Ready to watch',
    message: title,
    priority: 'default',
    tags: ['tada'],
    clickUrl: pwaUrl(`/watch/${requestId}`),
  });

  logger.info({ userId, requestId }, 'Video-ready notification sent');
}

// Sent to parents when a kid's request needs a decision.
export async function sendParentReview(opts: {
  parentUserId: string;
  requestId: string;
  requesterName: string;
  title: string;
  channel: string;
  reason: string;
  approveToken: string;
  denyToken: string;
}): Promise<void> {
  const ntfy = ntfyConfigForUser(opts.parentUserId);
  if (!ntfy) {
    logger.warn({ userId: opts.parentUserId }, 'ntfy not configured for parent — skipping review notification');
    return;
  }

  const base = `http://${config.TAILSCALE_IP}:${config.PORT}`;

  await sendNtfy({
    topic: ntfy.topic,
    credentials: ntfy.credentials,
    title: `${opts.requesterName} wants to watch something`,
    message: `${opts.title} — ${opts.channel}\n${opts.reason}`,
    priority: 'max',
    tags: ['eyes'],
    clickUrl: pwaUrl(`/admin/requests/${opts.requestId}`),
    actions: [
      {
        action: 'http',
        label: 'Approve',
        url: `${base}/action/approve?token=${opts.approveToken}`,
        method: 'POST',
        clear: true,
      },
      {
        action: 'http',
        label: 'Deny',
        url: `${base}/action/deny?token=${opts.denyToken}`,
        method: 'POST',
        clear: true,
      },
    ],
  });

  logger.info({ requestId: opts.requestId, parentUserId: opts.parentUserId }, 'Parent-review notification sent');
}
