import { Registry } from 'prom-client';

import { GameEvent } from '../game/game-loop';
import { crashTimeMs } from '../game/multiplier';
import { Round } from '../game/round';
import { Metrics } from '../metrics/metrics';
import { InMemoryStore } from '../testing/in-memory-store';
import { createTestLogger } from '../testing/test-logger';
import { User } from '../users/user';
import { BettingError } from './betting.errors';
import { BettingMetrics } from './betting.metrics';
import { BettingEvent, BettingService, GameSource } from './betting.service';

const STARTED_AT = 1_000_000;

/** Server time at which the multiplier first reaches `multiplier` (in hundredths). */
function at(multiplier: number): number {
  return STARTED_AT + crashTimeMs(multiplier);
}

/** The current value of a metric series, or undefined when the series has not been recorded. */
async function sample(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const metric = registry.getSingleMetric(name);
  if (!metric) {
    throw new Error(`No metric ${name} on the registry`);
  }
  const { values } = await metric.get();
  return values.find(
    value =>
      Object.keys(value.labels).length === Object.keys(labels).length &&
      Object.entries(labels).every(([key, label]) => value.labels[key] === label),
  )?.value;
}

async function setup(crashPoint = 500) {
  // The database clock; betting for round-1 ends at STARTED_AT.
  let databaseTime = STARTED_AT - 1_000;
  const store = new InMemoryStore(() => databaseTime);
  const game: { currentRound: Round | null; subscribe: GameSource['subscribe'] } = {
    currentRound: new Round('round-1', crashPoint),
    subscribe: () => undefined,
  };
  await store.create({ id: 'round-1', crashPoint, bettingEndsAt: STARTED_AT });
  const { logger, events: logged } = createTestLogger();
  const metrics = new Metrics();
  const bettingMetrics = new BettingMetrics(metrics);
  const service = new BettingService(store, game, logger, bettingMetrics);
  const events: BettingEvent[] = [];
  service.subscribe(event => events.push(event));
  const user = await store.findOrCreate('alice', '5000', 'token-alice');

  function round(): Round {
    if (!game.currentRound) {
      throw new Error('No round in test setup');
    }
    return game.currentRound;
  }

  function placeBet(
    amount = '100',
    autoCashout?: number,
    requestId = 'bet-1',
    player: User = user,
  ) {
    return service.placeBet(player, { requestId, amount, autoCashout });
  }

  function setDatabaseTime(time: number) {
    databaseTime = time;
  }

  return {
    store,
    game,
    service,
    events,
    logger,
    logged,
    bettingMetrics,
    registry: metrics.registry,
    user,
    round,
    placeBet,
    setDatabaseTime,
  };
}

function expectBettingError(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ name: BettingError.name, code });
}

