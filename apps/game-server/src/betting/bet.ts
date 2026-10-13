import type { BetStatus } from '@crash/contracts';

export interface Bet {
  id: string;
  roundId: string;
  userId: string;
  username: string;
  amount: string;
  autoCashout: number | null;
  status: BetStatus;
  cashoutMultiplier: number | null;
  payout: string | null;
}
