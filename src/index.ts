import 'dotenv/config';
import { config } from './config';
import { logger } from './logger';
import { runMigrations } from './db/migrate';
import { seedUsers } from './db/seed';
import { app } from './server';
import { closeQueues } from './queue';
import { startDownloadWorker } from './modules/content';

async function start(): Promise<void> {
  logger.info({ env: config.NODE_ENV }, 'Starting Eddy');

  // Run DB migrations before accepting traffic
  runMigrations();
  seedUsers();
  logger.info('Database ready');

  const worker = startDownloadWorker();

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, tailscale: `http://${config.TAILSCALE_IP}:${config.PORT}` },
      'Eddy listening'
    );
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => logger.info('HTTP server closed'));
    await worker.close();
    await closeQueues();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err: unknown) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
