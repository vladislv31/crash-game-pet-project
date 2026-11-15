import { BeforeApplicationShutdown, Inject, Injectable, OnModuleInit } from '@nestjs/common';

import { APP_LOGGER } from '../logging/logger';
import type { AppLogger } from '../logging/logger';
import { WideEvent } from '../logging/wide-event';
import { LEADERBOARD_CACHE } from './leaderboard-cache';
import type { LeaderboardCache } from './leaderboard-cache';
import {
  LEADERBOARD_SIZE,
  Leaderboard,
  PlayerRank,
  PlayerStanding,
  Tournament,
  TournamentEvent,
  TournamentScore,
  TournamentSource,
} from './tournament';
import { TOURNAMENTS_STORE } from './tournaments.store';
import type { TournamentsStore } from './tournaments.store';

export const TOURNAMENT_INTERVALS = Symbol('TOURNAMENT_INTERVALS');

/** Milliseconds between leaderboard broadcasts and between cache rebuilds; 0 turns that schedule off. */
export interface TournamentIntervals {
  snapshotMs: number;
  rebuildMs: number;
}

export interface TournamentStatus {
  /** The running tournament, or the last finished one; null when none was ever run. */
  tournament: Tournament | null;
  active: boolean;
}

type RebuildTrigger = 'init' | 'ready' | 'interval';

/** `TOURNAMENT_SNAPSHOT_INTERVAL_MS` (default 2 s) and `TOURNAMENT_REBUILD_INTERVAL_MS` (default 60 s). */
export function tournamentIntervals(env: NodeJS.ProcessEnv): TournamentIntervals {
  return {
    snapshotMs: intervalMs(env, 'TOURNAMENT_SNAPSHOT_INTERVAL_MS', 2_000),
    rebuildMs: intervalMs(env, 'TOURNAMENT_REBUILD_INTERVAL_MS', 60_000),
  };
}

