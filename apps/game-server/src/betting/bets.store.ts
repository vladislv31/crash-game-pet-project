import { Bet } from './bet';

export const BETS_STORE = Symbol('BETS_STORE');

export interface PlaceBetInput {
  userId: string;
  username: string;
  roundId: string;
  amount: string;
  autoCashout: number | null;
  idempotencyKey: string;
}

export type PlaceBetResult =
  | { status: 'placed' | 'duplicate'; bet: Bet; balance: string }
  | { status: 'insufficient_funds' | 'already_bet' };

export interface CashOutInput {
  betId: string;
  multiplier: number;
  payout: string;
}

/** Money-moving operations. Each one is atomic (ADR-0004). */
export interface BetsStore {
  placeBet(input: PlaceBetInput): Promise<PlaceBetResult>;
  /** Credits the payout only if the bet is still ACTIVE; returns null otherwise. */
  cashOut(input: CashOutInput): Promise<{ bet: Bet; balance: string } | null>;
  markLost(betId: string): Promise<void>;
  findActiveBets(roundId: string): Promise<Bet[]>;
  findUserBet(userId: string, roundId: string): Promise<Bet | null>;
}
