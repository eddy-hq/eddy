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

// Download queue — worker concurrency 1, 3 retries with exponential backoff (Phase 1)
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

// Profile enrichment queue (issue #58) — nightly behavioural snapshot + trust
// recompute. Scheduled at 05:00 so trust is fresh by the 06:00 discovery run.
export const profileEnrichmentQueue = new Queue('profile-enrichment', {
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

// Interests queue — generate-search-terms (and the kid-interest guard chain
// from this same flow). Runs on the M4 alongside the discovery worker.
export const interestsQueue = new Queue('interests', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

// Delete queue — best-effort. The M4 enqueues; the Ubuntu worker owns the
// unlink because the video files only exist on the worker's disk.
// `attempts: 1` matches the worker semantics: it never throws (it collects
// failures and reports them via the file-deleted callback), so retries would
// only re-run unlinks against now-absent files. Real failure is observed via
// the M4 logger.warn from the callback handler, not via BullMQ retries.
// The recycler reuses this queue for its unlinks (issue #115) so all file
// removals — soft-delete or recycle — land in the same worker log stream.
export const deleteQueue = new Queue('deletes', {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

// Recycler queue (issue #115) — nightly per-user budget enforcement. Carries
// the schedule trigger only; the actual file unlinks the recycler issues go
// onto `deleteQueue` (see above) so the worker handles both paths uniformly.
export const recyclerQueue = new Queue('recycler', {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 20 },
  },
});

export async function closeQueues(): Promise<void> {
  await Promise.all([
    downloadQueue.close(),
    guardQueue.close(),
    discoveryQueue.close(),
    profileEnrichmentQueue.close(),
    thumbsQueue.close(),
    interestsQueue.close(),
    deleteQueue.close(),
    recyclerQueue.close(),
  ]);
  await redis.quit();
}
