import type { SetTournamentActiveRequest, TournamentStatusResponse } from '@crash/contracts';

// Vite proxies /tournaments to the game server (ADR-0009).
const ACTIVE_URL = '/tournaments/active';

export async function fetchTournamentStatus(): Promise<TournamentStatusResponse> {
  const response = await fetch(ACTIVE_URL);
  if (!response.ok) {
    throw new Error(`Tournament status failed (${response.status})`);
  }
  return (await response.json()) as TournamentStatusResponse;
}

export async function setTournamentActive(active: boolean): Promise<TournamentStatusResponse> {
  const body: SetTournamentActiveRequest = { active };
  const response = await fetch(ACTIVE_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Tournament switch failed (${response.status})`);
  }
  return (await response.json()) as TournamentStatusResponse;
}