function intervalMs(env: NodeJS.ProcessEnv, name: string, defaultMs: number): number {
  const value = env[name];
  if (value === undefined) {
    return defaultMs;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a whole number of milliseconds, got "${value}"`);
  }
  return Number(value);
}

/** The tournament switch, the active flag and the leaderboard broadcasts (ADR-0009). */
@Injectable()
export class TournamentsService
  implements TournamentSource, OnModuleInit, BeforeApplicationShutdown
{
  private readonly listeners: ((event: TournamentEvent) => void)[] = [];
  private active: Tournament | null = null;
  private latest: Tournament | null = null;
  private leaderboard: Leaderboard | null = null;
  private cacheAvailable = true;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private snapshotting: Promise<void> | null = null;
  private rebuilding: Promise<void> | null = null;
  private pendingRebuild: RebuildTrigger | null = null;
  /** Switches run one after another, so a start and a stop never interleave. */
  private switching: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(TOURNAMENTS_STORE) private readonly store: TournamentsStore,
    @Inject(LEADERBOARD_CACHE) private readonly cache: LeaderboardCache,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(TOURNAMENT_INTERVALS) private readonly intervals: TournamentIntervals,
  ) {}

  get activeTournamentId(): string | null {
    return this.active?.id ?? null;
  }

  async onModuleInit(): Promise<void> {
    this.cache.onReady(() => this.requestRebuild('ready'));

    const latest = await this.store.findLatest();
    this.latest = latest;
    if (!latest) {
      return;
    }
    if (latest.endedAt !== null) {
      this.leaderboard = await this.finalLeaderboard(latest);
      return;
    }

    this.active = latest;
    this.startTimers();
    this.requestRebuild('init');
    await this.rebuilding;
  }

  /** Runs before the database closes, so a rebuild or snapshot in progress is not cut off. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopTimers();
    await Promise.all([this.snapshotting, this.rebuilding]);
  }

  subscribe(listener: (event: TournamentEvent) => void): void {
    this.listeners.push(listener);
  }

  status(): TournamentStatus {
    return { tournament: this.latest, active: this.active !== null };
  }

  currentLeaderboard(): Leaderboard | null {
    return this.leaderboard;
  }

  /** Idempotent: starting a running tournament or stopping when none runs changes nothing. */
  setActive(active: boolean): Promise<TournamentStatus> {
    const result = this.switching.then(() => (active ? this.start() : this.stop()));
    this.switching = result.catch(() => undefined);
    return result;
  }

  recordScore(score: TournamentScore): void {
    void this.publishRank(score);
  }

  async rankOf(userId: string): Promise<PlayerStanding> {
    if (this.active) {
      const tournamentId = this.active.id;
      try {
        return standing(tournamentId, await this.cache.rankOf(tournamentId, userId));
      } catch {
        // The outage is already logged by the snapshots; every request would only repeat it.
        return { tournamentId, available: false, rank: null, points: 0 };
      }
    }

    if (!this.latest) {
      return { tournamentId: null, available: true, rank: null, points: 0 };
    }

    const tournamentId = this.latest.id;
    try {
      return standing(tournamentId, await this.store.rankOf(tournamentId, userId));
    } catch (error) {
      this.logger.error({ event: 'tournament_rank_failed', tournamentId, userId, err: error });
      return { tournamentId, available: false, rank: null, points: 0 };
    }
  }

  private async start(): Promise<TournamentStatus> {
    if (this.active) {
      return this.status();
    }

    const tournament = await this.store.start();
    this.active = tournament;
    this.latest = tournament;
    this.publishLeaderboard({ tournament, available: true, top: [] });
    this.startTimers();
    return this.status();
  }

  private async stop(): Promise<TournamentStatus> {
    const running = this.active;
    if (!running) {
      return this.status();
    }

    // Cleared before waiting for cashouts in flight, so new cashouts stop earning points.
    this.active = null;
    this.stopTimers();
    let ended: Tournament | null;
    try {
      ended = (await this.store.stop()) ?? (await this.store.findLatest());
    } catch (error) {
      this.active = running;
      this.startTimers();
      throw error;
    }

    this.latest = ended;
    if (ended) {
      this.publishLeaderboard(await this.finalLeaderboard(ended));
    }
    return this.status();
  }

  private async finalLeaderboard(tournament: Tournament): Promise<Leaderboard> {
    try {
      const scores = await this.store.top(tournament.id, LEADERBOARD_SIZE);
      const top = scores.map((score, index) => ({
        rank: index + 1,
        username: score.username,
        points: score.points,
      }));
      return { tournament, available: true, top };
    } catch (error) {
      this.logger.error({
        event: 'tournament_final_leaderboard_failed',
        tournamentId: tournament.id,
        err: error,
      });
      return { tournament, available: false, top: [] };
    }
  }

  private startTimers(): void {
    if (this.intervals.snapshotMs > 0) {
      this.snapshotTimer = setInterval(
        () => this.snapshotUnlessRunning(),
        this.intervals.snapshotMs,
      );
    }
    if (this.intervals.rebuildMs > 0) {
      this.rebuildTimer = setInterval(
        () => this.requestRebuild('interval'),
        this.intervals.rebuildMs,
      );
    }
  }

  private stopTimers(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.rebuildTimer) {
      clearInterval(this.rebuildTimer);
      this.rebuildTimer = null;
    }
  }

  private snapshotUnlessRunning(): void {
    const tournament = this.active;
    if (this.snapshotting || !tournament) {
      return;
    }
    this.snapshotting = this.snapshot(tournament).finally(() => (this.snapshotting = null));
  }

  private async snapshot(tournament: Tournament): Promise<void> {
    let leaderboard: Leaderboard;
    try {
      const top = await this.cache.top(tournament.id, LEADERBOARD_SIZE);
      leaderboard = { tournament, available: true, top };
      if (!this.cacheAvailable) {
        this.cacheAvailable = true;
        this.logger.info({
          event: 'tournament_leaderboard_recovered',
          tournamentId: tournament.id,
        });
      }
    } catch (error) {
      leaderboard = { tournament, available: false, top: [] };
      if (this.cacheAvailable) {
        this.cacheAvailable = false;
        this.logger.error({
          event: 'tournament_leaderboard_unavailable',
          tournamentId: tournament.id,
          err: error,
        });
      }
    }

    // The tournament may have stopped during the read; its final leaderboard is already out.
    if (this.active?.id === tournament.id) {
      this.publishLeaderboard(leaderboard);
    }
  }

  /** At most one rebuild runs; requests during it are folded into one more run afterwards. */
  private requestRebuild(trigger: RebuildTrigger): void {
    if (!this.active) {
      return;
    }
    if (this.rebuilding) {
      this.pendingRebuild = trigger;
      return;
    }
    this.rebuilding = this.rebuildUntilSettled(trigger).finally(() => (this.rebuilding = null));
  }

  private async rebuildUntilSettled(first: RebuildTrigger): Promise<void> {
    let trigger: RebuildTrigger | null = first;
    while (trigger && this.active) {
      this.pendingRebuild = null;
      await this.rebuild(this.active, trigger);
      trigger = this.pendingRebuild;
    }
  }

  private async rebuild(tournament: Tournament, trigger: RebuildTrigger): Promise<void> {
    const log = new WideEvent(this.logger, 'tournament_rebuild', {
      tournamentId: tournament.id,
      trigger,
    });
    try {
      const standings = await this.store.standings(tournament.id);
      log.set({ players: standings.length });
      await this.cache.record(standings);
      log.set({ outcome: 'ok' });
    } catch (error) {
      log.set({ outcome: 'failed' });
      log.fail(error);
    } finally {
      log.emit();
    }
  }

  private async publishRank(score: TournamentScore): Promise<void> {
    const { tournamentId, userId } = score;
    let playerStanding: PlayerStanding;
    try {
      await this.cache.record([score]);
      playerStanding = standing(tournamentId, await this.cache.rankOf(tournamentId, userId));
    } catch (error) {
      this.logger.error({ event: 'tournament_score_failed', tournamentId, userId, err: error });
      playerStanding = { tournamentId, available: false, rank: null, points: score.points };
    }
    this.emit({ type: 'rank', userId, standing: playerStanding });
  }

  private publishLeaderboard(leaderboard: Leaderboard): void {
    this.leaderboard = leaderboard;
    this.emit({ type: 'leaderboard', leaderboard });
  }

  // Events are emitted from timers, so a failing subscriber must not break the schedule or the others.
  private emit(event: TournamentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ event: 'tournament_subscriber_failed', type: event.type, err: error });
      }
    }
  }
}

function standing(tournamentId: string, rank: PlayerRank | null): PlayerStanding {
  return {
    tournamentId,
    available: true,
    rank: rank?.rank ?? null,
    points: rank?.points ?? 0,
  };
}
