// Shared HTTP and WebSocket contract (ADR-0003). Type-only, so apps import it without a build step.
// Multipliers are integers in hundredths (198 = 1.98x); money is a decimal string.

export type RoundPhase = 'BETTING' | 'RUNNING' | 'CRASHED';
export type BetStatus = 'ACTIVE' | 'CASHED_OUT' | 'LOST';

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

export type ClientMessage = BetMessage | CashoutMessage;

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
  | BetAcceptedMessage
  | CashoutAcceptedMessage
  | BalanceMessage
  | ErrorMessage;
