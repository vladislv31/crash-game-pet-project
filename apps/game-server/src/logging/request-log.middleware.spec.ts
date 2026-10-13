import { EventEmitter } from 'node:events';

import {
  Controller,
  Get,
  INestApplication,
  InternalServerErrorException,
  Res,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';

import { createTestLogger, LoggedEvent } from '../testing/test-logger';
import { APP_LOGGER } from './logger';
import { LoggingModule } from './logging.module';
import { RequestLogMiddleware, requestLogOf } from './request-log.middleware';

@Controller()
class TestController {
  @Get('ok')
  ok(@Res({ passthrough: true }) res: Response): string {
    requestLogOf(res)?.set({ userId: 'user-1' });
    return 'ok';
  }

  @Get('fail')
  fail(): never {
    throw new InternalServerErrorException();
  }

  @Get('health')
  health(): string {
    return 'OK';
  }

  @Get('metrics')
  metrics(): string {
    return '';
  }
}

describe('RequestLogMiddleware', () => {
  let app: INestApplication<App>;
  let logged: (name?: string) => LoggedEvent[];

  beforeEach(async () => {
    const { logger, events } = createTestLogger();
    logged = events;
    const moduleRef = await Test.createTestingModule({
      imports: [LoggingModule],
      controllers: [TestController],
    })
      .overrideProvider(APP_LOGGER)
      .useValue(logger)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('logs one event per request', async () => {
    const response = await request(app.getHttpServer()).get('/ok');

    expect(logged('http.request')).toEqual([
      expect.objectContaining({
        level: 'info',
        requestId: response.headers['x-request-id'],
        method: 'GET',
        route: '/ok',
        statusCode: 200,
        outcome: 'ok',
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it('returns a generated request id', async () => {
    const response = await request(app.getHttpServer()).get('/ok');

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the request id the caller sent', async () => {
    const response = await request(app.getHttpServer()).get('/ok').set('x-request-id', 'abc-123');

    expect(response.headers['x-request-id']).toBe('abc-123');
    expect(logged('http.request')[0]).toMatchObject({ requestId: 'abc-123' });
  });

  it.each([['x'.repeat(129)], ['has spaces'], ['<script>']])(
    'replaces an unusable request id %p',
    async requestId => {
      const response = await request(app.getHttpServer()).get('/ok').set('x-request-id', requestId);

      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('includes the fields the handler added', async () => {
    await request(app.getHttpServer()).get('/ok');

    expect(logged('http.request')[0]).toMatchObject({ userId: 'user-1' });
  });

  it('logs the path without the query string', async () => {
    await request(app.getHttpServer()).get('/ok?token=secret');

    expect(logged('http.request')[0]).toMatchObject({ route: '/ok' });
    expect(JSON.stringify(logged())).not.toContain('secret');
  });

  it('logs a client error at info level', async () => {
    await request(app.getHttpServer()).get('/missing');

    expect(logged('http.request')[0]).toMatchObject({
      level: 'info',
      route: '/missing',
      statusCode: 404,
      outcome: 'client_error',
    });
  });

  it('logs a server error at error level', async () => {
    await request(app.getHttpServer()).get('/fail');

    expect(logged('http.request')[0]).toMatchObject({
      level: 'error',
      statusCode: 500,
      outcome: 'server_error',
    });
  });

  it.each([['/health'], ['/metrics']])('does not log %s', async path => {
    await request(app.getHttpServer()).get(path).expect(200);

    expect(logged('http.request')).toEqual([]);
  });

  it('logs a request the client aborted', () => {
    const { logger, events } = createTestLogger();
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      locals: {},
      setHeader: () => undefined,
    });
    const next = jest.fn();

    new RequestLogMiddleware(logger).use(
      { method: 'GET', originalUrl: '/ok', headers: {} } as Request,
      res as unknown as Response,
      next,
    );
    res.emit('close');

    expect(next).toHaveBeenCalled();
    expect(events('http.request')[0]).toMatchObject({ outcome: 'aborted' });
  });
});
