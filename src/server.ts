import path from 'path';
import 'express-async-errors';
import express, { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { logger } from './logger';
import { ollamaHealthCheck } from './ollama';
import { downloadQueue, deleteQueue, redis } from './queue';
import { db } from './db/client';
import { EddyError, NotFoundError } from './errors';
import {
  requestsRouter,
  createRequestsState,
  registerDefaultRequestsState,
  type Ports,
} from './modules/requests/index';
import { internalRouter } from './modules/internal/index';
import { peopleRouter } from './modules/people/index';
import { searchRouter } from './modules/search/index';
import { discoveryRouter } from './modules/discovery/router';
import { interestsRouter } from './modules/interests/index';
import { avatarsRouter } from './modules/avatars/index';
import { watchEventsRouter } from './modules/watch-events/index';
import {
  createNotifications,
  registerDefaultNotifications,
} from './modules/notifications';
import { ensurePersonForChannel, applyChannelInfoToPerson } from './modules/people/registry';
import { API_PREFIXES } from './api-prefixes';

// Wire the notifications module at the production boot site. Everything
// downstream reaches `notify` via `getNotifications()`. There is one transport
// at a time (ADR-0003) — log-only today, APNs when the iOS shell ships — so
// this is event-type fan-in, not transport pluggability.
const notifications = createNotifications();
registerDefaultNotifications(notifications);

// Wire the requests state seam at the production boot site. Call sites reach
// `apply` via `getRequestsState()`, which routes through whatever was
// registered here; the explicit wiring makes the side-effect graph visible
// at the top of the M4 server module instead of being hidden behind
// top-of-module imports inside state.ts.
const requestsPorts: Ports = {
  notifyVideoReady: (userId, requestId, title) =>
    notifications.notify({ kind: 'video_ready', requestId, title }, userId),
  enqueueDownload: (jobData, opts) => downloadQueue.add('download', jobData, opts),
  enqueueDelete: (jobData, opts) => deleteQueue.add('delete', jobData, opts),
  cancelDownloadJob: async (requestId) => {
    const job = await downloadQueue.getJob(requestId);
    await job?.remove();
  },
  redisDel: (key) => redis.del(key),
  ensurePerson: (channelId, channelName) => ensurePersonForChannel(channelId, channelName),
  applyChannelInfo: (personId, channelId) => applyChannelInfoToPerson(personId, channelId),
};
registerDefaultRequestsState(createRequestsState({ ports: requestsPorts }));

export const app = express();

// Capture raw body for HMAC verification on /internal routes.
// The verify callback runs before JSON parsing; rawBody is attached to the request.
app.use(
  express.json({
    limit: '2mb',
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use('/requests', requestsRouter);
app.use('/internal', internalRouter);
app.use('/people', peopleRouter);
app.use('/search', searchRouter);
app.use('/interests', interestsRouter);
app.use('/avatars', avatarsRouter);
app.use('/discovery', discoveryRouter);
app.use('/watch-events', watchEventsRouter);

app.get('/health', async (_req: Request, res: Response) => {
  // DB — synchronous probe; throws if SQLite is broken
  let dbOk = false;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch {
    // falls through with dbOk = false
  }

  const ollamaResult = await ollamaHealthCheck();

  // Redis/queue — M4 uses this only as a producer (Ubuntu worker consumes)
  let downloadCounts: Awaited<ReturnType<typeof downloadQueue.getJobCounts>> | null = null;
  try {
    downloadCounts = await downloadQueue.getJobCounts();
  } catch {
    // falls through with downloadCounts = null
  }

  const redisOk = downloadCounts !== null;
  const allOk = dbOk && redisOk;

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    db: dbOk ? 'ok' : 'error',
    ollama: { ok: ollamaResult.ok, models: ollamaResult.models },
    redis: redisOk ? 'ok' : 'unavailable',
    downloads: redisOk ? downloadCounts : null,
  });
});

// iOS shell releases — the over-the-air install page, manifest and ipa written
// by ios/scripts/release-adhoc.sh. iOS is particular about the manifest being
// XML, and the ipa must never be served stale after a re-sign.
app.use(
  '/ios',
  express.static(config.IOS_DIST_PATH, {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', 'no-store');
      if (filePath.endsWith('.plist')) res.setHeader('Content-Type', 'text/xml');
      if (filePath.endsWith('.ipa')) res.setHeader('Content-Type', 'application/octet-stream');
    },
  })
);

// PWA — serve built assets; fall back to index.html for client-side routing.
// API prefixes are excluded so unknown API paths reach the 404 handler below
// instead of silently returning index.html.
const pwaDir = path.join(__dirname, '../dist/pwa');
app.use(express.static(pwaDir));
const apiPrefixAlternation = API_PREFIXES.map((p) => p.slice(1)).join('|');
const spaFallback = new RegExp(`^/(?!(?:${apiPrefixAlternation})(?:/|$)).*`);
app.get(spaFallback, (_req: Request, res: Response) => {
  res.sendFile(path.join(pwaDir, 'index.html'));
});

// 404 handler (API routes only reach here)
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new NotFoundError('route'));
});

// Error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    logger.warn({ code: err.code, message: err.message }, 'Request error');
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VALIDATION_ERROR' ? 400 : 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong' });
});
