import pino from 'pino';
import { config } from './config';

export const logger = pino(
  config.NODE_ENV === 'development'
    ? {
        level: 'debug',
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {
        level: 'info',
      }
);
