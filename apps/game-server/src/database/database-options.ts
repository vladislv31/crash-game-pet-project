import { join } from 'node:path';

import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { BetEntity } from '../betting/bet.entity';
import { LedgerEntryEntity } from '../betting/ledger-entry.entity';
import { RoundEntity } from '../game/round.entity';
import { UserEntity } from '../users/user.entity';

/** Shared by the app and the TypeORM CLI. Defaults match docker-compose.yml. */
export function databaseOptions(env: NodeJS.ProcessEnv = process.env): PostgresConnectionOptions {
  return {
    type: 'postgres',
    host: env.POSTGRES_HOST ?? 'localhost',
    port: Number(env.POSTGRES_PORT ?? 5432),
    username: env.POSTGRES_USER ?? 'crash',
    password: env.POSTGRES_PASSWORD ?? 'crash',
    database: env.POSTGRES_DB ?? 'crash',
    entities: [UserEntity, BetEntity, LedgerEntryEntity, RoundEntity],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  };
}

const POOL_WAIT_MS = 1_000;
const TRANSACTION_TIMEOUT_MS = 3_000;

/**
 * The app's connection: a request waits at most 1 s for a pooled connection and a transaction runs
 * at most 3 s, together below the 5 s pause. A cashout received before the crash therefore commits
 * or fails before the settlement sweep can mark its bet as lost (ADR-0004).
 */
export function appDatabaseOptions(
  env: NodeJS.ProcessEnv = process.env,
): PostgresConnectionOptions {
  return {
    ...databaseOptions(env),
    migrationsRun: true,
    extra: {
      connectionTimeoutMillis: POOL_WAIT_MS,
      options: `-c transaction_timeout=${TRANSACTION_TIMEOUT_MS}`,
    },
  };
}
