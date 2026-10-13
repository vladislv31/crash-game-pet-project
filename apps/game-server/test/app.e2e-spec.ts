import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';
import { runMigrations } from './../src/database/run-migrations';
import { APP_LOGGER } from './../src/logging/logger';
import { createTestLogger, LoggedEvent } from './../src/testing/test-logger';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let logged: (name?: string) => LoggedEvent[];

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    const { logger, events } = createTestLogger();
    logged = events;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_LOGGER)
      .useValue(logger)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect('OK');
  });

  it('logs HTTP requests through the app logger, except health checks', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'e2e_logger' })
      .expect(200);

    expect(logged('http.request')).toEqual([
      expect.objectContaining({
        route: '/auth/login',
        statusCode: 200,
        userId: expect.any(String),
      }),
    ]);
  });

  it('serves metrics without logging the scrape', async () => {
    const response = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(response.text).toContain('# TYPE crash_tick_delay_seconds histogram');
    expect(response.text).toContain('# TYPE nodejs_eventloop_lag_p99_seconds gauge');
    expect(logged('http.request')).toEqual([]);
  });

  it('reports no migrations to apply on an up-to-date database', async () => {
    await expect(runMigrations()).resolves.toBe(0);
  });

  afterEach(async () => {
    await app.close();
  });
});
