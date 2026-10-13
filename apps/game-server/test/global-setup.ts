import { Client } from 'pg';

import { databaseOptions } from '../src/database/database-options';

/** Creates the test database on the first run; docker-compose only creates the dev one. */
export default async function globalSetup(): Promise<void> {
  const database = process.env.POSTGRES_TEST_DB ?? 'crash_test';
  const options = databaseOptions();
  const client = new Client({
    host: options.host,
    port: options.port,
    user: options.username,
    password: typeof options.password === 'string' ? options.password : undefined,
    database: 'postgres',
  });

  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await client.end();
  }
}
