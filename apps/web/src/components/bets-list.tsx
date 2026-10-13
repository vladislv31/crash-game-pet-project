import type { BetView } from '@crash/contracts';

import { formatMultiplier } from '../multiplier';

export function BetsList({ bets }: { bets: BetView[] }) {
  return (
    <section className="card bets">
      <h2>Bets this round ({bets.length})</h2>
      <table>
        <tbody>
          {bets.map(bet => (
            <tr key={bet.id} className={bet.status === 'CASHED_OUT' ? 'win' : undefined}>
              <td>{bet.username}</td>
              <td>{bet.amount}</td>
              <td>{describeResult(bet)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function describeResult(bet: BetView): string {
  if (bet.status === 'VOID') {
    return 'refunded';
  }

  return bet.cashoutMultiplier === null
    ? '—'
    : `${formatMultiplier(bet.cashoutMultiplier)} → ${bet.payout}`;
}
