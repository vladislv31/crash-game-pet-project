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
  | { status: 'insufficient_funds' | 'already_bet' | 'betting_closed' };

export interface UnsettledBet {
  bet: Bet;
  crashPoint: number;
  /** False when the round was interrupted (e.g. a restart) before its crash was recorded. */
  roundCrashed: boolean;
}

export interface BetWithBalance {
  bet: Bet;
  balance: string;
}

export interface CashOutPrice {
  multiplier: number;
  payout: string;
}

export type CashOutAttempt =
  | { status: 'paid' | 'already_paid'; bet: Bet; balance: string }
  | { status: 'not_paid'; bet: Bet | null };

export interface CashOutInput {
  betId: string;
  multiplier: number;
  payout: string;
}

/** Money-moving operations. Each one is atomic (ADR-0004). */
export interface BetsStore {
  /** Creates the bet only if it commits before its round's betting ends (ADR-0004). */
  placeBet(input: PlaceBetInput): Promise<PlaceBetResult>;
  /** Credits the payout only if the bet is still ACTIVE; returns null otherwise. */
  cashOut(input: CashOutInput): Promise<BetWithBalance | null>;
  /**
   * A player's cashout as one transaction: finds and locks their bet in the round and pays it if it is
   * ACTIVE and `price` returns a price. A single bounded transaction always ends before settlement starts.
   */
  cashOutUserBet(
    userId: string,
    roundId: string,
    price: (bet: Bet) => CashOutPrice | null,
  ): Promise<CashOutAttempt>;
  markLost(betId: string): Promise<void>;
  /** Voids the bet and returns its amount, only if it is still ACTIVE; returns null otherwise. */
  refund(betId: string): Promise<BetWithBalance | null>;
  /** ACTIVE bets of every round except `currentRoundId`, with what is needed to settle them. */
  findUnsettledBets(currentRoundId: string): Promise<UnsettledBet[]>;
  findActiveBets(roundId: string): Promise<Bet[]>;
  findUserBet(userId: string, roundId: string): Promise<Bet | null>;
  findBetByRequest(userId: string, idempotencyKey: string): Promise<BetWithBalance | null>;
  getBalance(userId: string): Promise<string>;
}
