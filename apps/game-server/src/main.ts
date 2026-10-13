import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { runMigrations } from './database/run-migrations';
import { APP_LOGGER } from './logging/logger';
import type { AppLogger } from './logging/logger';
import { NestLogger } from './logging/nest-logger';
import { WideEvent } from './logging/wide-event';

async function bootstrap() {
  const startedAt = performance.now();
  // The same .env ConfigModule reads, loaded early so that migrations use it too.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  // Before the app starts: its own connection has a 3 s transaction timeout that would cut migrations off.
  const migrationsApplied = await runMigrations();
  // Nest's own logs wait until the JSON logger is in place.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get<AppLogger>(APP_LOGGER);
  app.useLogger(new NestLogger(logger));

  const port = Number(process.env.PORT ?? 3000);
  const startup = new WideEvent(logger, 'startup', { migrationsApplied, port }, startedAt);
  try {
    configureApp(app);
    app.enableShutdownHooks();
    await app.listen(port);
    startup.set({ outcome: 'ok' });
  } catch (error) {
    startup.set({ outcome: 'failed' });
    startup.fail(error);
    throw error;
  } finally {
    startup.emit();
  }
}

void bootstrap();
