// ≈ ln 2 / 6500: the multiplier reaches 2x after about 6.5 s
const GROWTH_PER_MS = 0.000107;

/** Multiplier in hundredths (198 = 1.98x), floored, `elapsedMs` after the round started running. */
export function multiplierAt(elapsedMs: number): number {
  if (elapsedMs < 0) {
    throw new RangeError(`Elapsed time must be non-negative, got ${elapsedMs}`);
  }

  return Math.floor(100 * Math.exp(GROWTH_PER_MS * elapsedMs));
}

/** First whole millisecond at which `multiplierAt` reaches `crashPoint` (in hundredths). */
export function crashTimeMs(crashPoint: number): number {
  return Math.ceil(Math.log(crashPoint / 100) / GROWTH_PER_MS);
}
