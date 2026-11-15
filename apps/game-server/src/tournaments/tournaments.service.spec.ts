import {
  InMemoryLeaderboardCache,
  InMemoryTournamentsStore,
} from '../testing/in-memory-tournaments';
import { createTestLogger } from '../testing/test-logger';
import { Leaderboard, TournamentEvent } from './tournament';
import { tournamentIntervals, TournamentsService } from './tournaments.service';

const SNAPSHOT_MS = 2_000;
const REBUILD_MS = 60_000;

function setup(intervals = { snapshotMs: SNAPSHOT_MS, rebuildMs: REBUILD_MS }) {
  const store = new InMemoryTournamentsStore();
  const cache = new InMemoryLeaderboardCache();
  const { logger, events: logged } = createTestLogger();
  const service = new TournamentsService(store, cache, logger, intervals);
  const events: TournamentEvent[] = [];
  service.subscribe(event => events.push(event));

  function leaderboards(): Leaderboard[] {
    return events.flatMap(event => (event.type === 'leaderboard' ? [event.leaderboard] : []));
  }

  return { service, store, cache, logged, events, leaderboards };
}

/** Never settles until `finish` is called, to hold a read in progress. */
function deferred<T>(value: T) {
  let finish = () => undefined as void;
  const promise = new Promise<T>(resolve => (finish = () => resolve(value)));
  return { promise, finish: () => finish() };
}

