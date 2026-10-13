import { RoundState } from '../game-state';
import { formatMultiplier, multiplierAt } from '../multiplier';
import { useAnimationClock } from '../use-animation-clock';

export function RoundDisplay({
  round,
  clockOffset,
}: {
  round: RoundState | null;
  clockOffset: number;
}) {
  const now =
    useAnimationClock(round?.phase === 'BETTING' || round?.phase === 'RUNNING') + clockOffset;

  if (!round) {
    return <section className="card round">Waiting for the next round…</section>;
  }

  if (round.phase === 'BETTING') {
    const seconds = Math.max(0, (round.bettingEndsAt - now) / 1000);
    return (
      <section className="card round">
        <p className="label">Next round in</p>
        <p className="countdown">{seconds.toFixed(1)}s</p>
      </section>
    );
  }

  if (round.phase === 'RUNNING' && round.startedAt !== null) {
    // Local curve for a smooth animation; never behind the last tick from the server.
    const multiplier = Math.max(round.multiplier, multiplierAt(now - round.startedAt));
    return (
      <section className="card round running">
        <p className="multiplier">{formatMultiplier(multiplier)}</p>
      </section>
    );
  }

  return (
    <section className="card round crashed">
      <p className="label">Crashed at</p>
      <p className="multiplier">{formatMultiplier(round.crashPoint ?? round.multiplier)}</p>
    </section>
  );
}
