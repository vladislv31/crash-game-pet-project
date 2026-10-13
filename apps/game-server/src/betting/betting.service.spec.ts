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
  const store = new InMemoryStore();
  const game: { currentRound: Round | null; subscribe: GameSource['subscribe'] } = {
    currentRound: new Round('round-1', crashPoint),
    subscribe: () => undefined,
  };
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

  return { store, game, service, events, user, round, placeBet };
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
      const { placeBet, service, round, user, store } = await setup(500);
      await placeBet('100');
      round().start(STARTED_AT);

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => service.cashOut(user, at(150))),
      );

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(
        results.filter(
          result =>
            result.status === 'rejected' &&
            (result.reason as BettingError).code === 'already_settled',
        ),
      ).toHaveLength(4);
      expect(store.ledger.filter(entry => entry.type === 'WIN')).toHaveLength(1);
      expect(store.users.get(user.id)?.balance).toBe('5050');
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

  describe('settling a crashed round', () => {
    async function crashAndOpenNextRound(service: BettingService, crashPoint: number) {
      await service.handleGameEvent({
        type: 'crashed',
        roundId: 'round-1',
        crashPoint,
        crashedAt: at(crashPoint),
      });
      await service.handleGameEvent({ type: 'betting', roundId: 'round-2', endsAt: 0 });
    }

    it('marks bets that did not cash out as lost when the next round opens', async () => {
      const { placeBet, service, round, store } = await setup(200);
      const { bet } = await placeBet('100');
      round().start(STARTED_AT);

      await crashAndOpenNextRound(service, 200);

      expect(store.bets.get(bet.id)?.status).toBe('LOST');
    });

    it('does not mark bets as lost at the crash itself', async () => {
      const { placeBet, service, round, store } = await setup(200);
      const { bet } = await placeBet('100');
      round().start(STARTED_AT);

      await service.handleGameEvent({
        type: 'crashed',
        roundId: 'round-1',
        crashPoint: 200,
        crashedAt: at(200),
      });

      expect(store.bets.get(bet.id)?.status).toBe('ACTIVE');
    });

    it('pays an untracked bet whose target was below the crash point', async () => {
      const { service, store, user } = await setup(200);
      const placed = await store.placeBet({
        userId: user.id,
        username: user.username,
        roundId: 'round-1',
        amount: '100',
        autoCashout: 150,
        idempotencyKey: 'written-by-another-path',
      });
      if (placed.status !== 'placed') {
        throw new Error('Bet setup failed');
      }

      await crashAndOpenNextRound(service, 200);

      expect(store.bets.get(placed.bet.id)).toMatchObject({
        status: 'CASHED_OUT',
        cashoutMultiplier: 150,
      });
    });

    it('does not touch bets that already cashed out', async () => {
      const { placeBet, service, round, store, user } = await setup(200);
      const { bet } = await placeBet('100');
      round().start(STARTED_AT);
      await service.cashOut(user, at(150));

      await crashAndOpenNextRound(service, 200);

      expect(store.bets.get(bet.id)).toMatchObject({
        status: 'CASHED_OUT',
        cashoutMultiplier: 150,
      });
    });
  });
});
