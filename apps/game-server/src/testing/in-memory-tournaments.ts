import { randomUUID } from 'node:crypto';

import type { LeaderboardEntry } from '@crash/contracts';

import { LeaderboardCache } from '../tournaments/leaderboard-cache';
import { PlayerRank, Tournament, TournamentScore } from '../tournaments/tournament';
import { TournamentsStore } from '../tournaments/tournaments.store';

/** Points descending, then the earlier `reachedAt`, then user id descending (ADR-0009). */
function byStanding(a: TournamentScore, b: TournamentScore): number {
  if (a.points !== b.points) {
    return b.points - a.points;
  }
  if (a.reachedAt !== b.reachedAt) {
    return a.reachedAt - b.reachedAt;
  }
  return a.userId < b.userId ? 1 : a.userId > b.userId ? -1 : 0;
}

function rankIn(scores: TournamentScore[], userId: string): PlayerRank | null {
  const index = scores.findIndex(score => score.userId === userId);
  const score = scores[index];
  return score ? { rank: index + 1, points: score.points } : null;
}

/** Test double for the PostgreSQL tournaments store. */
export class InMemoryTournamentsStore implements TournamentsStore {
  readonly tournaments: Tournament[] = [];
  private readonly scores = new Map<string, Map<string, TournamentScore>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Adds points to a player's total, as a cashout that earned points would. */
  award(tournamentId: string, userId: string, username: string, points: number): TournamentScore {
    const totals = this.scores.get(tournamentId) ?? new Map<string, TournamentScore>();
    this.scores.set(tournamentId, totals);
    const previous = totals.get(userId);
    const score = {
      tournamentId,
      userId,
      username,
      points: (previous?.points ?? 0) + points,
      reachedAt: this.now(),
    };
    totals.set(userId, score);
    return { ...score };
  }

  findLatest(): Promise<Tournament | null> {
    const running = this.tournaments.find(tournament => tournament.endedAt === null);
    const latest = running ?? this.tournaments[this.tournaments.length - 1] ?? null;
    return Promise.resolve(latest ? { ...latest } : null);
  }

  start(): Promise<Tournament> {
    const running = this.tournaments.find(tournament => tournament.endedAt === null);
    if (running) {
      return Promise.resolve({ ...running });
    }

    const tournament = { id: randomUUID(), startedAt: new Date(this.now()), endedAt: null };
    this.tournaments.push(tournament);
    return Promise.resolve({ ...tournament });
  }

  stop(): Promise<Tournament | null> {
    const running = this.tournaments.find(tournament => tournament.endedAt === null);
    if (!running) {
      return Promise.resolve(null);
    }

    running.endedAt = new Date(this.now());
    return Promise.resolve({ ...running });
  }

  standings(tournamentId: string): Promise<TournamentScore[]> {
    return Promise.resolve(this.sorted(tournamentId));
  }

  top(tournamentId: string, limit: number): Promise<TournamentScore[]> {
    return Promise.resolve(this.sorted(tournamentId).slice(0, limit));
  }

  rankOf(tournamentId: string, userId: string): Promise<PlayerRank | null> {
    return Promise.resolve(rankIn(this.sorted(tournamentId), userId));
  }

  private sorted(tournamentId: string): TournamentScore[] {
    const totals = this.scores.get(tournamentId)?.values() ?? [];
    return [...totals].map(score => ({ ...score })).sort(byStanding);
  }
}

/** Test double for the Redis leaderboard. While `down`, every call rejects, like Redis without an offline queue. */
export class InMemoryLeaderboardCache implements LeaderboardCache {
  down = false;
  private readonly scores = new Map<string, Map<string, TournamentScore>>();
  private readonly readyListeners: (() => void)[] = [];

  /** Fires the `onReady` listeners, as a (re)connection to Redis would. */
  ready(): void {
    this.readyListeners.forEach(listener => listener());
  }

  record(scores: TournamentScore[]): Promise<void> {
    if (this.down) {
      return this.unavailable();
    }

    for (const score of scores) {
      const totals = this.scores.get(score.tournamentId) ?? new Map<string, TournamentScore>();
      this.scores.set(score.tournamentId, totals);
      const cached = totals.get(score.userId);
      if (!cached || score.points > cached.points) {
        totals.set(score.userId, { ...score });
      }
    }
    return Promise.resolve();
  }

  top(tournamentId: string, limit: number): Promise<LeaderboardEntry[]> {
    if (this.down) {
      return this.unavailable();
    }

    return Promise.resolve(
      this.sorted(tournamentId)
        .slice(0, limit)
        .map((score, index) => ({
          rank: index + 1,
          username: score.username,
          points: score.points,
        })),
    );
  }

  rankOf(tournamentId: string, userId: string): Promise<PlayerRank | null> {
    if (this.down) {
      return this.unavailable();
    }

    return Promise.resolve(rankIn(this.sorted(tournamentId), userId));
  }

  onReady(listener: () => void): void {
    this.readyListeners.push(listener);
  }

  private sorted(tournamentId: string): TournamentScore[] {
    return [...(this.scores.get(tournamentId)?.values() ?? [])].sort(byStanding);
  }

  private unavailable<T>(): Promise<T> {
    return Promise.reject(new Error('Redis is unavailable'));
  }
}
