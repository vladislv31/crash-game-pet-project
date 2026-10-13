import { randomBytes } from 'node:crypto';

export const RANDOM_RANGE = 2n ** 52n;
export const MAX_CRASH_POINT = 1_000_000;

const HOUSE_SHARE_PERCENT = 99n;
const MIN_CRASH_POINT = 100;

/**
 * Maps a uniform random integer in [0, 2^52) to a crash point in hundredths
 * (198 = 1.98x) with a 1% house edge, capped at 10 000x. The division runs in
 * BigInt because 99 · 2^52 exceeds Number.MAX_SAFE_INTEGER; the capped result fits in a number.
 */
export function crashPointFromRandom(h: bigint): number {
  if (h < 0n || h >= RANDOM_RANGE) {
    throw new RangeError(`Random value must be in [0, 2^52), got ${h}`);
  }

  const raw = (HOUSE_SHARE_PERCENT * RANDOM_RANGE) / (RANDOM_RANGE - h);

  if (raw >= BigInt(MAX_CRASH_POINT)) {
    return MAX_CRASH_POINT;
  }

  return Math.max(MIN_CRASH_POINT, Number(raw));
}

export function generateCrashPoint(): number {
  // 7 bytes = 56 bits; dropping the low 4 leaves a uniform 52-bit value.
  const h = BigInt(`0x${randomBytes(7).toString('hex')}`) >> 4n;

  return crashPointFromRandom(h);
}
