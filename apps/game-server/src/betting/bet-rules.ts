import Decimal from 'decimal.js';

import { MAX_CRASH_POINT } from '../game/crash-point';

export const MIN_BET = new Decimal(100);
export const MAX_BET = new Decimal(1_000);
export const MAX_WIN = new Decimal(100_000);
export const INITIAL_BALANCE = '5000';

const MIN_AUTO_CASHOUT = 101;
const AMOUNT_FORMAT = /^\d{1,7}(\.\d{1,2})?$/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseBetAmount(input: unknown): ParseResult<string> {
  if (typeof input !== 'string' || !AMOUNT_FORMAT.test(input)) {
    return { ok: false, error: 'invalid' };
  }

  const amount = new Decimal(input);

  if (amount.lessThan(MIN_BET)) {
    return { ok: false, error: 'too_low' };
  }

  if (amount.greaterThan(MAX_BET)) {
    return { ok: false, error: 'too_high' };
  }

  return { ok: true, value: amount.toFixed() };
}

/** Auto-cashout target in hundredths, or null when the player cashes out manually. */
export function parseAutoCashout(input: unknown): ParseResult<number | null> {
  if (input === undefined || input === null) {
    return { ok: true, value: null };
  }

  if (typeof input !== 'number' || !Number.isInteger(input)) {
    return { ok: false, error: 'invalid' };
  }

  if (input < MIN_AUTO_CASHOUT) {
    return { ok: false, error: 'too_low' };
  }

  if (input > MAX_CRASH_POINT) {
    return { ok: false, error: 'too_high' };
  }

  return { ok: true, value: input };
}

export function payoutFor(amount: string, multiplier: number): string {
  return new Decimal(amount).mul(multiplier).div(100).toFixed();
}

/** The multiplier at which a bet is cashed out automatically: its own target or the max win, whichever comes first. */
export function effectiveTarget(amount: string, autoCashout: number | null): number {
  const maxWinTarget = MAX_WIN.mul(100).div(amount).floor().toNumber();

  return Math.min(autoCashout ?? MAX_CRASH_POINT, maxWinTarget);
}
