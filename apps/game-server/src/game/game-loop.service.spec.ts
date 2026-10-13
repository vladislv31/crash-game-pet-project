import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { InMemoryStore } from '../testing/in-memory-store';
import { GameEvent } from './game-loop';
import { GameLoopService } from './game-loop.service';
import { ROUNDS_STORE } from './rounds.store';

const BETTING_MS = 15_000;
// Longest possible round: crashTimeMs(MAX_CRASH_POINT)
const MAX_RUNNING_MS = 86_078;

describe('GameLoopService', () => {
  let logSpy: jest.SpyInstance;
  let store: InMemoryStore;
  let app: INestApplication;
  let service: GameLoopService;

  beforeEach(async () => {
    jest.useFakeTimers({ now: 0 });
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    store = new InMemoryStore();

    const moduleRef = await Test.createTestingModule({
      providers: [GameLoopService, { provide: ROUNDS_STORE, useValue: store }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    service = app.get(GameLoopService);
  });

  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  // Nest logs its own string messages through the same Logger; keep only game events.
  function loggedEventTypes(): unknown[] {
    return logSpy.mock.calls
      .map(([message]: unknown[]) => message)
      .filter(
        (message): message is { type: unknown } =>
          typeof message === 'object' && message !== null && 'type' in message,
      )
      .map(message => message.type);
  }

  it('starts the game loop when the app starts and logs the betting phase', async () => {
    await app.init();

    expect(loggedEventTypes()).toEqual(['betting']);
  });

  it('logs the round lifecycle', async () => {
    await app.init();

    jest.advanceTimersByTime(BETTING_MS + MAX_RUNNING_MS);

    expect(loggedEventTypes()).toEqual(expect.arrayContaining(['betting', 'started', 'crashed']));
  });

  it('stops the game loop when the app shuts down', async () => {
    await app.init();
    await app.close();
    const callsAfterClose = logSpy.mock.calls.length;

    jest.advanceTimersByTime(60_000);

    expect(logSpy.mock.calls).toHaveLength(callsAfterClose);
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

  it('passes every game event to subscribers', async () => {
    const events: GameEvent[] = [];
    service.subscribe(event => events.push(event));
    await app.init();

    jest.advanceTimersByTime(BETTING_MS + MAX_RUNNING_MS);

    expect(events.map(event => event.type)).toEqual(
      expect.arrayContaining(['betting', 'started', 'crashed']),
    );
  });

  it('keeps notifying other subscribers when one of them throws', async () => {
    const events: GameEvent[] = [];
    service.subscribe(() => {
      throw new Error('broken subscriber');
    });
    service.subscribe(event => events.push(event));

    await app.init();

    expect(events.map(event => event.type)).toEqual(['betting']);
  });

  it('stores the crash point when betting opens', async () => {
    await app.init();
    const round = service.currentRound;

    expect(store.rounds.get(round!.id)).toMatchObject({
      crashPoint: round!.crashPoint,
      bettingEndsAt: BETTING_MS,
      startedAt: null,
      crashedAt: null,
    });
  });

  it('records when the round starts and crashes', async () => {
    await app.init();
    const roundId = service.currentRound!.id;

    jest.advanceTimersByTime(BETTING_MS + MAX_RUNNING_MS);

    expect(store.rounds.get(roundId)?.startedAt).toBe(BETTING_MS);
    expect(store.rounds.get(roundId)?.crashedAt).toEqual(expect.any(Number));
  });

  it('describes the current round without its crash point', async () => {
    await app.init();
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
