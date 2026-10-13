import { Logger } from '@nestjs/common';

import { crashTimeMs } from '../game/multiplier';
import { Round } from '../game/round';
import { InMemoryStore } from '../testing/in-memory-store';
import { User } from '../users/user';
import { BettingError } from './betting.errors';
import { BettingEvent, BettingService, GameSource } from './betting.service';

const STARTED_AT = 1_000_000;

/** Server time at which the multiplier first reaches `multiplier` (in hundredths). */
function at(multiplier: number): number {
  return STARTED_AT + crashTimeMs(multiplier);
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
  const service = new BettingService(store, game);
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

  return { store, game, service, events, user, round, placeBet, setDatabaseTime };
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

      await expect(placeBet('100', undefined, 'bet-1')).resolves.toEqual(first);
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

      expect(repeated).toEqual(first);
      expect(store.ledger.filter(entry => entry.type === 'WIN')).toHaveLength(1);
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
  });

  describe('after a restart', () => {
    it('pays auto-cashouts of a continued round from the bets in the store', async () => {
      const { store, user, game } = await setup(500);
      const placed = await store.placeBet({
        userId: user.id,
        username: user.username,
        roundId: 'round-1',
        amount: '100',
        autoCashout: 150,
        idempotencyKey: 'before-restart',
      });
      const restarted = new BettingService(store, game);

      await restarted.handleGameEvent({
        type: 'started',
        roundId: 'round-1',
        startedAt: STARTED_AT,
      });
      await restarted.handleGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 151 });

      expect(placed.status).toBe('placed');
      expect(store.ledger.filter(entry => entry.type === 'WIN')).toHaveLength(1);
    });
  });

  describe('shutdown', () => {
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
      const { store, user, game } = await setup(200);
      const bet = await writeBet(store, user, 150);
      await store.markCrashed('round-1', at(200));
      const restarted = new BettingService(store, game);

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
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { store, user, service } = await setup(200);
      const bob = await store.findOrCreate('bob', '5000', 'token-bob');
      const aliceBet = await writeBet(store, user);
      const bobBet = await writeBet(store, bob);
      await crash(store, service, 200);
      jest.spyOn(store, 'markLost').mockRejectedValueOnce(new Error('database down'));

      await openRound(service, 'round-2');

      const statuses = [store.bets.get(aliceBet.id)?.status, store.bets.get(bobBet.id)?.status];
      expect(statuses.sort()).toEqual(['ACTIVE', 'LOST']);
      expect(errorSpy).toHaveBeenCalled();

      await openRound(service, 'round-3');

      expect(store.bets.get(aliceBet.id)?.status).toBe('LOST');
      expect(store.bets.get(bobBet.id)?.status).toBe('LOST');
      errorSpy.mockRestore();
    });
  });
});
