import type { LoadRange, LoadScenario } from '@crash/contracts';

export type Range = LoadRange;

/** What a load run does (ADR-0008). Multipliers are in hundredths, amounts are whole units. */
export type Scenario = LoadScenario;

export type ScenarioResult =
  { ok: true; value: Scenario } | { ok: false; errors: Record<string, string> };

const NAME_MAX_LENGTH = 40;

export const PRESETS: Record<string, Scenario> = {
  steady: {
    name: 'steady',
    bots: 100,
    rampPerSecond: 20,
    durationSeconds: null,
    betProbability: 0.8,
    betAmount: { min: 100, max: 500 },
    autoCashoutShare: 0.5,
    target: { min: 120, max: 500 },
    duplicateCashouts: 1,
  },
  ramp: {
    name: 'ramp',
    bots: 1_000,
    rampPerSecond: 10,
    durationSeconds: null,
    betProbability: 0.8,
    betAmount: { min: 100, max: 500 },
    autoCashoutShare: 0.5,
    target: { min: 120, max: 500 },
    duplicateCashouts: 1,
  },
  spike: {
    name: 'spike',
    bots: 2_000,
    rampPerSecond: 500,
    durationSeconds: null,
    betProbability: 0.8,
    betAmount: { min: 100, max: 500 },
    autoCashoutShare: 0.5,
    target: { min: 120, max: 500 },
    duplicateCashouts: 1,
  },
  'duplicate-cashouts': {
    name: 'duplicate-cashouts',
    bots: 50,
    rampPerSecond: 50,
    durationSeconds: null,
    betProbability: 1,
    betAmount: { min: 100, max: 100 },
    autoCashoutShare: 0,
    target: { min: 110, max: 200 },
    duplicateCashouts: 10,
  },
};

/** Validates a scenario from the API; errors use the 422 shape, one key per field. */
export function parseScenario(input: unknown): ScenarioResult {
  if (!isRecord(input)) {
    return { ok: false, errors: { scenario: 'invalid' } };
  }

  const errors: Record<string, string> = {};
  const check = <T>(field: string, result: Checked<T>): T | undefined => {
    if (result.ok) {
      return result.value;
    }
    Object.assign(errors, prefixed(field, result.errors));
    return undefined;
  };

  const scenario = {
    name: check('name', name(input.name)),
    bots: check('bots', integer(input.bots, 1, 20_000)),
    rampPerSecond: check('rampPerSecond', integer(input.rampPerSecond, 1, 1_000)),
    durationSeconds: check(
      'durationSeconds',
      input.durationSeconds === null ? ok(null) : integer(input.durationSeconds, 1, 86_400),
    ),
    betProbability: check('betProbability', fraction(input.betProbability)),
    betAmount: check('betAmount', range(input.betAmount, 100, 1_000)),
    autoCashoutShare: check('autoCashoutShare', fraction(input.autoCashoutShare)),
    target: check('target', range(input.target, 101, 1_000_000)),
    duplicateCashouts: check('duplicateCashouts', integer(input.duplicateCashouts, 1, 100)),
  };

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: scenario as Scenario };
}

/** A value, or errors keyed by a path relative to the field ('' is the field itself). */
type Checked<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

function ok<T>(value: T): Checked<T> {
  return { ok: true, value };
}

function fail(error: string, path = ''): Checked<never> {
  return { ok: false, errors: { [path]: error } };
}

function prefixed(field: string, errors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).map(([path, error]) => [path ? `${field}.${path}` : field, error]),
  );
}

function name(value: unknown): Checked<string> {
  return typeof value === 'string' && value.length > 0 && value.length <= NAME_MAX_LENGTH
    ? ok(value)
    : fail('invalid');
}

function bounded(value: number, min: number, max: number, path = ''): Checked<number> {
  if (value < min) {
    return fail('too_low', path);
  }
  if (value > max) {
    return fail('too_high', path);
  }
  return ok(value);
}

function integer(value: unknown, min: number, max: number, path = ''): Checked<number> {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail('invalid', path);
  }
  return bounded(value, min, max, path);
}

function fraction(value: unknown): Checked<number> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('invalid');
  }
  return bounded(value, 0, 1);
}

function range(value: unknown, min: number, max: number): Checked<Range> {
  if (!isRecord(value)) {
    return fail('invalid');
  }

  const low = integer(value.min, min, max, 'min');
  const high = integer(value.max, min, max, 'max');
  if (!low.ok || !high.ok) {
    return {
      ok: false,
      errors: { ...(low.ok ? {} : low.errors), ...(high.ok ? {} : high.errors) },
    };
  }
  if (low.value > high.value) {
    return fail('min_above_max');
  }
  return ok({ min: low.value, max: high.value });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
