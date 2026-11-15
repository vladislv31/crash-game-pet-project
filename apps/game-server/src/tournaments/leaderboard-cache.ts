import type { LeaderboardEntry } from '@crash/contracts';

import { PlayerRank, TournamentScore } from './tournament';

export const LEADERBOARD_CACHE = Symbol('LEADERBOARD_CACHE');

/** The Redis copy of the standings (ADR-0009). Every method rejects while Redis is unreachable. */
export interface LeaderboardCache {
  /** Writes each player's total only if it is higher than the cached one, so it never lowers a total. */
  record(scores: TournamentScore[]): Promise<void>;
  top(tournamentId: string, limit: number): Promise<LeaderboardEntry[]>;
  /** Null when the player has no points in the tournament. */
  rankOf(tournamentId: string, userId: string): Promise<PlayerRank | null>;
  /** Called on every (re)connection, so the service can rebuild the cache from PostgreSQL. */
  onReady(listener: () => void): void;
}
