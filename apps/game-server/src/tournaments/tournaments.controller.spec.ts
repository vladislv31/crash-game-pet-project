import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { APP_LOGGER } from '../logging/logger';
import { LoggingModule } from '../logging/logging.module';
import {
  InMemoryLeaderboardCache,
  InMemoryTournamentsStore,
} from '../testing/in-memory-tournaments';
import { createTestLogger, LoggedEvent } from '../testing/test-logger';
import { LEADERBOARD_CACHE } from './leaderboard-cache';
import { TournamentsController } from './tournaments.controller';
import { TOURNAMENT_INTERVALS, TournamentsService } from './tournaments.service';
import { TOURNAMENTS_STORE } from './tournaments.store';

const NOW = 1_700_000_000_000;

describe('TournamentsController', () => {
  let app: INestApplication<App>;
  let store: InMemoryTournamentsStore;
  let logged: (name?: string) => LoggedEvent[];

  beforeEach(async () => {
    let now = NOW;
    store = new InMemoryTournamentsStore(() => now++);
    const { logger, events } = createTestLogger();
    logged = events;
    const moduleRef = await Test.createTestingModule({
      imports: [LoggingModule],
      controllers: [TournamentsController],
      providers: [
        TournamentsService,
        { provide: TOURNAMENTS_STORE, useValue: store },
        { provide: LEADERBOARD_CACHE, useValue: new InMemoryLeaderboardCache() },
        { provide: TOURNAMENT_INTERVALS, useValue: { snapshotMs: 0, rebuildMs: 0 } },
      ],
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

  function getActive() {
    return request(app.getHttpServer()).get('/tournaments/active');
  }

  function putActive(body?: unknown) {
    const put = request(app.getHttpServer()).put('/tournaments/active');
    return body === undefined ? put : put.send(body as object);
  }

  it('reports no tournament before one was ever run', async () => {
    const response = await getActive();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tournament: null, active: false });
  });

  it('starts a tournament, with dates as epoch milliseconds', async () => {
    const response = await putActive({ active: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      tournament: { id: store.tournaments[0]!.id, startedAt: NOW, endedAt: null },
      active: true,
    });
  });

  it('reports the running tournament', async () => {
    const started = await putActive({ active: true });

    const response = await getActive();

    expect(response.body).toEqual(started.body);
  });

  it('stops the running tournament', async () => {
    await putActive({ active: true });

    const response = await putActive({ active: false });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      tournament: { id: store.tournaments[0]!.id, startedAt: NOW, endedAt: NOW + 1 },
      active: false,
    });
  });

  it('is idempotent', async () => {
    const first = await putActive({ active: true });
    const second = await putActive({ active: true });

    expect(second.body).toEqual(first.body);
    expect(store.tournaments).toHaveLength(1);
  });

  it('logs the switch with the tournament id', async () => {
    const response = await putActive({ active: true });

    expect(logged('http.request')).toEqual([
      expect.objectContaining({
        route: '/tournaments/active',
        statusCode: 200,
        tournamentId: response.body.tournament.id,
      }),
    ]);
  });

  it.each([[{ active: 'true' }], [{ active: 1 }], [{ active: null }], [{}], [[true]]])(
    'rejects %p with 422',
    async body => {
      const response = await putActive(body);

      expect(response.status).toBe(422);
      expect(response.body).toEqual({ errors: { active: 'invalid' } });
      expect(store.tournaments).toEqual([]);
    },
  );

  it('rejects a request without a body with 422', async () => {
    const response = await putActive();

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ errors: { active: 'invalid' } });
  });
});
