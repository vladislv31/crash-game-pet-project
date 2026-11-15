// Shared HTTP and WebSocket contract (ADR-0003). Type-only, so apps import it without a build step.
// Multipliers are integers in hundredths (198 = 1.98x); money is a decimal string.

export type RoundPhase = 'BETTING' | 'RUNNING' | 'CRASHED';
export type BetStatus = 'ACTIVE' | 'CASHED_OUT' | 'LOST' | 'VOID';

export interface LoginRequest {
  username: string;
}

export interface LoginResponse {
  token: string;
  username: string;
  balance: string;
}

export interface ValidationErrorResponse {
  errors: Record<string, string>;
}

export interface BetView {
  id: string;
  roundId: string;
  username: string;
  amount: string;
  autoCashout: number | null;
  status: BetStatus;
  cashoutMultiplier: number | null;
  payout: string | null;
}

export interface RoundView {
  id: string;
  phase: RoundPhase;
  bettingEndsAt: number;
  startedAt: number | null;
}

export interface BetMessage {
  type: 'bet';
  requestId: string;
  amount: string;
  autoCashout?: number;
}

export interface CashoutMessage {
  type: 'cashout';
  requestId: string;
}

/** Asks for the player's place in the current (or last) tournament (ADR-0009). */
export interface TournamentRankRequestMessage {
  type: 'tournament:rank';
  requestId: string;
}

export type ClientMessage = BetMessage | CashoutMessage | TournamentRankRequestMessage;

export type ErrorCode =
  | 'unauthorized'
  | 'invalid_message'
  | 'validation_failed'
  | 'betting_closed'
  | 'cashout_closed'
  | 'insufficient_funds'
  | 'already_bet'
  | 'no_active_bet'
  | 'already_settled'
  | 'request_conflict'
  | 'unavailable'
  | 'internal_error';

export interface SnapshotMessage {
  type: 'snapshot';
  serverTime: number;
  username: string;
  balance: string;
  round: RoundView | null;
  bet: BetView | null;
}

export interface RoundBettingMessage {
  type: 'round:betting';
  roundId: string;
  endsAt: number;
}

export interface RoundStartedMessage {
  type: 'round:started';
  roundId: string;
  startedAt: number;
}

export interface RoundTickMessage {
  type: 'round:tick';
  roundId: string;
  multiplier: number;
}

export interface RoundCrashedMessage {
  type: 'round:crashed';
  roundId: string;
  crashPoint: number;
  crashedAt: number;
}

export interface BetPlacedMessage {
  type: 'bet:placed';
  bet: BetView;
}

export interface BetCashedOutMessage {
  type: 'bet:cashed_out';
  bet: BetView;
}

/** A bet of an interrupted round was voided and its amount returned (ADR-0004). */
export interface BetRefundedMessage {
  type: 'bet:refunded';
  bet: BetView;
}

export interface BetAcceptedMessage {
  type: 'bet:accepted';
  requestId: string;
  bet: BetView;
  balance: string;
}

export interface CashoutAcceptedMessage {
  type: 'cashout:accepted';
  requestId: string;
  bet: BetView;
  balance: string;
}

export interface BalanceMessage {
  type: 'balance';
  balance: string;
}

// Tournaments (ADR-0009). Points are integers in hundredths, like multipliers (350 = 3.50 points).

export interface TournamentView {
  id: string;
  startedAt: number;
  /** Null while the tournament runs. */
  endedAt: number | null;
}

export interface LeaderboardEntry {
  /** 1-based. */
  rank: number;
  username: string;
  points: number;
}

/** Every 2 s while a tournament runs, once when it starts and stops, and to new connections. */
export interface TournamentLeaderboardMessage {
  type: 'tournament:leaderboard';
  /** The running tournament, or the last finished one. */
  tournament: TournamentView;
  /** False while the leaderboard cannot be read (Redis down): the client hides it. */
  available: boolean;
  /** Up to 100 entries, best first. */
  top: LeaderboardEntry[];
}

/** After the player's own cashout that earned points, and in answer to a `tournament:rank` request. */
export interface TournamentRankMessage {
  type: 'tournament:rank';
  /** Set when answering a request. */
  requestId?: string;
  /** Null when no tournament was ever run. */
  tournamentId: string | null;
  available: boolean;
  /** Null when the player has no points in the tournament. */
  rank: number | null;
  points: number;
}

/** `GET /tournaments/active` and the answer to `PUT /tournaments/active`. */
export interface TournamentStatusResponse {
  /** The running tournament, or the last finished one; null when none was ever run. */
  tournament: TournamentView | null;
  active: boolean;
}

/** `PUT /tournaments/active`; idempotent. */
export interface SetTournamentActiveRequest {
  active: boolean;
}

export interface ErrorMessage {
  type: 'error';
  requestId?: string;
  code: ErrorCode;
  errors?: Record<string, string>;
}

export type ServerMessage =
  | SnapshotMessage
  | RoundBettingMessage
  | RoundStartedMessage
  | RoundTickMessage
  | RoundCrashedMessage
  | BetPlacedMessage
  | BetCashedOutMessage
  | BetRefundedMessage
  | BetAcceptedMessage
  | CashoutAcceptedMessage
  | BalanceMessage
  | TournamentLeaderboardMessage
  | TournamentRankMessage
  | ErrorMessage;

// Load generator control API (ADR-0008), used by the test dashboard.

export interface LoadRange {
  min: number;
  max: number;
}

/** Holds `bots` for `durationSeconds`; only the last step may run until stopped (`null`). */
export interface LoadStep {
  bots: number;
  durationSeconds: number | null;
}

/** Multipliers are in hundredths; probabilities and shares are fractions from 0 to 1. */
export interface LoadScenario {
  name: string;
  steps: LoadStep[];
  rampPerSecond: number;
  betProbability: number;
  betAmount: LoadRange;
  autoCashoutShare: number;
  target: LoadRange;
  duplicateCashouts: number;
}

export interface LoadRunStatus {
  runId: string;
  scenario: LoadScenario;
  state: 'running' | 'stopped';
  startedAt: number;
  /** Index into `scenario.steps` of the step in progress (or the last one reached). */
  stepIndex: number;
  /** Bots the current step aims for. */
  botsTarget: number;
  botsStarted: number;
  botsConnected: number;
}

export interface LoadLiveSummary {
  requestsPerSecond: number;
  errorsPerSecond: number;
  latencyMs: { p50: number | null; p99: number | null };
  /** Requests in the window by `"<type> <result>"`. */
  results: Record<string, number>;
}

/** `GET /run` and every server-sent event of `GET /events`. */
export interface LoadRunReport {
  run: LoadRunStatus | null;
  live: LoadLiveSummary;
}
