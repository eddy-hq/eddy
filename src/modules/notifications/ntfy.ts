import { config } from '../../config';
import { logger } from '../../logger';

export type NtfyPriority = 'min' | 'low' | 'default' | 'high' | 'max';

export interface NtfyAction {
  action: 'http';
  label: string;
  url: string;
  method?: 'POST' | 'GET';
  clear?: boolean;
}

export interface NtfyMessage {
  topic: string;
  credentials: string; // "user:pass"
  title: string;
  message: string;
  priority?: NtfyPriority;
  tags?: string[];
  clickUrl?: string;
  actions?: NtfyAction[];
}

export async function sendNtfy(msg: NtfyMessage): Promise<void> {
  const base = config.NTFY_BASE_URL;
  if (!base) {
    logger.warn('NTFY_BASE_URL not set — skipping notification');
    return;
  }

  const headers: Record<string, string> = {
    'Authorization': `Basic ${Buffer.from(msg.credentials).toString('base64')}`,
    'Title': msg.title,
    'Priority': msg.priority ?? 'default',
    'Content-Type': 'text/plain',
  };

  if (msg.tags?.length) {
    headers['Tags'] = msg.tags.join(',');
  }
  if (msg.clickUrl) {
    headers['Click'] = msg.clickUrl;
  }
  if (msg.actions?.length) {
    headers['Actions'] = msg.actions
      .map((a) => {
        let s = `${a.action}, ${a.label}, ${a.url}`;
        if (a.method) s += `, method=${a.method}`;
        if (a.clear) s += ', clear=true';
        return s;
      })
      .join('; ');
  }

  const url = `${base.replace(/\/$/, '')}/${msg.topic}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: msg.message,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, topic: msg.topic }, 'ntfy returned non-OK status');
    }
  } catch (err) {
    logger.warn({ err, topic: msg.topic }, 'ntfy send failed (non-fatal)');
  }
}
