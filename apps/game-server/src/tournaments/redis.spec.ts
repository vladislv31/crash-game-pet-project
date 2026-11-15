import { redisOptions } from './redis';

describe('redisOptions', () => {
  it('defaults to the docker-compose Redis', () => {
    expect(redisOptions({})).toMatchObject({ host: 'localhost', port: 6379, db: 0 });
  });

  it('reads the connection from the environment', () => {
    expect(redisOptions({ REDIS_HOST: 'cache', REDIS_PORT: '6380', REDIS_DB: '1' })).toMatchObject({
      host: 'cache',
      port: 6380,
      db: 1,
    });
  });

  it('fails commands at once while Redis is down instead of queueing them', () => {
    expect(redisOptions({}).enableOfflineQueue).toBe(false);
  });
});