describe('BettingService', () => {
  describe('placeBet', () => {
    it('debits the balance and returns the active bet', async () => {
      const { placeBet } = await setup();

      const result = await placeBet('250.5', 200);

      expect(result.balance).toBe('4749.5');
      expect(result.bet).toMatchObject({
        roundId: 'round-1',
        username: 'alice',
        amount: '250.5',
        autoCashout: 200,
        status: 'ACTIVE',
      });
    });

    it('announces the new bet', async () => {
      const { placeBet, events } = await setup();

      const { bet } = await placeBet();

      expect(events).toEqual([{ type: 'bet_placed', bet }]);
    });

    it('reports every invalid field at once', async () => {
      const { placeBet } = await setup();

      await expect(placeBet('50', 100)).rejects.toMatchObject({
        code: 'validation_failed',
        errors: { amount: 'too_low', autoCashout: 'too_low' },
      });
    });

    it('rejects bets once the round is running', async () => {
      const { placeBet, round } = await setup();
      round().start(STARTED_AT);

      await expectBettingError(placeBet(), 'betting_closed');
    });

    it('rejects bets when there is no round yet', async () => {
      const { placeBet, game } = await setup();
      game.currentRound = null;

      await expectBettingError(placeBet(), 'betting_closed');
    });

    it('does not create a bet whose write lands after betting ended', async () => {
      const { placeBet, store, user, events, setDatabaseTime } = await setup();
      setDatabaseTime(STARTED_AT);

      await expectBettingError(placeBet(), 'betting_closed');
      expect(store.users.get(user.id)?.balance).toBe('5000');
      expect(store.bets.size).toBe(0);
      expect(store.ledger.filter(entry => entry.type === 'BET')).toEqual([]);
      expect(events).toEqual([]);
    });

    it('does not create a late bet with auto-cashout either', async () => {
      const { placeBet, store, setDatabaseTime } = await setup();
      setDatabaseTime(STARTED_AT + 500);

      await expectBettingError(placeBet('100', 150), 'betting_closed');
      expect(store.bets.size).toBe(0);
    });

    it('accepts a bet written in the last millisecond of betting', async () => {
      const { placeBet, setDatabaseTime } = await setup();
      setDatabaseTime(STARTED_AT - 1);

      await expect(placeBet()).resolves.toMatchObject({ balance: '4900' });
    });

    it('rejects a bet larger than the balance', async () => {
      const { placeBet, store, user } = await setup();
      store.users.get(user.id)!.balance = '99.99';

      await expectBettingError(placeBet('100'), 'insufficient_funds');
      expect(store.users.get(user.id)?.balance).toBe('99.99');
    });

    it('rejects a second bet in the same round', async () => {
      const { placeBet } = await setup();
      await placeBet('100', undefined, 'bet-1');

      await expectBettingError(placeBet('100', undefined, 'bet-2'), 'already_bet');
    });

    it('returns the original bet for a retried request without debiting again', async () => {
      const { placeBet, events, store, user } = await setup();
      const first = await placeBet('100', undefined, 'bet-1');

      const retry = await placeBet('100', undefined, 'bet-1');

      expect(retry.bet).toEqual(first.bet);
      expect(store.users.get(user.id)?.balance).toBe('4900');
      expect(events).toHaveLength(1);
    });

    it('returns the original bet for a request retried after betting closed', async () => {
      const { placeBet, round } = await setup();
      const first = await placeBet('100', undefined, 'bet-1');
      round().start(STARTED_AT);

      await expect(placeBet('100', undefined, 'bet-1')).resolves.toMatchObject({
        bet: first.bet,
        balance: first.balance,
      });
    });

    it('marks a new bet as not replayed', async () => {
      const { placeBet } = await setup();

      await expect(placeBet()).resolves.toMatchObject({ replayed: false });
    });

    it('marks a retried bet as replayed', async () => {
      const { placeBet } = await setup();
      await placeBet('100', undefined, 'bet-1');

      await expect(placeBet('100', undefined, 'bet-1')).resolves.toMatchObject({ replayed: true });
    });

    it('marks all but one of concurrent identical requests as replayed', async () => {
      const { placeBet } = await setup();

      const results = await Promise.all([placeBet(), placeBet(), placeBet()]);

      expect(results.map(result => result.replayed).sort()).toEqual([false, true, true]);
    });

    it('rejects a reused request id with a different bet', async () => {
      const { placeBet, store, user } = await setup();
      await placeBet('100', undefined, 'bet-1');

      await expectBettingError(placeBet('200', undefined, 'bet-1'), 'request_conflict');
      await expectBettingError(placeBet('100', 150, 'bet-1'), 'request_conflict');
      expect(store.users.get(user.id)?.balance).toBe('4900');
    });

    it('decides whether betting is open when the request arrives, not after looking up retries', async () => {
      const { placeBet, round, store } = await setup();
      let finishLookup = () => undefined as void;
      jest
        .spyOn(store, 'findBetByRequest')
        .mockImplementationOnce(() => new Promise(resolve => (finishLookup = () => resolve(null))));

      const pending = placeBet('100');
      round().start(STARTED_AT);
      finishLookup();

      await expect(pending).resolves.toMatchObject({ balance: '4900' });
    });

    it('debits once when the same request arrives concurrently', async () => {
      const { placeBet, store, user } = await setup();

      await Promise.all([placeBet(), placeBet(), placeBet()]);

      expect(store.users.get(user.id)?.balance).toBe('4900');
    });
  });

  describe('cashOut', () => {
    it('pays the bet at the multiplier when the request was received', async () => {
      const { placeBet, service, round, user } = await setup(500);
      await placeBet('100');
      round().start(STARTED_AT);

      const result = await service.cashOut(user, at(198));

      expect(result.balance).toBe('5098');
      expect(result.bet).toMatchObject({
        status: 'CASHED_OUT',
        cashoutMultiplier: 198,
        payout: '198',
      });
    });

    it('announces the cashout', async () => {
      const { placeBet, service, round, user, events } = await setup(500);
      await placeBet();
      round().start(STARTED_AT);

      const { bet, balance } = await service.cashOut(user, at(198));

      expect(events.at(-1)).toEqual({ type: 'cashed_out', bet, balance });
    });

    it('rejects a cashout during betting', async () => {
      const { placeBet, service, user } = await setup();
      await placeBet();

      await expectBettingError(service.cashOut(user, STARTED_AT), 'cashout_closed');
    });

    it('rejects a cashout received when the multiplier has reached the crash point', async () => {
      const { placeBet, service, round, user } = await setup(200);
      await placeBet();
      round().start(STARTED_AT);

      await expectBettingError(service.cashOut(user, at(200)), 'cashout_closed');
    });

    it('rejects a cashout after the round crashed', async () => {
      const { placeBet, service, round, user } = await setup(200);
      await placeBet();
      round().start(STARTED_AT);
      round().crash(at(200));

      await expectBettingError(service.cashOut(user, at(150)), 'cashout_closed');
    });

    it('rejects a cashout from a player without a bet', async () => {
      const { service, round, user } = await setup();
      round().start(STARTED_AT);

      await expectBettingError(service.cashOut(user, at(150)), 'no_active_bet');
    });

    it('pays exactly once when the same cashout arrives concurrently', async () => {
      const { placeBet, service, round, user, store, events } = await setup(500);
      await placeBet('100');
      round().start(STARTED_AT);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.cashOut(user, at(150))),
      );

      expect(new Set(results.map(result => result.bet.payout))).toEqual(new Set(['150']));
      expect(store.ledger.filter(entry => entry.type === 'WIN')).toHaveLength(1);
      expect(store.users.get(user.id)?.balance).toBe('5050');
      expect(events.filter(event => event.type === 'cashed_out')).toHaveLength(1);
    });

    it('returns the original result when a cashout is repeated', async () => {
      const { placeBet, service, round, user, store } = await setup(500);
      await placeBet('100');
      round().start(STARTED_AT);
      const first = await service.cashOut(user, at(150));

      const repeated = await service.cashOut(user, at(180));

      expect(repeated).toMatchObject({ bet: first.bet, balance: first.balance });
      expect(store.ledger.filter(entry => entry.type === 'WIN')).toHaveLength(1);
    });

    it('marks a paid cashout as not replayed', async () => {
      const { placeBet, service, round, user } = await setup(500);
      await placeBet('100');
      round().start(STARTED_AT);

      await expect(service.cashOut(user, at(150))).resolves.toMatchObject({ replayed: false });
    });

    it('marks a repeated cashout as replayed', async () => {
      const { placeBet, service, round, user } = await setup(500);
      await placeBet('100');
      round().start(STARTED_AT);
      await service.cashOut(user, at(150));

      await expect(service.cashOut(user, at(180))).resolves.toMatchObject({ replayed: true });
    });

    it('marks a cashout after the auto-cashout paid as replayed', async () => {
      const { placeBet, service, round, user } = await setup(500);
      await placeBet('100', 150);
      round().start(STARTED_AT);
      await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 150 });

      await expect(service.cashOut(user, at(180))).resolves.toMatchObject({
        replayed: true,
        bet: { cashoutMultiplier: 150 },
      });
    });

    it('rejects a cashout of a bet that was already lost', async () => {
      const { placeBet, service, round, user, store } = await setup(500);
      const { bet } = await placeBet('100');
      round().start(STARTED_AT);
      await store.markLost(bet.id);

      await expectBettingError(service.cashOut(user, at(150)), 'already_settled');
    });

    it('pays the auto-cashout target when a manual cashout arrives after it', async () => {
      const { placeBet, service, round, user } = await setup(500);
      await placeBet('100', 150);
      round().start(STARTED_AT);

      const result = await service.cashOut(user, at(200));

      expect(result.bet).toMatchObject({ cashoutMultiplier: 150, payout: '150' });
    });

    it('never pays more than the max win', async () => {
      const { placeBet, service, round, user } = await setup(20_000);
      await placeBet('1000');
      round().start(STARTED_AT);

      const result = await service.cashOut(user, at(15_000));

      expect(result.bet).toMatchObject({ cashoutMultiplier: 10_000, payout: '100000' });
    });
  });

  describe('auto-cashout', () => {
    it('pays at the target, not at the tick multiplier, once a tick reaches it', async () => {
      const { placeBet, service, round, store, user } = await setup(500);
      const { bet } = await placeBet('100', 150);
      round().start(STARTED_AT);

      await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 153 });

      expect(store.bets.get(bet.id)).toMatchObject({
        status: 'CASHED_OUT',
        cashoutMultiplier: 150,
      });
      expect(store.users.get(user.id)?.balance).toBe('5050');
    });

    it('announces the auto-cashout with the new balance', async () => {
      const { placeBet, service, round, events } = await setup(500);
      await placeBet('100', 150);
      round().start(STARTED_AT);

      await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 150 });

      expect(events.at(-1)).toMatchObject({
        type: 'cashed_out',
        bet: { cashoutMultiplier: 150 },
        balance: '5050',
      });
    });

    it('waits while ticks are below the target', async () => {
      const { placeBet, service, round, store } = await setup(500);
      const { bet } = await placeBet('100', 150);
      round().start(STARTED_AT);

      await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 149 });

      expect(store.bets.get(bet.id)?.status).toBe('ACTIVE');
    });

    it('pays only once across consecutive ticks', async () => {
      const { placeBet, service, round, store } = await setup(500);
      await placeBet('100', 150);
      round().start(STARTED_AT);

      await Promise.all([
        service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 150 }),
        service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 151 }),
      ]);

      expect(store.ledger.filter(entry => entry.type === 'WIN')).toHaveLength(1);
    });

    it('pays a target between the last tick and the crash point at the crash', async () => {
      const { placeBet, service, round, store } = await setup(160);
      const { bet } = await placeBet('100', 155);
      round().start(STARTED_AT);

      await service.handleGameEvent({
        type: 'crashed',
        roundId: 'round-1',
        crashPoint: 160,
        crashedAt: at(160),
      });

      expect(store.bets.get(bet.id)).toMatchObject({
        status: 'CASHED_OUT',
        cashoutMultiplier: 155,
      });
    });

    it('logs a tick that paid auto-cashouts', async () => {
      const { placeBet, service, round, store, logged } = await setup(500);
      const bob = await store.findOrCreate('bob', '5000', 'token-bob');
      await placeBet('100', 150);
      await placeBet('100', 200, 'bet-2', bob);
      round().start(STARTED_AT);

      await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 153 });

      expect(logged('auto_cashout')).toEqual([
        expect.objectContaining({
          level: 'info',
          roundId: 'round-1',
          trigger: 'tick',
          multiplier: 153,
          due: 1,
          paid: 1,
          failed: 0,
          durationMs: expect.any(Number),
        }),
      ]);
    });

    it('does not log ticks that paid nothing', async () => {
      const { placeBet, service, round, logged } = await setup(500);
      await placeBet('100', 150);
      round().start(STARTED_AT);

      await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 149 });

      expect(logged('auto_cashout')).toEqual([]);
    });

    it('logs auto-cashouts paid at the crash with the crash point', async () => {
      const { placeBet, service, round, logged } = await setup(160);
      await placeBet('100', 155);
      round().start(STARTED_AT);

      await service.handleGameEvent({
        type: 'crashed',
        roundId: 'round-1',
        crashPoint: 160,
        crashedAt: at(160),
      });

      expect(logged('auto_cashout')).toEqual([
        expect.objectContaining({ trigger: 'crash', multiplier: 160, due: 1, paid: 1 }),
      ]);
    });

    it('keeps paying the other bets when one auto-cashout fails, and logs the failure', async () => {
      const { placeBet, service, round, store, user, logged } = await setup(500);
      const bob = await store.findOrCreate('bob', '5000', 'token-bob');
      await placeBet('100', 150);
      await placeBet('100', 150, 'bet-2', bob);
      round().start(STARTED_AT);
      jest.spyOn(store, 'cashOut').mockRejectedValueOnce(new Error('database down'));

      await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 150 });

      expect(store.ledger.filter(entry => entry.type === 'WIN')).toHaveLength(1);
      expect([store.users.get(user.id)?.balance, store.users.get(bob.id)?.balance].sort()).toEqual([
        '4900',
        '5050',
      ]);
      expect(logged('auto_cashout')).toEqual([
        expect.objectContaining({
          level: 'error',
          due: 2,
          paid: 1,
          failed: 1,
          err: expect.objectContaining({ message: 'database down' }),
        }),
      ]);
    });

    it('leaves a target at or above the crash point unpaid', async () => {
      const { placeBet, service, round, store } = await setup(160);
      const { bet } = await placeBet('100', 160);
      round().start(STARTED_AT);

      await service.handleGameEvent({
        type: 'crashed',
        roundId: 'round-1',
        crashPoint: 160,
        crashedAt: at(160),
      });

      expect(store.bets.get(bet.id)?.status).toBe('ACTIVE');
    });

    describe('metrics', () => {
      it('counts auto-cashouts paid on a tick', async () => {
        const { placeBet, service, round, registry } = await setup(500);
        await placeBet('100', 150);
        round().start(STARTED_AT);

        await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 153 });

        expect(
          await sample(registry, 'crash_auto_cashouts_total', { trigger: 'tick', result: 'paid' }),
        ).toBe(1);
      });

      it('counts auto-cashouts paid at the crash', async () => {
        const { placeBet, service, round, registry } = await setup(160);
        await placeBet('100', 155);
        round().start(STARTED_AT);

        await service.handleGameEvent({
          type: 'crashed',
          roundId: 'round-1',
          crashPoint: 160,
          crashedAt: at(160),
        });

        expect(
          await sample(registry, 'crash_auto_cashouts_total', { trigger: 'crash', result: 'paid' }),
        ).toBe(1);
        expect(
          await sample(registry, 'crash_auto_cashouts_total', { trigger: 'tick', result: 'paid' }),
        ).toBeUndefined();
      });

      it('counts a due bet that was already settled as skipped', async () => {
        const { placeBet, service, round, store, registry } = await setup(500);
        const bob = await store.findOrCreate('bob', '5000', 'token-bob');
        await placeBet('100', 150);
        await placeBet('100', 150, 'bet-2', bob);
        round().start(STARTED_AT);
        jest.spyOn(store, 'cashOut').mockResolvedValueOnce(null);

        await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 150 });

        const labels = { trigger: 'tick' };
        expect(
          await sample(registry, 'crash_auto_cashouts_total', { ...labels, result: 'skipped' }),
        ).toBe(1);
        expect(
          await sample(registry, 'crash_auto_cashouts_total', { ...labels, result: 'paid' }),
        ).toBe(1);
        expect(
          await sample(registry, 'crash_auto_cashouts_total', { ...labels, result: 'failed' }),
        ).toBe(0);
      });

      it('counts a failed auto-cashout while the other bets are still paid', async () => {
        const { placeBet, service, round, store, registry } = await setup(500);
        const bob = await store.findOrCreate('bob', '5000', 'token-bob');
        const carol = await store.findOrCreate('carol', '5000', 'token-carol');
        await placeBet('100', 150);
        await placeBet('100', 150, 'bet-2', bob);
        await placeBet('100', 150, 'bet-3', carol);
        round().start(STARTED_AT);
        jest.spyOn(store, 'cashOut').mockRejectedValueOnce(new Error('database down'));

        await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 150 });

        const labels = { trigger: 'tick' };
        expect(
          await sample(registry, 'crash_auto_cashouts_total', { ...labels, result: 'failed' }),
        ).toBe(1);
        expect(
          await sample(registry, 'crash_auto_cashouts_total', { ...labels, result: 'paid' }),
        ).toBe(2);
        expect(
          await sample(registry, 'crash_auto_cashouts_total', { ...labels, result: 'skipped' }),
        ).toBe(0);
      });

      it('adds up the auto-cashouts of consecutive passes', async () => {
        const { placeBet, service, round, store, registry } = await setup(500);
        const bob = await store.findOrCreate('bob', '5000', 'token-bob');
        await placeBet('100', 150);
        await placeBet('100', 200, 'bet-2', bob);
        round().start(STARTED_AT);

        await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 150 });
        await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 200 });

        expect(
          await sample(registry, 'crash_auto_cashouts_total', { trigger: 'tick', result: 'paid' }),
        ).toBe(2);
      });

      it('counts nothing for a tick with no bet due', async () => {
        const { placeBet, service, round, registry } = await setup(500);
        await placeBet('100', 150);
        round().start(STARTED_AT);

        await service.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 149 });

        expect(
          await sample(registry, 'crash_auto_cashouts_total', { trigger: 'tick', result: 'paid' }),
        ).toBeUndefined();
      });
    });
  });

  describe('after a restart', () => {
    it('pays auto-cashouts of a continued round from the bets in the store', async () => {
      const { store, user, game, logger, bettingMetrics } = await setup(500);
      const placed = await store.placeBet({
        userId: user.id,
        username: user.username,
        roundId: 'round-1',
        amount: '100',
        autoCashout: 150,
        idempotencyKey: 'before-restart',
      });
      const restarted = new BettingService(store, game, logger, bettingMetrics);

      await restarted.handleGameEvent({
        type: 'started',
        roundId: 'round-1',
        startedAt: STARTED_AT,
      });
      await restarted.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 151 });

      expect(placed.status).toBe('placed');
      expect(store.ledger.filter(entry => entry.type === 'WIN')).toHaveLength(1);
    });

    it('logs a failure to reload the bets of a continued round', async () => {
      const { store, game, logger, logged, bettingMetrics } = await setup(500);
      let notify = (_event: GameEvent) => undefined as void;
      const restarted = new BettingService(
        store,
        { ...game, subscribe: listener => (notify = listener) },
        logger,
        bettingMetrics,
      );
      restarted.onModuleInit();
      jest.spyOn(store, 'findActiveBets').mockRejectedValueOnce(new Error('database down'));

      notify({ type: 'started', roundId: 'round-1', startedAt: STARTED_AT });
      await new Promise(resolve => setImmediate(resolve));

      expect(logged('betting.game_event_failed')).toEqual([
        expect.objectContaining({
          level: 'error',
          type: 'started',
          err: expect.objectContaining({ message: 'database down' }),
        }),
      ]);
    });
  });

  describe('shutdown', () => {
    it('counts money operations in progress', async () => {
      const { placeBet, service, store } = await setup();
      let finishWrite = () => undefined as void;
      const realPlaceBet = store.placeBet.bind(store);
      jest
        .spyOn(store, 'placeBet')
        .mockImplementationOnce(
          input => new Promise(resolve => (finishWrite = () => resolve(realPlaceBet(input)))),
        );

      expect(service.inFlightCount).toBe(0);

      const pending = placeBet();
      expect(service.inFlightCount).toBe(1);

      await Promise.resolve();
      finishWrite();
      await pending;
      await service.drain();
      expect(service.inFlightCount).toBe(0);
    });

    it('also waits for operations that start while it is draining', async () => {
      const { placeBet, service, store, user } = await setup();
      const bob = await store.findOrCreate('bob', '5000', 'token-bob');
      const finishWrites: (() => void)[] = [];
      const realPlaceBet = store.placeBet.bind(store);
      jest
        .spyOn(store, 'placeBet')
        .mockImplementation(
          input => new Promise(resolve => finishWrites.push(() => resolve(realPlaceBet(input)))),
        );
      const flush = () => new Promise(resolve => setImmediate(resolve));
      void placeBet('100', undefined, 'first', user);
      await flush();

      let drained = false;
      const draining = service.drain().then(() => (drained = true));
      void placeBet('100', undefined, 'second', bob);
      await flush();
      finishWrites[0]?.();
      await flush();

      expect(drained).toBe(false);

      finishWrites[1]?.();
      await draining;
      expect(drained).toBe(true);
    });

    it('waits for bets that are still being written', async () => {
      const { placeBet, service, store } = await setup();
      let finishWrite = () => undefined as void;
      const realPlaceBet = store.placeBet.bind(store);
      jest
        .spyOn(store, 'placeBet')
        .mockImplementationOnce(
          input => new Promise(resolve => (finishWrite = () => resolve(realPlaceBet(input)))),
        );
      const pending = placeBet();

      let drained = false;
      const draining = service.drain().then(() => (drained = true));
      await Promise.resolve();
      expect(drained).toBe(false);

      finishWrite();
      await draining;
      await expect(pending).resolves.toMatchObject({ balance: '4900' });
    });

    it('reports money operations in progress at scrape time', async () => {
      const { placeBet, service, store, registry } = await setup();
      let finishWrite = () => undefined as void;
      const realPlaceBet = store.placeBet.bind(store);
      jest
        .spyOn(store, 'placeBet')
        .mockImplementationOnce(
          input => new Promise(resolve => (finishWrite = () => resolve(realPlaceBet(input)))),
        );

      expect(await sample(registry, 'crash_money_ops_in_flight')).toBe(0);

      const pending = placeBet();
      expect(await sample(registry, 'crash_money_ops_in_flight')).toBe(1);

      finishWrite();
      await pending;
      await service.drain();
      expect(await sample(registry, 'crash_money_ops_in_flight')).toBe(0);
    });
  });

  describe('settling crashed rounds', () => {
    async function crash(store: InMemoryStore, service: BettingService, crashPoint: number) {
      await store.markCrashed('round-1', at(crashPoint));
      await service.handleGameEvent({
        type: 'crashed',
        roundId: 'round-1',
        crashPoint,
        crashedAt: at(crashPoint),
      });
    }

    function openRound(service: BettingService, roundId: string) {
      return service.handleGameEvent({ type: 'betting', roundId, endsAt: 0 });
    }

    /** A bet that reached the database without going through the service, e.g. a late commit. */
    async function writeBet(store: InMemoryStore, user: User, autoCashout: number | null = null) {
      const placed = await store.placeBet({
        userId: user.id,
        username: user.username,
        roundId: 'round-1',
        amount: '100',
        autoCashout,
        idempotencyKey: `direct-${user.id}`,
      });
      if (placed.status !== 'placed') {
        throw new Error('Bet setup failed');
      }
      return placed.bet;
    }

    it('marks bets that did not cash out as lost when the next round opens', async () => {
      const { placeBet, service, round, store } = await setup(200);
      const { bet } = await placeBet('100');
      round().start(STARTED_AT);
      await crash(store, service, 200);

      await openRound(service, 'round-2');

      expect(store.bets.get(bet.id)?.status).toBe('LOST');
    });

    it('does not mark bets as lost at the crash itself', async () => {
      const { placeBet, service, round, store } = await setup(200);
      const { bet } = await placeBet('100');
      round().start(STARTED_AT);

      await crash(store, service, 200);

      expect(store.bets.get(bet.id)?.status).toBe('ACTIVE');
    });

    it('pays an untracked bet whose target was below the crash point', async () => {
      const { service, store, user } = await setup(200);
      const bet = await writeBet(store, user, 150);
      await crash(store, service, 200);

      await openRound(service, 'round-2');

      expect(store.bets.get(bet.id)).toMatchObject({
        status: 'CASHED_OUT',
        cashoutMultiplier: 150,
      });
    });

    it('does not touch bets that already cashed out', async () => {
      const { placeBet, service, round, store, user } = await setup(200);
      const { bet } = await placeBet('100');
      round().start(STARTED_AT);
      await service.cashOut(user, at(150));
      await crash(store, service, 200);

      await openRound(service, 'round-2');

      expect(store.bets.get(bet.id)).toMatchObject({
        status: 'CASHED_OUT',
        cashoutMultiplier: 150,
      });
    });

    it('settles bets of every crashed round, not only the last one', async () => {
      const { service, store, user } = await setup(200);
      await crash(store, service, 200);
      await openRound(service, 'round-2');
      const lateBet = await writeBet(store, user);

      await openRound(service, 'round-3');

      expect(store.bets.get(lateBet.id)?.status).toBe('LOST');
    });

    it('settles bets left over from before a restart', async () => {
      const { store, user, game, logger, bettingMetrics } = await setup(200);
      const bet = await writeBet(store, user, 150);
      await store.markCrashed('round-1', at(200));
      const restarted = new BettingService(store, game, logger, bettingMetrics);

      await openRound(restarted, 'round-2');

      expect(store.bets.get(bet.id)).toMatchObject({
        status: 'CASHED_OUT',
        cashoutMultiplier: 150,
      });
    });

    it('refunds bets of a round that was interrupted before it crashed', async () => {
      const { store, user, service, events } = await setup(200);
      const bet = await writeBet(store, user, 150);

      await openRound(service, 'round-2');

      expect(store.bets.get(bet.id)?.status).toBe('VOID');
      expect(store.users.get(user.id)?.balance).toBe('5000');
      expect(store.ledger.filter(entry => entry.type === 'REFUND')).toEqual([
        { userId: user.id, amount: '100', type: 'REFUND' },
      ]);
      expect(events).toContainEqual({
        type: 'refunded',
        bet: expect.objectContaining({ id: bet.id, status: 'VOID' }),
        balance: '5000',
      });
    });

    it('does not settle bets of the round that is opening', async () => {
      const { store, user, service } = await setup(200);
      const bet = await writeBet(store, user);

      await openRound(service, 'round-1');

      expect(store.bets.get(bet.id)?.status).toBe('ACTIVE');
    });

    it('refunds an interrupted bet only once', async () => {
      const { store, user, service } = await setup(200);
      await writeBet(store, user);

      await Promise.all([openRound(service, 'round-2'), openRound(service, 'round-2')]);

      expect(store.ledger.filter(entry => entry.type === 'REFUND')).toHaveLength(1);
      expect(store.users.get(user.id)?.balance).toBe('5000');
    });

    it('keeps settling the other bets when one of them fails, and retries it later', async () => {
      const { store, user, service } = await setup(200);
      const bob = await store.findOrCreate('bob', '5000', 'token-bob');
      const aliceBet = await writeBet(store, user);
      const bobBet = await writeBet(store, bob);
      await crash(store, service, 200);
      jest.spyOn(store, 'markLost').mockRejectedValueOnce(new Error('database down'));

      await openRound(service, 'round-2');

      const statuses = [store.bets.get(aliceBet.id)?.status, store.bets.get(bobBet.id)?.status];
      expect(statuses.sort()).toEqual(['ACTIVE', 'LOST']);

      await openRound(service, 'round-3');

      expect(store.bets.get(aliceBet.id)?.status).toBe('LOST');
      expect(store.bets.get(bobBet.id)?.status).toBe('LOST');
    });

    it('logs each sweep with the number of bets by result', async () => {
      const { store, user, service, logged } = await setup(200);
      const bob = await store.findOrCreate('bob', '5000', 'token-bob');
      const carol = await store.findOrCreate('carol', '5000', 'token-carol');
      await writeBet(store, user, 150);
      await writeBet(store, bob);
      await store.markCrashed('round-1', at(200));
      await store.create({ id: 'round-0', crashPoint: 300, bettingEndsAt: STARTED_AT });
      await store.placeBet({
        userId: carol.id,
        username: carol.username,
        roundId: 'round-0',
        amount: '100',
        autoCashout: null,
        idempotencyKey: 'interrupted',
      });

      await openRound(service, 'round-2');

      expect(logged('settlement')).toEqual([
        expect.objectContaining({
          level: 'info',
          roundId: 'round-2',
          found: 3,
          won: 1,
          lost: 1,
          refunded: 1,
          skipped: 0,
          failed: 0,
          durationMs: expect.any(Number),
        }),
      ]);
    });

    it('logs a sweep that found nothing', async () => {
      const { service, logged } = await setup(200);

      await openRound(service, 'round-2');

      expect(logged('settlement')).toEqual([
        expect.objectContaining({ found: 0, won: 0, lost: 0, refunded: 0, failed: 0 }),
      ]);
    });

    it('counts bets settled meanwhile by someone else as skipped', async () => {
      const { store, user, service, logged } = await setup(200);
      await writeBet(store, user);
      jest.spyOn(store, 'refund').mockResolvedValueOnce(null);

      await openRound(service, 'round-2');

      expect(logged('settlement')[0]).toMatchObject({ found: 1, refunded: 0, skipped: 1 });
    });

    it('counts a win paid meanwhile by someone else as skipped', async () => {
      const { store, user, service, logged } = await setup(200);
      await writeBet(store, user, 150);
      await store.markCrashed('round-1', at(200));
      jest.spyOn(store, 'cashOut').mockResolvedValueOnce(null);

      await openRound(service, 'round-2');

      expect(logged('settlement')[0]).toMatchObject({ found: 1, won: 0, skipped: 1 });
    });

    it('logs failed bets of a sweep at error level', async () => {
      const { store, user, service, logged } = await setup(200);
      await writeBet(store, user);
      await crash(store, service, 200);
      jest.spyOn(store, 'markLost').mockRejectedValueOnce(new Error('database down'));

      await openRound(service, 'round-2');

      expect(logged('settlement')).toEqual([
        expect.objectContaining({
          level: 'error',
          found: 1,
          lost: 0,
          failed: 1,
          err: expect.objectContaining({ message: 'database down' }),
        }),
      ]);
    });

    it('logs a sweep that could not read the unsettled bets', async () => {
      const { store, service, logged } = await setup(200);
      jest.spyOn(store, 'findUnsettledBets').mockRejectedValueOnce(new Error('database down'));

      await openRound(service, 'round-2');

      expect(logged('settlement')).toEqual([
        expect.objectContaining({
          level: 'error',
          err: expect.objectContaining({ message: 'database down' }),
        }),
      ]);
    });

    describe('metrics', () => {
      /** Bets of round-1 (crashed at 2.00x): one wins at 1.50x, one loses; one of round-0 (interrupted) is refunded. */
      async function writeOneOfEachResult(store: InMemoryStore, user: User) {
        const bob = await store.findOrCreate('bob', '5000', 'token-bob');
        const carol = await store.findOrCreate('carol', '5000', 'token-carol');
        await writeBet(store, user, 150);
        await writeBet(store, bob);
        await store.markCrashed('round-1', at(200));
        await store.create({ id: 'round-0', crashPoint: 300, bettingEndsAt: STARTED_AT });
        await store.placeBet({
          userId: carol.id,
          username: carol.username,
          roundId: 'round-0',
          amount: '100',
          autoCashout: null,
          idempotencyKey: 'interrupted',
        });
      }

      it('counts the bets of a sweep by result', async () => {
        const { store, user, service, registry } = await setup(200);
        await writeOneOfEachResult(store, user);

        await openRound(service, 'round-2');

        const name = 'crash_settlement_bets_total';
        expect(await sample(registry, name, { result: 'won' })).toBe(1);
        expect(await sample(registry, name, { result: 'lost' })).toBe(1);
        expect(await sample(registry, name, { result: 'refunded' })).toBe(1);
        expect(await sample(registry, name, { result: 'skipped' })).toBe(0);
        expect(await sample(registry, name, { result: 'failed' })).toBe(0);
      });

      it('counts bets settled meanwhile by someone else as skipped', async () => {
        const { store, user, service, registry } = await setup(200);
        await writeBet(store, user);
        jest.spyOn(store, 'refund').mockResolvedValueOnce(null);

        await openRound(service, 'round-2');

        const name = 'crash_settlement_bets_total';
        expect(await sample(registry, name, { result: 'skipped' })).toBe(1);
        expect(await sample(registry, name, { result: 'refunded' })).toBe(0);
      });

      it('counts failed bets and still counts the sweep as ok', async () => {
        const { store, user, service, registry } = await setup(200);
        const bob = await store.findOrCreate('bob', '5000', 'token-bob');
        await writeBet(store, user);
        await writeBet(store, bob);
        await crash(store, service, 200);
        jest.spyOn(store, 'markLost').mockRejectedValueOnce(new Error('database down'));

        await openRound(service, 'round-2');

        const name = 'crash_settlement_bets_total';
        expect(await sample(registry, name, { result: 'failed' })).toBe(1);
        expect(await sample(registry, name, { result: 'lost' })).toBe(1);
        expect(await sample(registry, 'crash_settlement_sweeps_total', { outcome: 'ok' })).toBe(1);
      });

      it('adds up the bets of consecutive sweeps', async () => {
        const { store, user, service, registry } = await setup(200);
        await crash(store, service, 200);
        await openRound(service, 'round-2');
        await writeBet(store, user);

        await openRound(service, 'round-3');

        expect(await sample(registry, 'crash_settlement_bets_total', { result: 'lost' })).toBe(1);
        expect(await sample(registry, 'crash_settlement_sweeps_total', { outcome: 'ok' })).toBe(2);
      });

      it('counts a sweep that could not read the unsettled bets as failed', async () => {
        const { store, service, registry } = await setup(200);
        jest.spyOn(store, 'findUnsettledBets').mockRejectedValueOnce(new Error('database down'));

        await openRound(service, 'round-2');

        const name = 'crash_settlement_sweeps_total';
        expect(await sample(registry, name, { outcome: 'failed' })).toBe(1);
        expect(await sample(registry, name, { outcome: 'ok' })).toBeUndefined();
      });

      it('reports no unsettled bets when the sweep settled everything it found', async () => {
        const { store, user, service, registry } = await setup(200);
        await writeOneOfEachResult(store, user);

        await openRound(service, 'round-2');

        expect(await sample(registry, 'crash_unsettled_bets')).toBe(0);
      });

      it('reports the bets the last sweep could not settle as unsettled', async () => {
        const { store, user, service, registry } = await setup(200);
        await writeOneOfEachResult(store, user);
        jest.spyOn(store, 'markLost').mockRejectedValueOnce(new Error('database down'));

        await openRound(service, 'round-2');

        expect(await sample(registry, 'crash_unsettled_bets')).toBe(1);
      });

      it('reports no unsettled bets once a later sweep settles them', async () => {
        const { store, user, service, registry } = await setup(200);
        await writeBet(store, user);
        jest.spyOn(store, 'markLost').mockRejectedValueOnce(new Error('database down'));
        await crash(store, service, 200);
        await openRound(service, 'round-2');

        await openRound(service, 'round-3');

        expect(await sample(registry, 'crash_unsettled_bets')).toBe(0);
      });

      it('keeps the last count of unsettled bets when a sweep cannot read them', async () => {
        const { store, user, service, registry } = await setup(200);
        await writeBet(store, user);
        jest.spyOn(store, 'markLost').mockRejectedValueOnce(new Error('database down'));
        await crash(store, service, 200);
        await openRound(service, 'round-2');
        jest.spyOn(store, 'findUnsettledBets').mockRejectedValueOnce(new Error('database down'));

        await openRound(service, 'round-3');

        expect(await sample(registry, 'crash_unsettled_bets')).toBe(1);
      });
    });
  });
});
