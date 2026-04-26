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

// Discovery engine queue (Phase 5) — repeatable daily job, processed on M4
export const discoveryQueue = new Queue('discovery', {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 20 },
  },
});

// Thumbnail upgrade queue — runs after a download completes so the video is usable
// with a fallback (maxresdefault) thumbnail immediately, while the editorial-first
// selection happens in the background without holding up availability or blocking
// Gemma on the guard path.
export const thumbsQueue = new Queue('thumbs', {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

// Delete queue — symmetric with downloads. The M4 enqueues; the Ubuntu worker
// owns the unlink because the video files only exist on the worker's disk.
export const deleteQueue = new Queue('deletes', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

export async function closeQueues(): Promise<void> {
  await Promise.all([
    downloadQueue.close(),
    guardQueue.close(),
    discoveryQueue.close(),
    thumbsQueue.close(),
    deleteQueue.close(),
  ]);
  await redis.quit();
}
