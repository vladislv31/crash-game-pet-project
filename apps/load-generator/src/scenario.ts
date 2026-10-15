import type { LoadRange, LoadScenario, LoadStep } from '@crash/contracts';

export type Range = LoadRange;
export type Step = LoadStep;

/** What a load run does (ADR-0008). Multipliers are in hundredths, amounts are whole units. */
export type Scenario = LoadScenario;

export type ScenarioResult =
  { ok: true; value: Scenario } | { ok: false; errors: Record<string, string> };

const NAME_MAX_LENGTH = 40;
const MAX_STEPS = 20;

export const PRESETS: Record<string, Scenario> = {
  steady: {
    name: 'steady',
    steps: [{ bots: 100, durationSeconds: null }],
    rampPerSecond: 20,
    betProbability: 0.8,
    betAmount: { min: 100, max: 500 },
    autoCashoutShare: 0.5,
    target: { min: 120, max: 500 },
    duplicateCashouts: 1,
  },
  ramp: {
    name: 'ramp',
    steps: [{ bots: 1_000, durationSeconds: null }],
    rampPerSecond: 10,
    betProbability: 0.8,
    betAmount: { min: 100, max: 500 },
    autoCashoutShare: 0.5,
    target: { min: 120, max: 500 },
    duplicateCashouts: 1,
  },
  spike: {
    name: 'spike',
    steps: [{ bots: 2_000, durationSeconds: null }],
    rampPerSecond: 500,
    betProbability: 0.8,
    betAmount: { min: 100, max: 500 },
    autoCashoutShare: 0.5,
    target: { min: 120, max: 500 },
    duplicateCashouts: 1,
  },
  steps: {
    name: 'steps',
    steps: [
      { bots: 500, durationSeconds: 300 },
      { bots: 1_000, durationSeconds: 300 },
      { bots: 2_000, durationSeconds: 300 },
      { bots: 4_000, durationSeconds: 300 },
    ],
    rampPerSecond: 100,
    betProbability: 1,
    betAmount: { min: 100, max: 500 },
    autoCashoutShare: 0.5,
    target: { min: 120, max: 500 },
    duplicateCashouts: 1,
  },
  'duplicate-cashouts': {
    name: 'duplicate-cashouts',
    steps: [{ bots: 50, durationSeconds: null }],
    rampPerSecond: 50,
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
    steps: check('steps', steps(input.steps)),
    rampPerSecond: check('rampPerSecond', integer(input.rampPerSecond, 1, 1_000)),
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

function steps(value: unknown): Checked<Step[]> {
  if (!Array.isArray(value)) {
    return fail('invalid');
  }
  if (value.length === 0) {
    return fail('too_low');
  }
  if (value.length > MAX_STEPS) {
    return fail('too_high');
  }

  const errors: Record<string, string> = {};
  const parsed = value.map((item: unknown, index): Step | undefined => {
    const result = step(item, index === value.length - 1);
    if (result.ok) {
      return result.value;
    }
    Object.assign(errors, prefixed(String(index), result.errors));
    return undefined;
  });
  return Object.keys(errors).length > 0 ? { ok: false, errors } : ok(parsed as Step[]);
}

function step(value: unknown, last: boolean): Checked<Step> {
  if (!isRecord(value)) {
    return fail('invalid');
  }

  const bots = integer(value.bots, 1, 20_000, 'bots');
  const duration =
    value.durationSeconds === null
      ? last
        ? ok(null)
        : fail('required', 'durationSeconds')
      : integer(value.durationSeconds, 1, 86_400, 'durationSeconds');
  if (!bots.ok || !duration.ok) {
    return {
      ok: false,
      errors: { ...(bots.ok ? {} : bots.errors), ...(duration.ok ? {} : duration.errors) },
    };
  }
  return ok({ bots: bots.value, durationSeconds: duration.value });
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
