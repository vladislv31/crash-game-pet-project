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
  // Migrations run separately with databaseOptions(), so the app's transaction timeout cannot cut them off.
  it('does not run migrations on the time-bounded app connection', () => {
    expect(appDatabaseOptions({}).migrationsRun).toBeFalsy();
  });

  it('connects to the same database', () => {
    expect(appDatabaseOptions({ POSTGRES_DB: 'game' })).toMatchObject({ database: 'game' });
  });
});
