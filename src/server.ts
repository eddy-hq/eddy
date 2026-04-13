import express, { NextFunction, Request, Response } from 'express';
import { logger } from './logger';
import { ollamaHealthCheck } from './ollama';
import { downloadQueue, guardQueue } from './queue';
import { EddyError, NotFoundError } from './errors';

export const app = express();

app.use(express.json());

app.get('/health', async (_req: Request, res: Response) => {
  const ollamaResult = await ollamaHealthCheck();

  const getQueueCounts = async (queue: typeof downloadQueue) => {
    try {
      return await queue.getJobCounts();
    } catch {
      return null;
    }
  };

  const [downloadCounts, guardCounts] = await Promise.all([
    getQueueCounts(downloadQueue),
    getQueueCounts(guardQueue),
  ]);

  const redisOk = downloadCounts !== null;

  res.status(redisOk ? 200 : 503).json({
    status: redisOk ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    db: 'ok',
    ollama: { ok: ollamaResult.ok, models: ollamaResult.models },
    redis: redisOk ? 'ok' : 'unavailable',
    queues: redisOk ? { downloads: downloadCounts, guard: guardCounts } : null,
  });
});

// 404 handler
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
