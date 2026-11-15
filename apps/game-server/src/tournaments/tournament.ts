import type { LeaderboardEntry } from '@crash/contracts';

/** Bets below this amount earn no tournament points (ADR-0009). */
export const TOURNAMENT_MIN_BET = '100';
/** How many players the leaderboard shows. */
export const LEADERBOARD_SIZE = 100;

export interface Tournament {
  id: string;
  startedAt: Date;
  /** Null while the tournament runs. */
  endedAt: Date | null;
}

/** A player's total in a tournament. `points` are hundredths; `reachedAt` (ms) breaks ties: earlier ranks higher. */
export interface TournamentScore {
  tournamentId: string;
  userId: string;
  username: string;
  points: number;
  reachedAt: number;
}

export interface PlayerRank {
  /** 1-based. */
  rank: number;
  points: number;
}

/** The leaderboard of the running tournament, or the final one of the last finished tournament. */
export interface Leaderboard {
  tournament: Tournament;
  /** False while the cache cannot be read (Redis down). */
  available: boolean;
  top: LeaderboardEntry[];
}

/** A player's place: `rank` is null when they have no points; `tournamentId` is null when none was ever run. */
export interface PlayerStanding {
  tournamentId: string | null;
  available: boolean;
  rank: number | null;
  points: number;
}

export type TournamentEvent =
  | { type: 'leaderboard'; leaderboard: Leaderboard }
  | { type: 'rank'; userId: string; standing: PlayerStanding };

/** What the cashout path needs from tournaments; implemented by `TournamentsService`. */
export interface TournamentSource {
  /** The running tournament, from memory: no I/O on the cashout path. */
  readonly activeTournamentId: string | null;
  /** Called after a cashout that earned points committed. Never throws; Redis errors are logged. */
  recordScore(score: TournamentScore): void;
}