describe('TournamentsService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('with no tournament ever run', () => {
    it('is not active and has no tournament', async () => {
      const { service } = setup();

      await service.onModuleInit();

      expect(service.activeTournamentId).toBeNull();
      expect(service.status()).toEqual({ tournament: null, active: false });
    });

    it('has no leaderboard', async () => {
      const { service } = setup();

      await service.onModuleInit();

      expect(service.currentLeaderboard()).toBeNull();
    });

    it('gives a standing without a tournament', async () => {
      const { service } = setup();
      await service.onModuleInit();

      await expect(service.rankOf('user-1')).resolves.toEqual({
        tournamentId: null,
        available: true,
        rank: null,
        points: 0,
      });
    });

    it('does not rebuild the cache', async () => {
      const { service, store, cache } = setup();
      const standings = jest.spyOn(store, 'standings');
      await service.onModuleInit();

      cache.ready();
      await jest.advanceTimersByTimeAsync(REBUILD_MS);

      expect(standings).not.toHaveBeenCalled();
    });
  });

  describe('setActive(true)', () => {
    it('starts a tournament and makes it active', async () => {
      const { service, store } = setup();
      await service.onModuleInit();

      const status = await service.setActive(true);

      expect(store.tournaments).toHaveLength(1);
      expect(service.activeTournamentId).toBe(store.tournaments[0]!.id);
      expect(status).toEqual({
        tournament: { id: store.tournaments[0]!.id, startedAt: new Date(), endedAt: null },
        active: true,
      });
    });

    it('broadcasts an empty leaderboard once', async () => {
      const { service, leaderboards } = setup();
      await service.onModuleInit();

      const { tournament } = await service.setActive(true);

      expect(leaderboards()).toEqual([{ tournament, available: true, top: [] }]);
      expect(service.currentLeaderboard()).toEqual({ tournament, available: true, top: [] });
    });

    it('does nothing when a tournament is already running', async () => {
      const { service, store, events } = setup();
      await service.onModuleInit();
      const first = await service.setActive(true);
      const start = jest.spyOn(store, 'start');

      const second = await service.setActive(true);

      expect(second).toEqual(first);
      expect(start).not.toHaveBeenCalled();
      expect(store.tournaments).toHaveLength(1);
      expect(events).toHaveLength(1);
    });

    it('stays inactive when the store fails', async () => {
      const { service, store, events } = setup();
      await service.onModuleInit();
      jest.spyOn(store, 'start').mockRejectedValueOnce(new Error('database down'));

      await expect(service.setActive(true)).rejects.toThrow('database down');

      expect(service.activeTournamentId).toBeNull();
      expect(events).toEqual([]);
    });
  });

  describe('setActive(false)', () => {
    it('ends the tournament and clears the active flag', async () => {
      const { service, store } = setup();
      await service.onModuleInit();
      await service.setActive(true);
      jest.advanceTimersByTime(500);

      const status = await service.setActive(false);

      expect(service.activeTournamentId).toBeNull();
      expect(status).toEqual({
        tournament: expect.objectContaining({ id: store.tournaments[0]!.id, endedAt: new Date() }),
        active: false,
      });
    });

    it('clears the flag before waiting for cashouts in flight', async () => {
      const { service, store } = setup();
      await service.onModuleInit();
      await service.setActive(true);
      const ending = deferred(null);
      jest.spyOn(store, 'stop').mockReturnValueOnce(ending.promise);

      const stopping = service.setActive(false);
      await jest.advanceTimersByTimeAsync(0);

      expect(service.activeTournamentId).toBeNull();
      ending.finish();
      await stopping;
    });

    it('broadcasts the final top 100 from the store once and keeps it', async () => {
      const { service, store, leaderboards } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      store.award(tournament!.id, 'user-1', 'alice', 120);
      jest.advanceTimersByTime(10);
      store.award(tournament!.id, 'user-2', 'bob', 350);

      const { tournament: ended } = await service.setActive(false);

      const final = {
        tournament: ended,
        available: true,
        top: [
          { rank: 1, username: 'bob', points: 350 },
          { rank: 2, username: 'alice', points: 120 },
        ],
      };
      expect(leaderboards().slice(1)).toEqual([final]);
      expect(service.currentLeaderboard()).toEqual(final);
    });

    it('reads at most 100 players for the final leaderboard', async () => {
      const { service, store } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      for (let i = 0; i < 101; i++) {
        store.award(tournament!.id, `user-${i}`, `player${i}`, 100 + i);
      }

      await service.setActive(false);

      expect(service.currentLeaderboard()?.top).toHaveLength(100);
      expect(service.currentLeaderboard()?.top[0]).toEqual({
        rank: 1,
        username: 'player100',
        points: 200,
      });
    });

    it('does nothing when no tournament is running', async () => {
      const { service, store, events } = setup();
      await service.onModuleInit();
      const stop = jest.spyOn(store, 'stop');

      const status = await service.setActive(false);

      expect(status).toEqual({ tournament: null, active: false });
      expect(stop).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it('does nothing the second time', async () => {
      const { service, store, events } = setup();
      await service.onModuleInit();
      await service.setActive(true);
      const first = await service.setActive(false);
      const stop = jest.spyOn(store, 'stop');

      const second = await service.setActive(false);

      expect(second).toEqual(first);
      expect(stop).not.toHaveBeenCalled();
      expect(events).toHaveLength(2);
    });

    it('stays active when the store fails to end the tournament', async () => {
      const { service, store, cache } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      jest.spyOn(store, 'stop').mockRejectedValueOnce(new Error('database down'));

      await expect(service.setActive(false)).rejects.toThrow('database down');

      expect(service.activeTournamentId).toBe(tournament!.id);
      const top = jest.spyOn(cache, 'top');
      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS);
      expect(top).toHaveBeenCalledTimes(1);
    });

    it('ends the tournament with an unavailable leaderboard when the final read fails', async () => {
      const { service, store, logged } = setup();
      await service.onModuleInit();
      await service.setActive(true);
      jest.spyOn(store, 'top').mockRejectedValueOnce(new Error('database down'));

      const { tournament, active } = await service.setActive(false);

      expect(active).toBe(false);
      expect(service.currentLeaderboard()).toEqual({ tournament, available: false, top: [] });
      expect(logged('tournament_final_leaderboard_failed')).toEqual([
        expect.objectContaining({ level: 'error', tournamentId: tournament!.id }),
      ]);
    });

    it('stops the snapshots and rebuilds', async () => {
      const { service, store, cache } = setup();
      await service.onModuleInit();
      await service.setActive(true);
      await service.setActive(false);
      const top = jest.spyOn(cache, 'top');
      const standings = jest.spyOn(store, 'standings');

      cache.ready();
      await jest.advanceTimersByTimeAsync(REBUILD_MS);

      expect(top).not.toHaveBeenCalled();
      expect(standings).not.toHaveBeenCalled();
    });

    it('drops a snapshot that finishes after the tournament ended', async () => {
      const { service, cache, leaderboards } = setup();
      await service.onModuleInit();
      await service.setActive(true);
      const reading = deferred([{ rank: 1, username: 'alice', points: 120 }]);
      jest.spyOn(cache, 'top').mockReturnValueOnce(reading.promise);
      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS);

      const { tournament } = await service.setActive(false);
      reading.finish();
      await jest.advanceTimersByTimeAsync(0);

      expect(leaderboards()).toHaveLength(2);
      expect(service.currentLeaderboard()?.tournament).toEqual(tournament);
    });
  });

  describe('snapshots', () => {
    it('broadcasts the top 100 from the cache every interval', async () => {
      const { service, cache, leaderboards } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      await cache.record([
        {
          tournamentId: tournament!.id,
          userId: 'u1',
          username: 'alice',
          points: 230,
          reachedAt: 1,
        },
      ]);

      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS - 1);
      expect(leaderboards()).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1);
      const snapshot = {
        tournament,
        available: true,
        top: [{ rank: 1, username: 'alice', points: 230 }],
      };
      expect(leaderboards()).toEqual([expect.anything(), snapshot]);
      expect(service.currentLeaderboard()).toEqual(snapshot);

      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS);
      expect(leaderboards()).toHaveLength(3);
    });

    it('reads 100 players', async () => {
      const { service, cache } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      const top = jest.spyOn(cache, 'top');

      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS);

      expect(top).toHaveBeenCalledWith(tournament!.id, 100);
    });

    it('skips a tick while the previous read is running', async () => {
      const { service, cache } = setup();
      await service.onModuleInit();
      await service.setActive(true);
      const reading = deferred([]);
      const top = jest.spyOn(cache, 'top').mockReturnValueOnce(reading.promise);

      await jest.advanceTimersByTimeAsync(3 * SNAPSHOT_MS);
      expect(top).toHaveBeenCalledTimes(1);

      reading.finish();
      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS);
      expect(top).toHaveBeenCalledTimes(2);
    });

    it('broadcasts an unavailable leaderboard while the cache is down', async () => {
      const { service, cache, leaderboards } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      cache.down = true;

      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS);

      const unavailable = { tournament, available: false, top: [] };
      expect(leaderboards()[1]).toEqual(unavailable);
      expect(service.currentLeaderboard()).toEqual(unavailable);
    });

    it('logs an error once when the cache becomes unavailable', async () => {
      const { service, cache, logged } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      cache.down = true;

      await jest.advanceTimersByTimeAsync(3 * SNAPSHOT_MS);

      expect(logged('tournament_leaderboard_unavailable')).toEqual([
        expect.objectContaining({
          level: 'error',
          tournamentId: tournament!.id,
          err: expect.objectContaining({ message: 'Redis is unavailable' }),
        }),
      ]);
    });

    it('logs once when the cache recovers and broadcasts it as available again', async () => {
      const { service, cache, logged, leaderboards } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      cache.down = true;
      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS);

      cache.down = false;
      await jest.advanceTimersByTimeAsync(2 * SNAPSHOT_MS);

      expect(logged('tournament_leaderboard_recovered')).toEqual([
        expect.objectContaining({ level: 'info', tournamentId: tournament!.id }),
      ]);
      expect(leaderboards()[3]).toEqual({ tournament, available: true, top: [] });
    });

    it('does not broadcast or rebuild on a schedule when the intervals are 0', async () => {
      const { service, store, cache, leaderboards } = setup({ snapshotMs: 0, rebuildMs: 0 });
      await service.onModuleInit();
      await service.setActive(true);
      const standings = jest.spyOn(store, 'standings');
      const top = jest.spyOn(cache, 'top');

      await jest.advanceTimersByTimeAsync(10 * REBUILD_MS);

      expect(leaderboards()).toHaveLength(1);
      expect(top).not.toHaveBeenCalled();
      expect(standings).not.toHaveBeenCalled();
    });

    it('logs nothing while the cache stays available', async () => {
      const { service, logged } = setup();
      await service.onModuleInit();
      await service.setActive(true);

      await jest.advanceTimersByTimeAsync(3 * SNAPSHOT_MS);

      expect(logged()).toEqual([]);
    });

    it('keeps broadcasting when a subscriber throws, and logs it', async () => {
      const { service, logged, leaderboards } = setup();
      service.subscribe(() => {
        throw new Error('broken subscriber');
      });
      await service.onModuleInit();
      await service.setActive(true);

      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS);

      expect(leaderboards()).toHaveLength(2);
      expect(logged('tournament_subscriber_failed')[0]).toMatchObject({
        level: 'error',
        type: 'leaderboard',
      });
    });
  });

  describe('rebuild', () => {
    async function running() {
      const context = setup();
      await context.service.onModuleInit();
      const { tournament } = await context.service.setActive(true);
      const id = tournament!.id;
      context.store.award(id, 'user-1', 'alice', 120);
      context.store.award(id, 'user-2', 'bob', 350);
      return { ...context, id };
    }

    it('copies the standings to the cache every interval', async () => {
      const { cache, id } = await running();

      await jest.advanceTimersByTimeAsync(REBUILD_MS);

      await expect(cache.top(id, 100)).resolves.toEqual([
        { rank: 1, username: 'bob', points: 350 },
        { rank: 2, username: 'alice', points: 120 },
      ]);
    });

    it('logs one event per rebuild', async () => {
      const { logged, id } = await running();

      await jest.advanceTimersByTimeAsync(REBUILD_MS);

      expect(logged('tournament_rebuild')).toEqual([
        expect.objectContaining({
          level: 'info',
          tournamentId: id,
          trigger: 'interval',
          players: 2,
          outcome: 'ok',
          durationMs: expect.any(Number),
        }),
      ]);
    });

    it('rebuilds when the cache connection becomes ready', async () => {
      const { cache, logged, id } = await running();

      cache.ready();
      await jest.advanceTimersByTimeAsync(0);

      expect(logged('tournament_rebuild')).toEqual([
        expect.objectContaining({ trigger: 'ready', outcome: 'ok' }),
      ]);
      await expect(cache.rankOf(id, 'user-1')).resolves.toEqual({ rank: 2, points: 120 });
    });

    it('logs a failed rebuild at error level and keeps the schedule', async () => {
      const { cache, logged } = await running();
      cache.down = true;

      await jest.advanceTimersByTimeAsync(REBUILD_MS);
      cache.down = false;
      await jest.advanceTimersByTimeAsync(REBUILD_MS);

      expect(logged('tournament_rebuild')).toEqual([
        expect.objectContaining({
          level: 'error',
          trigger: 'interval',
          outcome: 'failed',
          err: expect.objectContaining({ message: 'Redis is unavailable' }),
        }),
        expect.objectContaining({ level: 'info', outcome: 'ok' }),
      ]);
    });

    it('never runs two rebuilds at once, and runs a requested one afterwards', async () => {
      const { store, cache, logged } = await running();
      const reading = deferred([]);
      const standings = jest.spyOn(store, 'standings').mockReturnValueOnce(reading.promise);
      await jest.advanceTimersByTimeAsync(REBUILD_MS);

      cache.ready();
      cache.ready();
      await jest.advanceTimersByTimeAsync(0);
      expect(standings).toHaveBeenCalledTimes(1);

      reading.finish();
      await jest.advanceTimersByTimeAsync(0);
      expect(standings).toHaveBeenCalledTimes(2);
      expect(logged('tournament_rebuild').map(event => event.trigger)).toEqual([
        'interval',
        'ready',
      ]);
    });
  });

  describe('recordScore', () => {
    it('writes the score to the cache and sends the player their rank', async () => {
      const { service, cache, events } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      const id = tournament!.id;
      await cache.record([
        { tournamentId: id, userId: 'user-2', username: 'bob', points: 500, reachedAt: 1 },
      ]);

      service.recordScore({
        tournamentId: id,
        userId: 'user-1',
        username: 'alice',
        points: 350,
        reachedAt: Date.now(),
      });
      await jest.advanceTimersByTimeAsync(0);

      expect(events.slice(1)).toEqual([
        {
          type: 'rank',
          userId: 'user-1',
          standing: { tournamentId: id, available: true, rank: 2, points: 350 },
        },
      ]);
    });

    it('sends the points from the score as unavailable when the cache is down, and logs it', async () => {
      const { service, cache, events, logged } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      const id = tournament!.id;
      cache.down = true;

      expect(() =>
        service.recordScore({
          tournamentId: id,
          userId: 'user-1',
          username: 'alice',
          points: 350,
          reachedAt: Date.now(),
        }),
      ).not.toThrow();
      await jest.advanceTimersByTimeAsync(0);

      expect(events.slice(1)).toEqual([
        {
          type: 'rank',
          userId: 'user-1',
          standing: { tournamentId: id, available: false, rank: null, points: 350 },
        },
      ]);
      expect(logged('tournament_score_failed')).toEqual([
        expect.objectContaining({
          level: 'error',
          tournamentId: id,
          userId: 'user-1',
          err: expect.objectContaining({ message: 'Redis is unavailable' }),
        }),
      ]);
    });
  });

  describe('rankOf', () => {
    it('reads the running tournament from the cache', async () => {
      const { service, cache } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      const id = tournament!.id;
      await cache.record([
        { tournamentId: id, userId: 'user-1', username: 'alice', points: 120, reachedAt: 1 },
      ]);

      await expect(service.rankOf('user-1')).resolves.toEqual({
        tournamentId: id,
        available: true,
        rank: 1,
        points: 120,
      });
    });

    it('gives no rank and no points to a player without points', async () => {
      const { service } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);

      await expect(service.rankOf('user-1')).resolves.toEqual({
        tournamentId: tournament!.id,
        available: true,
        rank: null,
        points: 0,
      });
    });

    it('answers unavailable while the cache is down', async () => {
      const { service, cache } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      cache.down = true;

      await expect(service.rankOf('user-1')).resolves.toEqual({
        tournamentId: tournament!.id,
        available: false,
        rank: null,
        points: 0,
      });
    });

    it('reads a finished tournament from the store', async () => {
      const { service, store, cache } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      const id = tournament!.id;
      store.award(id, 'user-1', 'alice', 120);
      store.award(id, 'user-2', 'bob', 350);
      await service.setActive(false);
      cache.down = true;

      await expect(service.rankOf('user-1')).resolves.toEqual({
        tournamentId: id,
        available: true,
        rank: 2,
        points: 120,
      });
    });

    it('gives no rank in a finished tournament to a player without points', async () => {
      const { service } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      await service.setActive(false);

      await expect(service.rankOf('user-1')).resolves.toEqual({
        tournamentId: tournament!.id,
        available: true,
        rank: null,
        points: 0,
      });
    });

    it('answers unavailable and logs when the store fails for a finished tournament', async () => {
      const { service, store, logged } = setup();
      await service.onModuleInit();
      const { tournament } = await service.setActive(true);
      await service.setActive(false);
      jest.spyOn(store, 'rankOf').mockRejectedValueOnce(new Error('database down'));

      await expect(service.rankOf('user-1')).resolves.toEqual({
        tournamentId: tournament!.id,
        available: false,
        rank: null,
        points: 0,
      });
      expect(logged('tournament_rank_failed')).toEqual([
        expect.objectContaining({ level: 'error', tournamentId: tournament!.id, userId: 'user-1' }),
      ]);
    });
  });

  describe('init', () => {
    it('resumes a running tournament and rebuilds the cache from the store', async () => {
      const { service, store, cache, logged } = setup();
      const tournament = await store.start();
      store.award(tournament.id, 'user-1', 'alice', 120);

      await service.onModuleInit();

      expect(service.activeTournamentId).toBe(tournament.id);
      expect(service.status()).toEqual({ tournament, active: true });
      await expect(cache.rankOf(tournament.id, 'user-1')).resolves.toEqual({
        rank: 1,
        points: 120,
      });
      expect(logged('tournament_rebuild')).toEqual([
        expect.objectContaining({ trigger: 'init', players: 1, outcome: 'ok' }),
      ]);
    });

    it('starts the snapshots and rebuilds of a running tournament', async () => {
      const { service, store, cache, leaderboards } = setup();
      const tournament = await store.start();
      const standings = jest.spyOn(store, 'standings');
      await service.onModuleInit();

      await jest.advanceTimersByTimeAsync(SNAPSHOT_MS);
      expect(leaderboards()).toEqual([{ tournament, available: true, top: [] }]);

      await jest.advanceTimersByTimeAsync(REBUILD_MS);
      expect(standings).toHaveBeenCalledTimes(2);
      cache.ready();
      await jest.advanceTimersByTimeAsync(0);
      expect(standings).toHaveBeenCalledTimes(3);
    });

    it('starts even when the cache is down', async () => {
      const { service, store, cache } = setup();
      const tournament = await store.start();
      cache.down = true;

      await service.onModuleInit();

      expect(service.activeTournamentId).toBe(tournament.id);
    });

    it('loads the final leaderboard of a finished tournament without broadcasting it', async () => {
      const { service, store, events } = setup();
      const started = await store.start();
      store.award(started.id, 'user-1', 'alice', 120);
      const tournament = await store.stop();

      await service.onModuleInit();

      expect(service.activeTournamentId).toBeNull();
      expect(service.status()).toEqual({ tournament, active: false });
      expect(service.currentLeaderboard()).toEqual({
        tournament,
        available: true,
        top: [{ rank: 1, username: 'alice', points: 120 }],
      });
      expect(events).toEqual([]);
    });

    it('does not schedule anything for a finished tournament', async () => {
      const { service, store, cache } = setup();
      await store.start();
      await store.stop();
      const standings = jest.spyOn(store, 'standings');
      const top = jest.spyOn(cache, 'top');
      await service.onModuleInit();

      cache.ready();
      await jest.advanceTimersByTimeAsync(REBUILD_MS);

      expect(standings).not.toHaveBeenCalled();
      expect(top).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('stops the snapshots and rebuilds', async () => {
      const { service, store, cache } = setup();
      await service.onModuleInit();
      await service.setActive(true);
      const standings = jest.spyOn(store, 'standings');
      const top = jest.spyOn(cache, 'top');

      await service.beforeApplicationShutdown();
      await jest.advanceTimersByTimeAsync(10 * REBUILD_MS);

      expect(standings).not.toHaveBeenCalled();
      expect(top).not.toHaveBeenCalled();
    });

    it('waits for a rebuild in progress before the database closes', async () => {
      const { service, store } = setup();
      await service.onModuleInit();
      await service.setActive(true);
      const reading = deferred([]);
      jest.spyOn(store, 'standings').mockReturnValueOnce(reading.promise);
      await jest.advanceTimersByTimeAsync(REBUILD_MS);

      let closed = false;
      const closing = service.beforeApplicationShutdown().then(() => (closed = true));
      await jest.advanceTimersByTimeAsync(0);
      expect(closed).toBe(false);

      reading.finish();
      await closing;
      expect(closed).toBe(true);
    });
  });
});

describe('tournamentIntervals', () => {
  it('defaults to a snapshot every 2 s and a rebuild every minute', () => {
    expect(tournamentIntervals({})).toEqual({ snapshotMs: 2_000, rebuildMs: 60_000 });
  });

  it('reads both intervals from the environment', () => {
    expect(
      tournamentIntervals({
        TOURNAMENT_SNAPSHOT_INTERVAL_MS: '500',
        TOURNAMENT_REBUILD_INTERVAL_MS: '0',
      }),
    ).toEqual({ snapshotMs: 500, rebuildMs: 0 });
  });

  it.each([['abc'], ['-1'], ['1.5'], ['']])('rejects %p', value => {
    expect(() => tournamentIntervals({ TOURNAMENT_SNAPSHOT_INTERVAL_MS: value })).toThrow(
      'TOURNAMENT_SNAPSHOT_INTERVAL_MS',
    );
    expect(() => tournamentIntervals({ TOURNAMENT_REBUILD_INTERVAL_MS: value })).toThrow(
      'TOURNAMENT_REBUILD_INTERVAL_MS',
    );
  });
});
