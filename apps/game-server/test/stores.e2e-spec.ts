import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { TypeOrmBetsStore } from '../src/betting/typeorm-bets.store';
import { appDatabaseOptions, databaseOptions } from '../src/database/database-options';
import { TypeOrmRoundsStore } from '../src/game/typeorm-rounds.store';
import { TypeOrmUsersStore } from '../src/users/typeorm-users.store';
import { User } from '../src/users/user';

// Runs against the real PostgreSQL from docker-compose (database crash_test):
// exactly-once guarantees come from SQL, so they cannot be checked with fakes.
describe('PostgreSQL stores', () => {
  let dataSource: DataSource;
  let users: TypeOrmUsersStore;
  let bets: TypeOrmBetsStore;
  let rounds: TypeOrmRoundsStore;

  beforeAll(async () => {
    dataSource = new DataSource({ ...databaseOptions(), dropSchema: true, migrationsRun: true });
    await dataSource.initialize();
    users = new TypeOrmUsersStore(dataSource);
    bets = new TypeOrmBetsStore(dataSource);
    rounds = new TypeOrmRoundsStore(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE ledger_entries, bets, rounds, users');
  });

  function createUser(username = 'alice', balance = '5000'): Promise<User> {
    return users.findOrCreate(username, balance, randomUUID().replaceAll('-', '').padEnd(64, '0'));
  }

  /** A round whose betting is still open for a minute. */
  async function openRound(bettingEndsAt = Date.now() + 60_000): Promise<string> {
    const id = randomUUID();
    await rounds.create({ id, crashPoint: 250, bettingEndsAt });

    return id;
  }

  function placeBet(user: User, roundId: string, idempotencyKey = 'bet-1', amount = '100') {
    return bets.placeBet({
      userId: user.id,
      username: user.username,
      roundId,
      amount,
      autoCashout: null,
      idempotencyKey,
    });
  }

  async function ledgerOf(userId: string): Promise<{ type: string; amount: string }[]> {
    return dataSource.query(
      'SELECT type, amount::text AS amount FROM ledger_entries WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
  }

  async function balanceOf(userId: string): Promise<string> {
    const [row] = await dataSource.query<{ balance: string }[]>(
      'SELECT balance::text AS balance FROM users WHERE id = $1',
      [userId],
    );

    return Number(row?.balance).toString();
  }

  describe('users', () => {
    it('creates one user and one starting balance entry for concurrent first logins', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => createUser('alice')));

      expect(new Set(results.map(user => user.id)).size).toBe(1);
      expect(await ledgerOf(results[0]!.id)).toHaveLength(1);
    });

    it('finds a user by token', async () => {
      const user = await createUser();

      await expect(users.findByToken(user.token)).resolves.toEqual(user);
    });
  });

  describe('placeBet', () => {
    it('debits the balance and writes a BET entry', async () => {
      const user = await createUser();

      const result = await placeBet(user, await openRound());

      expect(result).toMatchObject({ status: 'placed', balance: '4900' });
      expect(await ledgerOf(user.id)).toEqual([
        { type: 'INITIAL', amount: '5000.000000000000000000' },
        { type: 'BET', amount: '-100.000000000000000000' },
      ]);
    });

    it('debits once for concurrent requests with the same idempotency key', async () => {
      const user = await createUser();
      const roundId = await openRound();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => placeBet(user, roundId, 'same-key')),
      );

      expect(results.filter(result => result.status === 'placed')).toHaveLength(1);
      expect(results.filter(result => result.status === 'duplicate')).toHaveLength(9);
      expect(await balanceOf(user.id)).toBe('4900');
    });

    it('accepts one bet per round for concurrent requests with different keys', async () => {
      const user = await createUser();
      const roundId = await openRound();

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => placeBet(user, roundId, `key-${index}`)),
      );

      expect(results.filter(result => result.status === 'placed')).toHaveLength(1);
      expect(results.filter(result => result.status === 'already_bet')).toHaveLength(9);
      expect(await balanceOf(user.id)).toBe('4900');
    });

    it('does not create a bet that commits after betting ended', async () => {
      const user = await createUser();
      const closedRound = await openRound(Date.now() - 1);

      await expect(placeBet(user, closedRound)).resolves.toEqual({ status: 'betting_closed' });
      expect(await balanceOf(user.id)).toBe('5000');
      expect(await ledgerOf(user.id)).toHaveLength(1);
      await expect(bets.findUserBet(user.id, closedRound)).resolves.toBeNull();
    });

    it('does not create a bet for an unknown round', async () => {
      const user = await createUser();

      await expect(placeBet(user, randomUUID())).resolves.toEqual({ status: 'betting_closed' });
      expect(await balanceOf(user.id)).toBe('5000');
    });

    it('returns the original bet to a concurrent retry even when the balance covers only one bet', async () => {
      const user = await createUser('alice', '150');
      const roundId = await openRound();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => placeBet(user, roundId, 'same-key')),
      );

      expect(results.filter(result => result.status === 'placed')).toHaveLength(1);
      expect(results.filter(result => result.status === 'duplicate')).toHaveLength(9);
      expect(await balanceOf(user.id)).toBe('50');
    });

    it('rejects a bet larger than the balance without debiting', async () => {
      const user = await createUser('alice', '99.99');

      await expect(placeBet(user, await openRound())).resolves.toEqual({
        status: 'insufficient_funds',
      });
      expect(await balanceOf(user.id)).toBe('99.99');
    });
  });

  describe('cashOut', () => {
    async function activeBet() {
      const user = await createUser();
      const placed = await placeBet(user, await openRound());
      if (placed.status !== 'placed') {
        throw new Error('Bet setup failed');
      }

      return { user, bet: placed.bet };
    }

    it('pays exactly once for concurrent cashouts', async () => {
      const { user, bet } = await activeBet();

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          bets.cashOut({ betId: bet.id, multiplier: 150, payout: '150' }),
        ),
      );

      expect(results.filter(result => result !== null)).toHaveLength(1);
      expect(await balanceOf(user.id)).toBe('5050');
      expect((await ledgerOf(user.id)).filter(entry => entry.type === 'WIN')).toHaveLength(1);
    });

    it('records the multiplier and payout on the bet', async () => {
      const { bet } = await activeBet();

      const result = await bets.cashOut({ betId: bet.id, multiplier: 150, payout: '150' });

      expect(result?.bet).toMatchObject({
        status: 'CASHED_OUT',
        cashoutMultiplier: 150,
        payout: '150',
      });
      expect(result?.balance).toBe('5050');
    });

    it('cannot pay a lost bet', async () => {
      const { user, bet } = await activeBet();
      await bets.markLost(bet.id);

      await expect(
        bets.cashOut({ betId: bet.id, multiplier: 150, payout: '150' }),
      ).resolves.toBeNull();
      expect(await balanceOf(user.id)).toBe('4900');
    });

    it('does not mark a cashed-out bet as lost', async () => {
      const { user, bet } = await activeBet();
      await bets.cashOut({ betId: bet.id, multiplier: 150, payout: '150' });

      await bets.markLost(bet.id);

      await expect(bets.findUserBet(user.id, bet.roundId)).resolves.toMatchObject({
        status: 'CASHED_OUT',
      });
    });
  });

  describe('settlement queries', () => {
    async function betInRound(username: string, crashed: boolean) {
      const roundId = await openRound();
      if (crashed) {
        await rounds.markCrashed(roundId, Date.now());
      }
      const placed = await placeBet(await createUser(username), roundId);
      if (placed.status !== 'placed') {
        throw new Error('Bet setup failed');
      }
      return placed.bet;
    }

    it('returns active bets of finished rounds with their crash point and crash state', async () => {
      const crashedBet = await betInRound('alice', true);
      const interruptedBet = await betInRound('bob', false);

      const unsettled = await bets.findUnsettledBets(randomUUID());

      expect(unsettled).toHaveLength(2);
      expect(unsettled).toEqual(
        expect.arrayContaining([
          { bet: crashedBet, crashPoint: 250, roundCrashed: true },
          { bet: interruptedBet, crashPoint: 250, roundCrashed: false },
        ]),
      );
    });

    it('skips the current round', async () => {
      const bet = await betInRound('alice', false);

      await expect(bets.findUnsettledBets(bet.roundId)).resolves.toEqual([]);
    });

    it('skips settled bets', async () => {
      const bet = await betInRound('alice', true);
      await bets.markLost(bet.id);

      await expect(bets.findUnsettledBets(randomUUID())).resolves.toEqual([]);
    });

    it('lists the active bets of one round', async () => {
      const bet = await betInRound('alice', false);
      await betInRound('bob', false);

      await expect(bets.findActiveBets(bet.roundId)).resolves.toEqual([bet]);
    });
  });

  describe('cashOutUserBet', () => {
    const price = () => ({ multiplier: 150, payout: '150' });

    async function activeBetOf(username = 'alice') {
      const user = await createUser(username);
      const placed = await placeBet(user, await openRound());
      if (placed.status !== 'placed') {
        throw new Error('Bet setup failed');
      }
      return { user, bet: placed.bet };
    }

    it('finds and pays the bet in one transaction, exactly once for concurrent requests', async () => {
      const { user, bet } = await activeBetOf();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => bets.cashOutUserBet(user.id, bet.roundId, price)),
      );

      expect(results.filter(result => result.status === 'paid')).toHaveLength(1);
      expect(results.filter(result => result.status === 'already_paid')).toHaveLength(9);
      expect(await balanceOf(user.id)).toBe('5050');
      expect((await ledgerOf(user.id)).filter(entry => entry.type === 'WIN')).toHaveLength(1);
    });

    it('does not pay when the price is refused', async () => {
      const { user, bet } = await activeBetOf();

      await expect(bets.cashOutUserBet(user.id, bet.roundId, () => null)).resolves.toEqual({
        status: 'not_paid',
        bet,
      });
      expect(await balanceOf(user.id)).toBe('4900');
    });

    it('does not pay a lost bet', async () => {
      const { user, bet } = await activeBetOf();
      await bets.markLost(bet.id);

      await expect(bets.cashOutUserBet(user.id, bet.roundId, price)).resolves.toMatchObject({
        status: 'not_paid',
        bet: { status: 'LOST' },
      });
    });

    it('reports a missing bet', async () => {
      const user = await createUser();

      await expect(bets.cashOutUserBet(user.id, randomUUID(), price)).resolves.toEqual({
        status: 'not_paid',
        bet: null,
      });
    });
  });

  describe('refund', () => {
    it('voids the bet and returns its amount exactly once for concurrent refunds', async () => {
      const user = await createUser();
      const placed = await placeBet(user, await openRound());
      if (placed.status !== 'placed') {
        throw new Error('Bet setup failed');
      }

      const results = await Promise.all(
        Array.from({ length: 10 }, () => bets.refund(placed.bet.id)),
      );

      expect(results.filter(result => result !== null)).toHaveLength(1);
      expect(await balanceOf(user.id)).toBe('5000');
      expect((await ledgerOf(user.id)).filter(entry => entry.type === 'REFUND')).toHaveLength(1);
      await expect(bets.findUserBet(user.id, placed.bet.roundId)).resolves.toMatchObject({
        status: 'VOID',
      });
    });

    it('does not refund a bet that was already paid', async () => {
      const user = await createUser();
      const placed = await placeBet(user, await openRound());
      if (placed.status !== 'placed') {
        throw new Error('Bet setup failed');
      }
      await bets.cashOut({ betId: placed.bet.id, multiplier: 150, payout: '150' });

      await expect(bets.refund(placed.bet.id)).resolves.toBeNull();
      expect(await balanceOf(user.id)).toBe('5050');
    });
  });

  describe('lookups', () => {
    it('finds a bet by its request id with the current balance', async () => {
      const user = await createUser();
      const placed = await placeBet(user, await openRound(), 'request-1');
      if (placed.status !== 'placed') {
        throw new Error('Bet setup failed');
      }

      await expect(bets.findBetByRequest(user.id, 'request-1')).resolves.toEqual({
        bet: placed.bet,
        balance: '4900',
      });
      await expect(bets.findBetByRequest(user.id, 'unknown')).resolves.toBeNull();
    });

    it('reads the balance', async () => {
      const user = await createUser('alice', '123.45');

      await expect(bets.getBalance(user.id)).resolves.toBe('123.45');
    });

    it('finds the round with the latest betting end', async () => {
      const older = await openRound(Date.now() + 1_000);
      const latest = await openRound(Date.now() + 5_000);

      const found = await rounds.findLatest();

      expect(found?.id).toBe(latest);
      expect(found?.id).not.toBe(older);
      expect(found?.crashPoint).toBe(250);
    });
  });

  it('aborts a transaction that runs longer than the app timeout', async () => {
    const appDataSource = new DataSource({ ...appDatabaseOptions(), migrationsRun: false });
    await appDataSource.initialize();
    try {
      await expect(
        appDataSource.transaction(manager => manager.query('SELECT pg_sleep(4)')),
      ).rejects.toThrow(/transaction timeout/);
    } finally {
      await appDataSource.destroy();
    }
  });
});
