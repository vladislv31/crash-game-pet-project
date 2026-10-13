import { existsSync } from 'node:fs';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { runMigrations } from './database/run-migrations';

async function bootstrap() {
  // The same .env ConfigModule reads, loaded early so that migrations use it too.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  // Before the app starts: its own connection has a 3 s transaction timeout that would cut migrations off.
  await runMigrations();
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
