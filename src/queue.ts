import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';

// Shared Redis connection. maxRetriesPerRequest: null is required by BullMQ.
export const redis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
  lazyConnect: true,
});

// Suppress unhandled error events — ioredis emits these on reconnect attempts.
// Actual errors surface via queue operation failures.
redis.on('error', () => {});

// Download queue — concurrency 2, 3 retries with exponential backoff (Phase 1)
export const downloadQueue = new Queue('downloads', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

// Guard triage queue (Phase 3)
export const guardQueue = new Queue('guard', {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

export async function closeQueues(): Promise<void> {
  await Promise.all([downloadQueue.close(), guardQueue.close()]);
  await redis.quit();
}
