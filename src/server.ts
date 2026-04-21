import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import { logger } from './logger';
import { ollamaHealthCheck } from './ollama';
import { downloadQueue } from './queue';
import { db } from './db/client';
import { EddyError, NotFoundError } from './errors';
import { requestsRouter } from './modules/requests/index';
import { internalRouter } from './modules/internal/index';
import { peopleRouter } from './modules/people/index';
import { searchRouter } from './modules/search/index';
import { topicsRouter } from './modules/discovery/index';

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
app.use('/topics', topicsRouter);

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

// PWA — serve built assets; fall back to index.html for client-side routing
const pwaDir = path.join(__dirname, '../dist/pwa');
app.use(express.static(pwaDir));
app.get(/^\/(?!api|requests|internal|action|health).*/, (_req: Request, res: Response) => {
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
