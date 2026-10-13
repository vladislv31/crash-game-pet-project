// Same curve as the server (ADR-0002): the client animates locally, ticks correct drift.
const GROWTH_PER_MS = 0.000107;

/** Multiplier in hundredths (198 = 1.98x), floored. */
export function multiplierAt(elapsedMs: number): number {
  return Math.floor(100 * Math.exp(GROWTH_PER_MS * Math.max(0, elapsedMs)));
}

export function formatMultiplier(multiplier: number): string {
  return `${(multiplier / 100).toFixed(2)}x`;
}
