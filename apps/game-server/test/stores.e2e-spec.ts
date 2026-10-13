import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { TypeOrmBetsStore } from '../src/betting/typeorm-bets.store';
import { databaseOptions } from '../src/database/database-options';
import { TypeOrmUsersStore } from '../src/users/typeorm-users.store';
import { User } from '../src/users/user';

// Runs against the real PostgreSQL from docker-compose (database crash_test):
// exactly-once guarantees come from SQL, so they cannot be checked with fakes.
describe('PostgreSQL stores', () => {
  let dataSource: DataSource;
  let users: TypeOrmUsersStore;
  let bets: TypeOrmBetsStore;

  beforeAll(async () => {
    dataSource = new DataSource({ ...databaseOptions(), dropSchema: true, migrationsRun: true });
    await dataSource.initialize();
    users = new TypeOrmUsersStore(dataSource);
    bets = new TypeOrmBetsStore(dataSource);
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

      const result = await placeBet(user, randomUUID());

      expect(result).toMatchObject({ status: 'placed', balance: '4900' });
      expect(await ledgerOf(user.id)).toEqual([
        { type: 'INITIAL', amount: '5000.000000000000000000' },
        { type: 'BET', amount: '-100.000000000000000000' },
      ]);
    });

    it('debits once for concurrent requests with the same idempotency key', async () => {
      const user = await createUser();
      const roundId = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => placeBet(user, roundId, 'same-key')),
      );

      expect(results.filter(result => result.status === 'placed')).toHaveLength(1);
      expect(results.filter(result => result.status === 'duplicate')).toHaveLength(9);
      expect(await balanceOf(user.id)).toBe('4900');
    });

    it('accepts one bet per round for concurrent requests with different keys', async () => {
      const user = await createUser();
      const roundId = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => placeBet(user, roundId, `key-${index}`)),
      );

      expect(results.filter(result => result.status === 'placed')).toHaveLength(1);
      expect(results.filter(result => result.status === 'already_bet')).toHaveLength(9);
      expect(await balanceOf(user.id)).toBe('4900');
    });

    it('rejects a bet larger than the balance without debiting', async () => {
      const user = await createUser('alice', '99.99');

      await expect(placeBet(user, randomUUID())).resolves.toEqual({ status: 'insufficient_funds' });
      expect(await balanceOf(user.id)).toBe('99.99');
    });
  });

  describe('cashOut', () => {
    async function activeBet() {
      const user = await createUser();
      const placed = await placeBet(user, randomUUID());
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

  it('lists only active bets of a round', async () => {
    const roundId = randomUUID();
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    await placeBet(alice, roundId);
    const bobBet = await placeBet(bob, roundId);
    if (bobBet.status !== 'placed') {
      throw new Error('Bet setup failed');
    }
    await bets.markLost(bobBet.bet.id);

    const active = await bets.findActiveBets(roundId);

    expect(active.map(bet => bet.username)).toEqual(['alice']);
  });
});
