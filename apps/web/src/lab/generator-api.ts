import type { LoadRunReport, LoadScenario } from '@crash/contracts';

import type { ScenarioDraft } from './scenario-form';

// Vite proxies /generator to the load generator (ADR-0008).
const BASE = '/generator';

export type StartResult =
  | { ok: true; runId: string }
  | { ok: false; errors: Record<string, string> }
  | { ok: false; message: string };

export async function fetchPresets(): Promise<Record<string, LoadScenario>> {
  const response = await fetch(`${BASE}/presets`);
  if (!response.ok) {
    throw new Error(`Presets failed (${response.status})`);
  }
  return (await response.json()) as Record<string, LoadScenario>;
}

export async function startRun(scenario: ScenarioDraft): Promise<StartResult> {
  const response = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenario),
  });
  if (response.status === 201) {
    return { ok: true, ...((await response.json()) as { runId: string }) };
  }
  if (response.status === 422) {
    return { ok: false, ...((await response.json()) as { errors: Record<string, string> }) };
  }
  if (response.status === 409) {
    return { ok: false, message: 'A run is already active' };
  }
  return { ok: false, message: `Start failed (${response.status})` };
}

export async function stopRun(): Promise<void> {
  await fetch(`${BASE}/run`, { method: 'DELETE' });
}

/** Live run reports, once a second; returns a function that unsubscribes. */
export function subscribe(
  onReport: (report: LoadRunReport) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  const events = new EventSource(`${BASE}/events`);
  events.onopen = () => onConnection(true);
  events.onerror = () => onConnection(false);
  events.onmessage = event => onReport(JSON.parse(String(event.data)) as LoadRunReport);
  return () => events.close();
}
