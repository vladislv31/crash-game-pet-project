import { DataSource } from 'typeorm';

import { databaseOptions } from './database-options';

/** Applies pending migrations on a connection without the app's transaction timeout; returns how many ran. */
export async function runMigrations(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dataSource = new DataSource(databaseOptions(env));
  await dataSource.initialize();
  try {
    return (await dataSource.runMigrations()).length;
  } finally {
    await dataSource.destroy();
  }
}
