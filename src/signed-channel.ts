/**
 * HMAC-signed cross-process channel between the M4 server and the Ubuntu worker.
 * The brief identifies this as one boundary; the protocol lives here, not in
 * each Express handler or each worker callback.
 */
import crypto from 'crypto';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { config } from './config';
import { logger } from './logger';

const SIGNATURE_HEADER = 'x-eddy-signature';

function compute(input: Buffer | string): string {
  return `sha256=${crypto
    .createHmac('sha256', config.INTERNAL_HMAC_SECRET)
    .update(input)
    .digest('hex')}`;
}

export function sign(body: string): string {
  return compute(body);
}

export function verify(rawBody: Buffer, signature: string): boolean {
  const expected = compute(rawBody);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

type SignedHandler<T> = (
  req: ExpressRequest,
  res: ExpressResponse,
  body: T,
) => unknown | Promise<unknown>;

/**
 * M4-side wrapper: owns header check, raw-body check, HMAC verify, JSON parse.
 * Inner handler receives the parsed body and only writes business logic.
 */
export function verifySignedJson<T>(handler: SignedHandler<T>) {
  return async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const sig = req.headers[SIGNATURE_HEADER];
    if (!sig || typeof sig !== 'string') {
      res.status(401).json({ error: 'Missing signature' });
      return;
    }
    const rawBody = (req as ExpressRequest & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: 'No body' });
      return;
    }
    if (!verify(rawBody, sig)) {
      logger.warn({ path: req.path }, 'HMAC verification failed');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
    let body: T;
    try {
      body = JSON.parse(rawBody.toString()) as T;
    } catch {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
    await handler(req, res, body);
  };
}

/**
 * Worker-side: signs payload, POSTs to `${M4_INTERNAL_URL}${path}`, throws on
 * missing URL or non-2xx response. Returns the raw fetch Response — caller
 * decides whether to read JSON.
 */
export async function postSigned(
  path: string,
  payload: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<Response> {
  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) {
    throw new Error('M4_INTERNAL_URL not set');
  }
  const body = JSON.stringify(payload);
  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Eddy-Signature': sign(body),
    },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!resp.ok) {
    throw new Error(`POST ${path} → ${resp.status}`);
  }
  return resp;
}
