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
