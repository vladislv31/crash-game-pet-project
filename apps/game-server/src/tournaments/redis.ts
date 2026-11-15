import { Provider } from '@nestjs/common';
import { Redis, RedisOptions } from 'ioredis';

import { APP_LOGGER, AppLogger } from '../logging/logger';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/** Defaults match docker-compose.yml. */
export function redisOptions(env: NodeJS.ProcessEnv = process.env): RedisOptions {
  return {
    host: env.REDIS_HOST ?? 'localhost',
    port: Number(env.REDIS_PORT ?? 6379),
    db: Number(env.REDIS_DB ?? 0),
    // Redis is optional (ADR-0009): while it is down, commands fail at once and callers fall back.
    enableOfflineQueue: false,
  };
}

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [APP_LOGGER],
  useFactory: (logger: AppLogger): Redis => {
    const client = new Redis(redisOptions());
    // Without a listener ioredis prints every failed reconnection as an unhandled error.
    client.on('error', (error: Error) => logger.error({ event: 'redis.error', err: error }));

    return client;
  },
};
