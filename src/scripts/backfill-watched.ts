import 'dotenv/config';
import { logger } from '../logger';
import { backfillWatchedFromEvents } from '../modules/watch-events';

// Replays the watched-derivation rule across existing watch_events rows so
// historical plays show as Watched in the PWA. Pre-fix, /watch-events only
// inserted events; nothing wrote requests.watched_at — see issue #56. Safe to
// re-run; markWatched() no-ops on rows already in `watched`.
function run(): void {
  const result = backfillWatchedFromEvents();
  logger.info(result, 'Watched backfill complete');
}

try {
  run();
  process.exit(0);
} catch (err) {
  logger.error({ err }, 'Watched backfill failed');
  process.exit(1);
}
