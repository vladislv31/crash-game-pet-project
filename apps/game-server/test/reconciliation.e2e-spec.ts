import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { TypeOrmBetsStore } from '../src/betting/typeorm-bets.store';
import { databaseOptions } from '../src/database/database-options';
import { TypeOrmRoundsStore } from '../src/game/typeorm-rounds.store';
import { TypeOrmReconciliationStore } from '../src/reconciliation/typeorm-reconciliation.store';
import { TypeOrmUsersStore } from '../src/users/typeorm-users.store';
import { User } from '../src/users/user';

const MAX_WIN = '100000';

// The invariants are SQL over real rows, so they are checked against the real PostgreSQL.
describe('Reconciliation (PostgreSQL)', () => {
  let dataSource: DataSource;
  let users: TypeOrmUsersStore;
  let bets: TypeOrmBetsStore;
  let rounds: TypeOrmRoundsStore;
  let reconciliation: TypeOrmReconciliationStore;

  beforeAll(async () => {
    dataSource = new DataSource({ ...databaseOptions(), dropSchema: true, migrationsRun: true });
    await dataSource.initialize();
    users = new TypeOrmUsersStore(dataSource);
    bets = new TypeOrmBetsStore(dataSource);
    rounds = new TypeOrmRoundsStore(dataSource);
    reconciliation = new TypeOrmReconciliationStore(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE ledger_entries, bets, rounds, users');
  });

  function createUser(username = 'alice'): Promise<User> {
    return users.findOrCreate(username, '5000', randomUUID().replaceAll('-', '').padEnd(64, '0'));
  }

  async function openRound(crashPoint = 250): Promise<string> {
    const id = randomUUID();
    await rounds.create({ id, crashPoint, bettingEndsAt: Date.now() + 60_000 });
    return id;
  }

  async function placeBet(user: User, roundId: string, amount = '100'): Promise<string> {
    const placed = await bets.placeBet({
      userId: user.id,
      username: user.username,
      roundId,
      amount,
      autoCashout: null,
      idempotencyKey: randomUUID(),
    });
    if (placed.status !== 'placed') {
      throw new Error(`Bet setup failed: ${placed.status}`);
    }
    return placed.bet.id;
  }

  function check() {
    return reconciliation.check(MAX_WIN);
  }

  async function mismatchTypes(): Promise<string[]> {
    const { mismatches } = await check();
    return mismatches.map(mismatch => mismatch.type).sort();
  }

  describe('consistent money', () => {
    it('finds nothing wrong after bets that won, lost, were refunded or are still open', async () => {
      const alice = await createUser('alice');
      const bob = await createUser('bob');
      const crashed = await openRound(250);
      const won = await placeBet(alice, crashed);
      const lost = await placeBet(bob, crashed, '150.5');
      await bets.cashOut({ betId: won, multiplier: 198, payout: '198' });
      await bets.markLost(lost);
      const interrupted = await openRound();
      await bets.refund(await placeBet(alice, interrupted));
      await placeBet(bob, await openRound());

      const report = await check();

      expect(report).toEqual({ usersChecked: 2, betsChecked: 4, mismatches: [] });
    });

    it('accepts a payout with cents', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound(), '100.5');
      await bets.cashOut({ betId, multiplier: 198, payout: '198.99' });

      await expect(mismatchTypes()).resolves.toEqual([]);
    });

    it('finds nothing in an empty database', async () => {
      await expect(check()).resolves.toEqual({ usersChecked: 0, betsChecked: 0, mismatches: [] });
    });
  });

  describe('balance', () => {
    it('reports a balance that differs from the ledger, with the difference only', async () => {
      const alice = await createUser();
      await dataSource.query('UPDATE users SET balance = balance + 50 WHERE id = $1', [alice.id]);

      const { mismatches } = await check();

      expect(mismatches).toEqual([
        { type: 'balance', userId: alice.id, betId: null, expected: '0', actual: '50' },
      ]);
    });
  });

  describe('bet entries', () => {
    it('reports a bet without its BET entry', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound());
      await dataSource.query("DELETE FROM ledger_entries WHERE bet_id = $1 AND type = 'BET'", [
        betId,
      ]);

      const { mismatches } = await check();

      expect(mismatches).toContainEqual({
        type: 'bet_entry',
        userId: alice.id,
        betId,
        expected: 'count=1 total=-100',
        actual: 'count=0 total=0',
      });
    });

    it('reports a BET entry for the wrong amount', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound());
      await dataSource.query(
        "UPDATE ledger_entries SET amount = -50 WHERE bet_id = $1 AND type = 'BET'",
        [betId],
      );
      await dataSource.query('UPDATE users SET balance = balance + 50 WHERE id = $1', [alice.id]);

      const { mismatches } = await check();

      expect(mismatches).toEqual([
        {
          type: 'bet_entry',
          userId: alice.id,
          betId,
          expected: 'count=1 total=-100',
          actual: 'count=1 total=-50',
        },
      ]);
    });

    it('reports a bet debited twice', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound());
      await insertEntry(alice.id, betId, 'BET', '-100');

      await expect(mismatchTypes()).resolves.toEqual(['balance', 'bet_entry']);
    });
  });

  describe('win entries', () => {
    it('reports a cashout paid twice', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound());
      await bets.cashOut({ betId, multiplier: 150, payout: '150' });
      await insertEntry(alice.id, betId, 'WIN', '150');
      await dataSource.query('UPDATE users SET balance = balance + 150 WHERE id = $1', [alice.id]);

      const { mismatches } = await check();

      expect(mismatches).toEqual([
        {
          type: 'win_entry',
          userId: alice.id,
          betId,
          expected: 'count=1 total=150',
          actual: 'count=2 total=300',
        },
      ]);
    });

    it('reports a win paid to a lost bet', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound());
      await bets.markLost(betId);
      await insertEntry(alice.id, betId, 'WIN', '150');

      await expect(mismatchTypes()).resolves.toEqual(['balance', 'win_entry']);
    });

    it('reports a cashed-out bet without its WIN entry', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound());
      await bets.cashOut({ betId, multiplier: 150, payout: '150' });
      await dataSource.query("DELETE FROM ledger_entries WHERE bet_id = $1 AND type = 'WIN'", [
        betId,
      ]);

      await expect(mismatchTypes()).resolves.toEqual(['balance', 'win_entry']);
    });
  });

  describe('refund entries', () => {
    it('reports a voided bet that was not refunded', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound());
      await bets.refund(betId);
      await dataSource.query("DELETE FROM ledger_entries WHERE bet_id = $1 AND type = 'REFUND'", [
        betId,
      ]);

      const { mismatches } = await check();

      expect(mismatches).toContainEqual({
        type: 'refund_entry',
        userId: alice.id,
        betId,
        expected: 'count=1 total=100',
        actual: 'count=0 total=0',
      });
    });

    it('reports a refund of a bet that was not voided', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound());
      await insertEntry(alice.id, betId, 'REFUND', '100');

      await expect(mismatchTypes()).resolves.toEqual(['balance', 'refund_entry']);
    });
  });

  describe('payouts', () => {
    it('reports a payout that does not match amount × multiplier', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound());
      await bets.cashOut({ betId, multiplier: 150, payout: '151' });

      const { mismatches } = await check();

      expect(mismatches).toEqual([
        { type: 'payout', userId: alice.id, betId, expected: '150', actual: '151' },
      ]);
    });

    it('reports a payout above the max win', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound(1_000_000), '1000');
      await bets.cashOut({ betId, multiplier: 10_001, payout: '100010' });

      const { mismatches } = await check();

      expect(mismatches).toEqual([
        {
          type: 'payout_above_max_win',
          userId: alice.id,
          betId,
          expected: '100000',
          actual: '100010',
        },
      ]);
    });

    it('accepts a payout of exactly the max win', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound(1_000_000), '1000');
      await bets.cashOut({ betId, multiplier: 10_000, payout: '100000' });

      await expect(mismatchTypes()).resolves.toEqual([]);
    });

    it('reports a cashout at the crash point', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound(250));
      await bets.cashOut({ betId, multiplier: 250, payout: '250' });

      const { mismatches } = await check();

      expect(mismatches).toEqual([
        {
          type: 'cashout_at_or_above_crash',
          userId: alice.id,
          betId,
          expected: 'below 250',
          actual: '250',
        },
      ]);
    });

    it('accepts a cashout just below the crash point', async () => {
      const alice = await createUser();
      const betId = await placeBet(alice, await openRound(250));
      await bets.cashOut({ betId, multiplier: 249, payout: '249' });

      await expect(mismatchTypes()).resolves.toEqual([]);
    });
  });

  describe('orphan entries', () => {
    it('reports an entry pointing at a bet that does not exist', async () => {
      const alice = await createUser();
      const missingBet = randomUUID();
      await insertEntry(alice.id, missingBet, 'WIN', '0');

      const { mismatches } = await check();

      expect(mismatches).toEqual([
        {
          type: 'orphan_entry',
          userId: alice.id,
          betId: missingBet,
          expected: null,
          actual: 'WIN',
        },
      ]);
    });

    it("reports an entry pointing at another user's bet", async () => {
      const alice = await createUser('alice');
      const bob = await createUser('bob');
      const betId = await placeBet(alice, await openRound());
      await insertEntry(bob.id, betId, 'REFUND', '0');

      const { mismatches } = await check();

      expect(mismatches).toEqual([
        { type: 'orphan_entry', userId: bob.id, betId, expected: null, actual: 'REFUND' },
      ]);
    });

    it('reports a bet-related entry without a bet id', async () => {
      const alice = await createUser();
      await insertEntry(alice.id, null, 'WIN', '0');

      await expect(mismatchTypes()).resolves.toEqual(['orphan_entry']);
    });
  });

  async function insertEntry(
    userId: string,
    betId: string | null,
    type: string,
    amount: string,
  ): Promise<void> {
    await dataSource.query(
      'INSERT INTO ledger_entries (user_id, bet_id, type, amount) VALUES ($1, $2, $3, $4)',
      [userId, betId, type, amount],
    );
  }
});
