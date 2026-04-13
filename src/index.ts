import 'dotenv/config';
import { config } from './config';
import { logger } from './logger';
import { runMigrations } from './db/migrate';
import { seedUsers } from './db/seed';
import { app } from './server';
import { closeQueues } from './queue';

async function start(): Promise<void> {
  logger.info({ env: config.NODE_ENV }, 'Starting Eddy');

  runMigrations();
  seedUsers();
  logger.info('Database ready');

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, tailscale: `http://${config.TAILSCALE_IP}:${config.PORT}` },
      'Eddy listening'
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => logger.info('HTTP server closed'));
    await closeQueues();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err: unknown) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
