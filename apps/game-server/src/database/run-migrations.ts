import { DataSource } from 'typeorm';

import { databaseOptions } from './database-options';

/** Applies pending migrations on a connection without the app's transaction timeout. */
export async function runMigrations(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dataSource = new DataSource(databaseOptions(env));
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
