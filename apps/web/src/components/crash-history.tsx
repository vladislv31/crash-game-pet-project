import { formatMultiplier } from '../multiplier';

export function CrashHistory({ history }: { history: number[] }) {
  return (
    <section className="history">
      {history.map((crashPoint, index) => (
        <span key={index} className={crashPoint >= 200 ? 'chip high' : 'chip'}>
          {formatMultiplier(crashPoint)}
        </span>
      ))}
    </section>
  );
}
