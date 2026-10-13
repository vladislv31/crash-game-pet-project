import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { APP_LOGGER } from '../logging/logger';
import { InMemoryStore } from '../testing/in-memory-store';
import { createTestLogger, LoggedEvent } from '../testing/test-logger';
import * as crashPoint from './crash-point';
import { GameEvent } from './game-loop';
import { GameLoopService } from './game-loop.service';
import { ROUNDS_STORE } from './rounds.store';

const BETTING_MS = 15_000;
// Longest possible round: crashTimeMs(MAX_CRASH_POINT)
const MAX_RUNNING_MS = 86_078;
// crashTimeMs(500): the fixed crash point used by these tests
const RUNNING_MS = 15_042;

function iso(time: number): string {
  return new Date(time).toISOString();
}

describe('GameLoopService', () => {
  let store: InMemoryStore;
  let app: INestApplication;
  let service: GameLoopService;
  let logged: (name?: string) => LoggedEvent[];
  let gameEvents: GameEvent[];

  beforeEach(async () => {
    jest.useFakeTimers({ now: 0 });
    // A fixed crash point keeps the tests deterministic: a random 1.00x would crash at the start.
    jest.spyOn(crashPoint, 'generateCrashPoint').mockReturnValue(500);
    store = new InMemoryStore();
    const { logger, events } = createTestLogger();
    logged = events;

    const moduleRef = await Test.createTestingModule({
      providers: [
        GameLoopService,
        { provide: ROUNDS_STORE, useValue: store },
        { provide: APP_LOGGER, useValue: logger },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    service = app.get(GameLoopService);
    gameEvents = [];
    service.subscribe(event => gameEvents.push(event));
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /** Starts the app and lets the first round write finish, so betting is open. */
  async function start(): Promise<void> {
    await app.init();
    await jest.advanceTimersByTimeAsync(0);
  }

  function gameEventTypes(): string[] {
    return gameEvents.map(event => event.type);
  }

  it('starts the game loop when the app starts', async () => {
    await start();

    expect(gameEventTypes()).toEqual(['betting']);
  });

  it('stops the game loop when the app shuts down', async () => {
    await start();
    await app.close();
    const eventsAfterClose = gameEvents.length;

    jest.advanceTimersByTime(60_000);

    expect(gameEvents).toHaveLength(eventsAfterClose);
  });

  it('finishes pending round writes before the app shuts down', async () => {
    jest.useRealTimers();
    let finishWrite = () => undefined as void;
    jest
      .spyOn(store, 'create')
      .mockImplementation(() => new Promise<void>(resolve => (finishWrite = resolve)));
    await app.init();

    const closing = app.close();
    const whileWritePending = await Promise.race([
      closing.then(() => 'closed'),
      new Promise(resolve => setTimeout(() => resolve('waiting'), 50)),
    ]);
    finishWrite();
    await closing;

    expect(whileWritePending).toBe('waiting');
  });

  it('opens betting only after the round is stored', async () => {
    let finishWrite = () => undefined as void;
    jest
      .spyOn(store, 'create')
      .mockImplementation(() => new Promise<void>(resolve => (finishWrite = resolve)));

    await start();

    expect(service.currentRoundView()).toBeNull();
    expect(gameEventTypes()).toEqual([]);

    finishWrite();
    await jest.advanceTimersByTimeAsync(0);

    expect(gameEventTypes()).toEqual(['betting']);
  });

  it('logs a failed round write and tries a new round after the pause', async () => {
    jest.spyOn(store, 'create').mockRejectedValueOnce(new Error('database down'));

    await start();

    expect(logged('round.prepare_failed')).toEqual([
      expect.objectContaining({
        level: 'error',
        err: expect.objectContaining({ message: 'database down' }),
      }),
    ]);
    expect(gameEventTypes()).toEqual([]);

    await jest.advanceTimersByTimeAsync(5_000);

    expect(gameEventTypes()).toEqual(['betting']);
  });

  it('continues the last stored round after a restart', async () => {
    await store.create({ id: 'stored', crashPoint: 300, bettingEndsAt: 4_000 });

    await start();

    expect(service.currentRound?.id).toBe('stored');
    expect(service.currentRoundView()).toMatchObject({ phase: 'BETTING', bettingEndsAt: 4_000 });
    expect(store.rounds.size).toBe(1);
  });

  it('continues a stored round that was running at its original start time', async () => {
    jest.setSystemTime(50_000);
    await store.create({ id: 'stored', crashPoint: 500, bettingEndsAt: 48_000 });

    await start();

    expect(service.currentRoundView()).toMatchObject({
      id: 'stored',
      phase: 'RUNNING',
      startedAt: 48_000,
    });
  });

  it('starts a new round when the last stored round is over', async () => {
    jest.setSystemTime(500_000);
    await store.create({ id: 'stored', crashPoint: 200, bettingEndsAt: 1_000 });

    await start();

    expect(service.currentRound?.id).not.toBe('stored');
    expect(store.rounds.size).toBe(2);
  });

  it('stores the next round only after the crash of the previous one is recorded', async () => {
    let finishCrashWrite = () => undefined as void;
    jest
      .spyOn(store, 'markCrashed')
      .mockImplementationOnce(() => new Promise<void>(resolve => (finishCrashWrite = resolve)));
    await start();
    const firstRoundId = service.currentRound!.id;

    await jest.advanceTimersByTimeAsync(BETTING_MS + MAX_RUNNING_MS + 5_000);

    expect(service.currentRound?.id).toBe(firstRoundId);
    expect(store.rounds.size).toBe(1);

    finishCrashWrite();
    await jest.advanceTimersByTimeAsync(0);

    expect(store.rounds.size).toBe(2);
    expect(service.currentRoundView()).toMatchObject({ phase: 'BETTING' });
  });

  it('keeps retrying a failed crash write and opens the next round only after it is stored', async () => {
    let databaseDown = true;
    const markCrashed = store.markCrashed.bind(store);
    jest
      .spyOn(store, 'markCrashed')
      .mockImplementation((id, crashedAt) =>
        databaseDown ? Promise.reject(new Error('database down')) : markCrashed(id, crashedAt),
      );
    await start();
    const firstRoundId = service.currentRound!.id;

    await jest.advanceTimersByTimeAsync(BETTING_MS + MAX_RUNNING_MS + 60_000);

    expect(store.rounds.size).toBe(1);
    expect(store.rounds.get(firstRoundId)?.crashedAt).toBeNull();
    expect(logged('round.crash_write_failed').length).toBeGreaterThan(1);

    databaseDown = false;
    await jest.advanceTimersByTimeAsync(5_000);

    expect(store.rounds.get(firstRoundId)?.crashedAt).toEqual(expect.any(Number));
    expect(store.rounds.size).toBe(2);
  });

  it('stops retrying the crash write when the app shuts down', async () => {
    jest.spyOn(store, 'markCrashed').mockRejectedValue(new Error('database down'));
    await start();
    await jest.advanceTimersByTimeAsync(BETTING_MS + MAX_RUNNING_MS);

    const closing = app.close();
    await jest.advanceTimersByTimeAsync(0);

    await expect(closing).resolves.toBeUndefined();
  });

  it('passes every game event to subscribers', async () => {
    await start();

    jest.advanceTimersByTime(BETTING_MS + MAX_RUNNING_MS);

    expect(gameEventTypes()).toEqual(expect.arrayContaining(['betting', 'started', 'crashed']));
  });

  it('keeps notifying other subscribers when one of them throws', async () => {
    const events: GameEvent[] = [];
    service.subscribe(() => {
      throw new Error('broken subscriber');
    });
    service.subscribe(event => events.push(event));

    await start();

    expect(events.map(event => event.type)).toEqual(['betting']);
  });

  it('logs a subscriber that throws', async () => {
    service.subscribe(() => {
      throw new Error('broken subscriber');
    });

    await start();

    expect(logged('game.subscriber_failed')).toEqual([
      expect.objectContaining({
        level: 'error',
        type: 'betting',
        err: expect.objectContaining({ message: 'broken subscriber' }),
      }),
    ]);
  });

  describe('round log', () => {
    it('logs one event per round once its crash is stored', async () => {
      await start();
      const roundId = service.currentRound!.id;

      await jest.advanceTimersByTimeAsync(BETTING_MS + RUNNING_MS);

      expect(logged('round')).toEqual([
        expect.objectContaining({
          level: 'info',
          roundId,
          crashPoint: 500,
          bettingEndsAt: iso(BETTING_MS),
          startedAt: iso(BETTING_MS),
          crashedAt: iso(BETTING_MS + RUNNING_MS),
          continuedAfterRestart: false,
          crashWriteRetries: 0,
          outcome: 'crashed',
          durationMs: expect.any(Number),
        }),
      ]);
    });

    it('logs nothing else during a round: no phases, no ticks', async () => {
      await start();

      await jest.advanceTimersByTimeAsync(BETTING_MS + RUNNING_MS);

      expect(logged().map(event => event.event)).toEqual(['round']);
    });

    it('waits for the crash write before logging the round', async () => {
      let finishCrashWrite = () => undefined as void;
      jest
        .spyOn(store, 'markCrashed')
        .mockImplementationOnce(() => new Promise<void>(resolve => (finishCrashWrite = resolve)));
      await start();

      await jest.advanceTimersByTimeAsync(BETTING_MS + RUNNING_MS);
      expect(logged('round')).toEqual([]);

      finishCrashWrite();
      await jest.advanceTimersByTimeAsync(0);
      expect(logged('round')).toHaveLength(1);
    });

    it('counts failed crash writes and logs each of them', async () => {
      const markCrashed = store.markCrashed.bind(store);
      jest
        .spyOn(store, 'markCrashed')
        .mockRejectedValueOnce(new Error('database down'))
        .mockRejectedValueOnce(new Error('database down'))
        .mockImplementation(markCrashed);
      await start();
      const roundId = service.currentRound!.id;

      await jest.advanceTimersByTimeAsync(BETTING_MS + RUNNING_MS + 1_000);

      expect(logged('round.crash_write_failed')).toEqual([
        expect.objectContaining({ level: 'error', roundId, retryInMs: 100 }),
        expect.objectContaining({ level: 'error', roundId, retryInMs: 200 }),
      ]);
      expect(logged('round')).toEqual([
        expect.objectContaining({ roundId, crashWriteRetries: 2, outcome: 'crashed' }),
      ]);
    });

    it('logs a round whose crash was not stored before shutdown as an error', async () => {
      jest.spyOn(store, 'markCrashed').mockRejectedValue(new Error('database down'));
      await start();
      const roundId = service.currentRound!.id;
      await jest.advanceTimersByTimeAsync(BETTING_MS + RUNNING_MS);

      const closing = app.close();
      await jest.advanceTimersByTimeAsync(0);
      await closing;

      expect(logged('round')).toEqual([
        expect.objectContaining({ level: 'error', roundId, outcome: 'crash_not_stored' }),
      ]);
    });

    it('logs a round interrupted by shutdown', async () => {
      await start();
      const roundId = service.currentRound!.id;
      await jest.advanceTimersByTimeAsync(BETTING_MS + 1_000);

      await app.close();

      const [round] = logged('round');
      expect(round).toMatchObject({
        level: 'info',
        roundId,
        startedAt: iso(BETTING_MS),
        outcome: 'interrupted',
      });
      expect(round).not.toHaveProperty('crashedAt');
    });

    it('marks a round continued in betting after a restart', async () => {
      await store.create({ id: 'stored', crashPoint: 300, bettingEndsAt: 4_000 });
      await start();

      await app.close();

      expect(logged('round')).toEqual([
        expect.objectContaining({
          roundId: 'stored',
          bettingEndsAt: iso(4_000),
          continuedAfterRestart: true,
        }),
      ]);
    });

    it('marks a round continued in flight after a restart', async () => {
      jest.setSystemTime(50_000);
      await store.create({ id: 'stored', crashPoint: 500, bettingEndsAt: 48_000 });
      await start();

      await app.close();

      expect(logged('round')).toEqual([
        expect.objectContaining({
          roundId: 'stored',
          bettingEndsAt: iso(48_000),
          startedAt: iso(48_000),
          continuedAfterRestart: true,
        }),
      ]);
    });

    it('logs a failed write of the round start', async () => {
      jest.spyOn(store, 'markStarted').mockRejectedValueOnce(new Error('database down'));
      await start();
      const roundId = service.currentRound!.id;

      await jest.advanceTimersByTimeAsync(BETTING_MS);

      expect(logged('round.store_failed')).toEqual([
        expect.objectContaining({
          level: 'error',
          roundId,
          operation: 'markStarted',
          err: expect.objectContaining({ message: 'database down' }),
        }),
      ]);
    });
  });

  it('stores the crash point when betting opens', async () => {
    await start();
    const round = service.currentRound;

    expect(store.rounds.get(round!.id)).toMatchObject({
      crashPoint: round!.crashPoint,
      bettingEndsAt: BETTING_MS,
      startedAt: null,
      crashedAt: null,
    });
  });

  it('records when the round starts and crashes', async () => {
    await start();
    const roundId = service.currentRound!.id;

    jest.advanceTimersByTime(BETTING_MS + MAX_RUNNING_MS);

    expect(store.rounds.get(roundId)?.startedAt).toBe(BETTING_MS);
    expect(store.rounds.get(roundId)?.crashedAt).toEqual(expect.any(Number));
  });

  it('describes the current round without its crash point', async () => {
    await start();
    const roundId = service.currentRound!.id;

    expect(service.currentRoundView()).toEqual({
      id: roundId,
      phase: 'BETTING',
      bettingEndsAt: BETTING_MS,
      startedAt: null,
    });

    jest.advanceTimersByTime(BETTING_MS);

    expect(service.currentRoundView()).toMatchObject({ phase: 'RUNNING', startedAt: BETTING_MS });
  });

  it('has no round before the app starts', () => {
    expect(service.currentRoundView()).toBeNull();
  });
});
