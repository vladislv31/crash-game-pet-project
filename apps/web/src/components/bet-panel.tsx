import type { BetMessage, BetView, ClientMessage } from '@crash/contracts';
import { FormEvent, useState } from 'react';

import { RoundState } from '../game-state';
import { formatMultiplier } from '../multiplier';

interface BetPanelProps {
  round: RoundState | null;
  myBet: BetView | null;
  send: (message: ClientMessage) => void;
}

export function BetPanel({ round, myBet, send }: BetPanelProps) {
  const [amount, setAmount] = useState('100');
  const [autoCashout, setAutoCashout] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const canBet = round?.phase === 'BETTING' && !myBet;
  const canCashOut = round?.phase === 'RUNNING' && myBet?.status === 'ACTIVE';

  function placeBet(event: FormEvent) {
    event.preventDefault();
    const message: BetMessage = {
      type: 'bet',
      requestId: crypto.randomUUID(),
      amount: amount.trim(),
    };

    if (autoCashout.trim() !== '') {
      const target = Math.round(Number(autoCashout) * 100);
      if (!Number.isFinite(target)) {
        setInputError('Auto cash-out must be a number, e.g. 2.00');
        return;
      }
      message.autoCashout = target;
    }

    setInputError(null);
    send(message);
  }

  return (
    <section className="card bet-panel">
      <form onSubmit={placeBet}>
        <label>
          Bet (100 – 1000)
          <input
            value={amount}
            onChange={event => setAmount(event.target.value)}
            inputMode="decimal"
          />
        </label>
        <label>
          Auto cash-out (optional)
          <input
            value={autoCashout}
            onChange={event => setAutoCashout(event.target.value)}
            placeholder="2.00"
            inputMode="decimal"
          />
        </label>
        <button type="submit" disabled={!canBet}>
          Place bet
        </button>
      </form>
      <button
        type="button"
        className="cashout"
        disabled={!canCashOut}
        onClick={() => send({ type: 'cashout', requestId: crypto.randomUUID() })}
      >
        Cash out
      </button>
      {inputError && <p className="error">{inputError}</p>}
      {myBet && <MyBet bet={myBet} />}
    </section>
  );
}

function MyBet({ bet }: { bet: BetView }) {
  if (bet.status === 'VOID') {
    return <p>Round interrupted: your bet of {bet.amount} was refunded</p>;
  }

  if (bet.status === 'CASHED_OUT' && bet.cashoutMultiplier !== null) {
    return (
      <p className="win">
        Cashed out at {formatMultiplier(bet.cashoutMultiplier)}: +{bet.payout}
      </p>
    );
  }

  const target = bet.autoCashout === null ? '' : `, auto at ${formatMultiplier(bet.autoCashout)}`;

  return (
    <p>
      Your bet: {bet.amount}
      {target}
    </p>
  );
}
