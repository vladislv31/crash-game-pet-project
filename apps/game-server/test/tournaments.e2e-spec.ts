import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';

import { TypeOrmBetsStore } from '../src/betting/typeorm-bets.store';
import { databaseOptions } from '../src/database/database-options';
import { TypeOrmRoundsStore } from '../src/game/typeorm-rounds.store';
import { redisOptions } from '../src/tournaments/redis';
import { RedisLeaderboardCache } from '../src/tournaments/redis-leaderboard-cache';
import { TournamentScore } from '../src/tournaments/tournament';
import { TypeOrmTournamentsStore } from '../src/tournaments/typeorm-tournaments.store';
import { TypeOrmUsersStore } from '../src/users/typeorm-users.store';
import { User } from '../src/users/user';

// The one-active-tournament rule and the standings order live in SQL and in Redis, so they are
// checked against the real PostgreSQL (database crash_test) and Redis (db 1) from docker-compose.
describe('Tournaments store (PostgreSQL)', () => {
  let dataSource: DataSource;
  let users: TypeOrmUsersStore;
  let bets: TypeOrmBetsStore;
  let rounds: TypeOrmRoundsStore;
  let tournaments: TypeOrmTournamentsStore;

  beforeAll(async () => {
    dataSource = new DataSource({ ...databaseOptions(), dropSchema: true, migrationsRun: true });
    await dataSource.initialize();
    users = new TypeOrmUsersStore(dataSource);
    bets = new TypeOrmBetsStore(dataSource);
    rounds = new TypeOrmRoundsStore(dataSource);
    tournaments = new TypeOrmTournamentsStore(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE tournament_entries, tournaments, ledger_entries, bets, rounds, users',
    );
  });

  function createUser(username: string): Promise<User> {
    return users.findOrCreate(username, '5000', randomUUID().replaceAll('-', '').padEnd(64, '0'));
  }

  /** Inserts the entry directly: awarding points on cashout is covered with the bets store. */
  async function addEntry(
    tournamentId: string,
    user: User,
    points: number,
    createdAt: string,
  ): Promise<void> {
    const roundId = randomUUID();
    await rounds.create({ id: roundId, crashPoint: 250, bettingEndsAt: Date.now() + 60_000 });
    const placed = await bets.placeBet({
      userId: user.id,
      username: user.username,
      roundId,
      amount: '100',
      autoCashout: null,
      idempotencyKey: randomUUID(),
    });
    if (placed.status !== 'placed') {
      throw new Error(`Bet setup failed: ${placed.status}`);
    }
    await dataSource.query(
      `INSERT INTO tournament_entries (tournament_id, bet_id, user_id, points, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tournamentId, placed.bet.id, user.id, points, createdAt],
    );
  }

  describe('start and stop', () => {
    it('has no tournament before the first start', async () => {
      await expect(tournaments.findLatest()).resolves.toBeNull();
    });

    it('starts a running tournament', async () => {
      const started = await tournaments.start();

      expect(started.endedAt).toBeNull();
      await expect(tournaments.findLatest()).resolves.toEqual(started);
    });

    it('returns the running tournament when started again', async () => {
      const first = await tournaments.start();

      await expect(tournaments.start()).resolves.toEqual(first);
    });

    it('starts exactly one tournament for concurrent starts', async () => {
      const started = await Promise.all(Array.from({ length: 10 }, () => tournaments.start()));

      expect(new Set(started.map(tournament => tournament.id)).size).toBe(1);
    });

    it('lets the database reject a second running tournament', async () => {
      await tournaments.start();

      await expect(dataSource.query('INSERT INTO tournaments DEFAULT VALUES')).rejects.toThrow(
        /ux_tournaments_active/,
      );
    });

    it('ends the running tournament', async () => {
      const started = await tournaments.start();

      const stopped = await tournaments.stop();

      expect(stopped).toMatchObject({ id: started.id, endedAt: expect.any(Date) });
      await expect(tournaments.findLatest()).resolves.toEqual(stopped);
    });

    it('returns null when stopping with none running', async () => {
      await expect(tournaments.stop()).resolves.toBeNull();
    });

    it('starts a new tournament after a stop and keeps the old one', async () => {
      const first = await tournaments.start();
      await tournaments.stop();

      const second = await tournaments.start();

      expect(second.id).not.toBe(first.id);
      await expect(tournaments.findLatest()).resolves.toEqual(second);
      const [{ count }] = await dataSource.query<[{ count: string }]>(
        'SELECT count(*) FROM tournaments',
      );
      expect(count).toBe('2');
    });

    it('finds the last finished tournament when none runs', async () => {
      await tournaments.start();
      await tournaments.stop();
      await tournaments.start();
      const last = await tournaments.stop();

      await expect(tournaments.findLatest()).resolves.toEqual(last);
    });
  });

  describe('standings', () => {
    it('sums each player points and orders by points, then the earlier player first', async () => {
      const { id } = await tournaments.start();
      const alice = await createUser('alice');
      const bob = await createUser('bob');
      const carol = await createUser('carol');
      await addEntry(id, alice, 120, '2026-11-10T10:00:00.000Z');
      await addEntry(id, alice, 230, '2026-11-10T10:00:05.000Z');
      await addEntry(id, bob, 350, '2026-11-10T10:00:03.000Z');
      await addEntry(id, carol, 500, '2026-11-10T10:00:01.000Z');

      const standings = await tournaments.standings(id);

      expect(standings).toEqual([
        {
          tournamentId: id,
          userId: carol.id,
          username: 'carol',
          points: 500,
          reachedAt: Date.parse('2026-11-10T10:00:01.000Z'),
        },
        {
          tournamentId: id,
          userId: bob.id,
          username: 'bob',
          points: 350,
          reachedAt: Date.parse('2026-11-10T10:00:03.000Z'),
        },
        {
          tournamentId: id,
          userId: alice.id,
          username: 'alice',
          points: 350,
          reachedAt: Date.parse('2026-11-10T10:00:05.000Z'),
        },
      ]);
    });

    it('breaks a tie in the same millisecond by the higher user id', async () => {
      const { id } = await tournaments.start();
      const alice = await createUser('alice');
      const bob = await createUser('bob');
      await addEntry(id, alice, 200, '2026-11-10T10:00:00.000100Z');
      await addEntry(id, bob, 200, '2026-11-10T10:00:00.000900Z');
      const [higher, lower] = [alice.id, bob.id].sort().reverse();

      const standings = await tournaments.standings(id);

      expect(standings.map(score => score.userId)).toEqual([higher, lower]);
    });

    it('counts only the given tournament', async () => {
      const first = await tournaments.start();
      const alice = await createUser('alice');
      await addEntry(first.id, alice, 300, '2026-11-10T10:00:00.000Z');
      await tournaments.stop();
      const second = await tournaments.start();
      await addEntry(second.id, alice, 150, '2026-11-10T11:00:00.000Z');

      const standings = await tournaments.standings(second.id);

      expect(standings.map(score => score.points)).toEqual([150]);
    });

    it('is empty without entries', async () => {
      const { id } = await tournaments.start();

      await expect(tournaments.standings(id)).resolves.toEqual([]);
    });

    it('returns the best players up to the limit', async () => {
      const { id } = await tournaments.start();
      const alice = await createUser('alice');
      const bob = await createUser('bob');
      const carol = await createUser('carol');
      await addEntry(id, alice, 100, '2026-11-10T10:00:00.000Z');
      await addEntry(id, bob, 300, '2026-11-10T10:00:00.000Z');
      await addEntry(id, carol, 200, '2026-11-10T10:00:00.000Z');

      const top = await tournaments.top(id, 2);

      expect(top.map(score => score.username)).toEqual(['bob', 'carol']);
    });
  });

  describe('rankOf', () => {
    it('ranks a player in the standings order', async () => {
      const { id } = await tournaments.start();
      const alice = await createUser('alice');
      const bob = await createUser('bob');
      const carol = await createUser('carol');
      await addEntry(id, alice, 300, '2026-11-10T10:00:02.000Z');
      await addEntry(id, bob, 300, '2026-11-10T10:00:01.000Z');
      await addEntry(id, carol, 400, '2026-11-10T10:00:03.000Z');

      await expect(tournaments.rankOf(id, alice.id)).resolves.toEqual({ rank: 3, points: 300 });
      await expect(tournaments.rankOf(id, bob.id)).resolves.toEqual({ rank: 2, points: 300 });
      await expect(tournaments.rankOf(id, carol.id)).resolves.toEqual({ rank: 1, points: 400 });
    });

    it('returns null for a player without points', async () => {
      const { id } = await tournaments.start();
      const alice = await createUser('alice');

      await expect(tournaments.rankOf(id, alice.id)).resolves.toBeNull();
    });
  });
});

describe('Leaderboard cache (Redis)', () => {
  const TOURNAMENT = 'tournament-1';
  let redis: Redis;
  let cache: RedisLeaderboardCache;

  beforeAll(async () => {
    redis = new Redis({ ...redisOptions(), lazyConnect: true });
    await redis.connect();
    cache = new RedisLeaderboardCache(redis);
  });

  afterAll(async () => {
    await cache.onApplicationShutdown();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  function score(
    userId: string,
    points: number,
    reachedAt: number,
    username = userId,
  ): TournamentScore {
    return { tournamentId: TOURNAMENT, userId, username, points, reachedAt };
  }

  it('lists the best players with 1-based ranks', async () => {
    await cache.record([score('alice', 120, 1_000), score('bob', 350, 2_000)]);

    await expect(cache.top(TOURNAMENT, 100)).resolves.toEqual([
      { rank: 1, username: 'bob', points: 350 },
      { rank: 2, username: 'alice', points: 120 },
    ]);
  });

  it('ranks the player who reached equal points first higher', async () => {
    await cache.record([score('alice', 350, 2_000), score('bob', 350, 1_000)]);

    const top = await cache.top(TOURNAMENT, 100);

    expect(top.map(entry => entry.username)).toEqual(['bob', 'alice']);
  });

  it('ranks the higher user id first at equal points and time, as PostgreSQL does', async () => {
    await cache.record([score('aaaa', 350, 1_000), score('bbbb', 350, 1_000)]);

    const top = await cache.top(TOURNAMENT, 100);

    expect(top.map(entry => entry.username)).toEqual(['bbbb', 'aaaa']);
  });

  it('raises a total and keeps one entry per player', async () => {
    await cache.record([score('alice', 120, 1_000)]);
    await cache.record([score('alice', 350, 2_000)]);

    await expect(cache.top(TOURNAMENT, 100)).resolves.toEqual([
      { rank: 1, username: 'alice', points: 350 },
    ]);
  });

  it('never lowers a total, so a late write is ignored', async () => {
    await cache.record([score('alice', 350, 2_000)]);
    await cache.record([score('alice', 120, 1_000)]);

    await expect(cache.rankOf(TOURNAMENT, 'alice')).resolves.toEqual({ rank: 1, points: 350 });
  });

  it('ignores a repeated write', async () => {
    await cache.record([score('alice', 350, 2_000), score('bob', 350, 1_000)]);
    await cache.record([score('alice', 350, 2_000)]);

    await expect(cache.rankOf(TOURNAMENT, 'alice')).resolves.toEqual({ rank: 2, points: 350 });
  });

  it('returns at most the limit', async () => {
    await cache.record([
      score('alice', 100, 1_000),
      score('bob', 200, 1_000),
      score('carol', 300, 1_000),
    ]);

    const top = await cache.top(TOURNAMENT, 2);

    expect(top.map(entry => entry.username)).toEqual(['carol', 'bob']);
  });

  it('is empty for a tournament without scores', async () => {
    await expect(cache.top('other', 100)).resolves.toEqual([]);
  });

  it('keeps tournaments apart', async () => {
    await cache.record([score('alice', 100, 1_000)]);
    await cache.record([{ ...score('alice', 900, 1_000), tournamentId: 'other' }]);

    await expect(cache.rankOf(TOURNAMENT, 'alice')).resolves.toEqual({ rank: 1, points: 100 });
  });

  it('ranks a player outside the top', async () => {
    const scores = Array.from({ length: 150 }, (_, i) => score(`user-${i}`, 1_000 - i, 1_000));
    await cache.record(scores);

    await expect(cache.rankOf(TOURNAMENT, 'user-120')).resolves.toEqual({ rank: 121, points: 880 });
  });

  it('returns null for a player without points', async () => {
    await cache.record([score('alice', 100, 1_000)]);

    await expect(cache.rankOf(TOURNAMENT, 'bob')).resolves.toBeNull();
  });

  it('shows the latest username', async () => {
    await cache.record([score('alice', 100, 1_000, 'alice')]);
    await cache.record([score('alice', 200, 2_000, 'alice2')]);

    await expect(cache.top(TOURNAMENT, 1)).resolves.toEqual([
      { rank: 1, username: 'alice2', points: 200 },
    ]);
  });
});
