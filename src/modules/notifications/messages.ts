import { db } from '../../db/client';

// The content behind an opaque push id. Written when a notification is sent,
// read once — by the Notification Service Extension on the recipient's own
// device, over the tailnet — and then left to expire.
//
// A message is readable ONLY by its recipient. An unknown id, someone else's
// id and an expired id are indistinguishable to the caller: all three return
// nothing, and the router turns that into the same 404.

export interface NotificationContent {
  title: string;
  body: string;
  actionUrl?: string;
}

// The extension fetches within seconds of delivery; a day is generous. Old rows
// are pruned on write rather than on a schedule — this table only grows at the
// rate notifications are sent.
export const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

function cutoff(now: number): string {
  return new Date(now - MESSAGE_TTL_MS).toISOString();
}

export function recordMessage(
  messageId: string,
  userId: string,
  content: NotificationContent,
  now: number = Date.now()
): void {
  db.prepare(
    `INSERT INTO notification_messages (message_id, user_id, title, body, action_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    messageId,
    userId,
    content.title,
    content.body,
    content.actionUrl ?? null,
    new Date(now).toISOString()
  );

  db.prepare('DELETE FROM notification_messages WHERE created_at < ?').run(cutoff(now));
}

export function readMessage(
  messageId: string,
  userId: string,
  now: number = Date.now()
): NotificationContent | null {
  const row = db
    .prepare(
      `SELECT title, body, action_url
         FROM notification_messages
        WHERE message_id = ? AND user_id = ? AND created_at >= ?`
    )
    .get(messageId, userId, cutoff(now)) as
    | { title: string; body: string; action_url: string | null }
    | undefined;

  if (!row) return null;

  return {
    title: row.title,
    body: row.body,
    ...(row.action_url === null ? {} : { actionUrl: row.action_url }),
  };
}
