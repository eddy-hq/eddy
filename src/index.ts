import 'dotenv/config';
import { config } from './config';
import { logger } from './logger';
import { runMigrations } from './db/migrate';
import { seedUsers } from './db/seed';
import { app } from './server';
import { closeQueues } from './queue';
import { startWatchdog, stopWatchdog } from './modules/watchdog';
import { startRssPoller, stopRssPoller } from './modules/people/index';
import { startDiscoveryScheduler, stopDiscoveryScheduler } from './modules/discovery/index';
import {
  startProfileEnrichmentScheduler,
  stopProfileEnrichmentScheduler,
} from './modules/profile-enrichment/index';
import { startInterestsWorker, stopInterestsWorker } from './modules/interests/searchTermsWorker';
import { startGuardWorker, stopGuardWorker } from './modules/guard/index';
import { startRecyclerScheduler, stopRecyclerScheduler } from './modules/recycler/index';

async function start(): Promise<void> {
  logger.info({ env: config.NODE_ENV }, 'Starting Eddy');

  runMigrations();
  seedUsers();
  logger.info('Database ready');

  startWatchdog();
  startRssPoller();
  startDiscoveryScheduler();
  startProfileEnrichmentScheduler();
  startRecyclerScheduler();
  startInterestsWorker();
  startGuardWorker();

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, tailscale: `http://${config.TAILSCALE_IP}:${config.PORT}` },
      'Eddy listening'
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopWatchdog();
    stopRssPoller();
    await stopDiscoveryScheduler();
    await stopProfileEnrichmentScheduler();
    await stopRecyclerScheduler();
    await stopInterestsWorker();
    await stopGuardWorker();
    server.close(() => logger.info('HTTP server closed'));
    await closeQueues();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (err: unknown) => {
  logger.error({ err }, 'Unhandled promise rejection — exiting for supervisor restart');
  process.exit(1);
});

process.on('uncaughtException', (err: unknown) => {
  logger.error({ err }, 'Uncaught exception — exiting for supervisor restart');
  process.exit(1);
});

start().catch((err: unknown) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
