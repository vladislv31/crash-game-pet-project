import { appDatabaseOptions, databaseOptions } from './database-options';

describe('databaseOptions', () => {
  it('defaults to the docker-compose database', () => {
    expect(databaseOptions({})).toMatchObject({
      host: 'localhost',
      port: 5432,
      username: 'crash',
      password: 'crash',
      database: 'crash',
    });
  });

  it('reads the connection from the environment', () => {
    expect(
      databaseOptions({
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: '6543',
        POSTGRES_USER: 'u',
        POSTGRES_PASSWORD: 'p',
        POSTGRES_DB: 'game',
      }),
    ).toMatchObject({ host: 'db', port: 6543, username: 'u', password: 'p', database: 'game' });
  });

  it('has no timeouts, so long migrations from the CLI are not cut off', () => {
    expect(databaseOptions({}).extra).toBeUndefined();
  });
});

describe('appDatabaseOptions', () => {
  // A cashout received before the crash must commit or fail within the 5 s pause,
  // before the settlement sweep can mark its bet as lost (ADR-0004).
  it('bounds pool wait and transaction time below the 5 s pause', () => {
    const { extra } = appDatabaseOptions({});

    expect(extra).toEqual({
      connectionTimeoutMillis: 1_000,
      options: '-c transaction_timeout=3000',
    });
  });

  it('applies migrations on start', () => {
    expect(appDatabaseOptions({}).migrationsRun).toBe(true);
  });
});
