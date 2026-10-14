export const RECONCILIATION_STORE = Symbol('RECONCILIATION_STORE');

export type MismatchType =
  | 'balance'
  | 'bet_entry'
  | 'win_entry'
  | 'refund_entry'
  | 'payout'
  | 'payout_above_max_win'
  | 'cashout_at_or_above_crash'
  | 'orphan_entry';

export const MISMATCH_TYPES: readonly MismatchType[] = [
  'balance',
  'bet_entry',
  'win_entry',
  'refund_entry',
  'payout',
  'payout_above_max_win',
  'cashout_at_or_above_crash',
  'orphan_entry',
];

/**
 * One broken money invariant (ADR-0007). `expected` and `actual` are for a human reading the log:
 * a balance mismatch reports only its difference from the ledger (`expected: '0'`), never the balance.
 */
export interface Mismatch {
  type: MismatchType;
  userId: string;
  betId: string | null;
  expected: string | null;
  actual: string | null;
}

export interface ReconciliationReport {
  usersChecked: number;
  betsChecked: number;
  mismatches: Mismatch[];
}

export interface ReconciliationStore {
  /** Checks every invariant over one consistent snapshot of the database. */
  check(maxWin: string): Promise<ReconciliationReport>;
}
