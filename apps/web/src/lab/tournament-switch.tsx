import type { TournamentStatusResponse } from '@crash/contracts';
import { useEffect, useState } from 'react';

import { fetchTournamentStatus, setTournamentActive } from './tournament-api';

/** Starts and stops the tournament (ADR-0009). */
export function TournamentSwitch() {
  const [status, setStatus] = useState<TournamentStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetchTournamentStatus()
      .then(setStatus)
      .catch(() => setError('Game server is not reachable on port 3000'));
  }, []);

  async function toggle() {
    if (!status) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      setStatus(await setTournamentActive(!status.active));
    } catch {
      setError('Could not switch the tournament');
    } finally {
      setPending(false);
    }
  }

  const tournament = status?.tournament ?? null;

  return (
    <section className="card lab-tournament">
      <h2>Tournament: {status ? (status.active ? 'running' : 'off') : '…'}</h2>
      <button type="button" disabled={!status || pending} onClick={() => void toggle()}>
        {status?.active ? 'Stop tournament' : 'Start tournament'}
      </button>
      {tournament && (
        <span>
          Started {formatTime(tournament.startedAt)}
          {tournament.endedAt !== null && `, ended ${formatTime(tournament.endedAt)}`}
        </span>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}
