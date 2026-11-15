import { PlayerRank, Tournament, TournamentScore } from './tournament';

export const TOURNAMENTS_STORE = Symbol('TOURNAMENTS_STORE');

/**
 * PostgreSQL, the source of truth (ADR-0009). Standings are ordered by points descending, then
 * `reachedAt` ascending, then user id descending (the same order as the Redis sorted set).
 */
export interface TournamentsStore {
  /** The running tournament, or else the one that started last; null when none was ever run. */
  findLatest(): Promise<Tournament | null>;
  /** Starts a new tournament, or returns the running one. */
  start(): Promise<Tournament>;
  /** Ends the running tournament and returns it; null when none is running. Waits for cashouts in flight. */
  stop(): Promise<Tournament | null>;
  /** Every player's total, for rebuilding the cache. */
  standings(tournamentId: string): Promise<TournamentScore[]>;
  top(tournamentId: string, limit: number): Promise<TournamentScore[]>;
  /** Null when the player has no points in the tournament. */
  rankOf(tournamentId: string, userId: string): Promise<PlayerRank | null>;
}
