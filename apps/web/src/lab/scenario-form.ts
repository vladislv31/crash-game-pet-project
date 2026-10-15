import type { LoadScenario } from '@crash/contracts';

/** The scenario as the dashboard form edits it: text fields, multipliers as x values, shares as percents. */
export interface ScenarioForm {
  name: string;
  /** `500x300, 1000x300, 2000`: bots x seconds per step; the last may omit seconds to run until stopped. */
  steps: string;
  rampPerSecond: string;
  betProbability: string;
  betAmountMin: string;
  betAmountMax: string;
  autoCashoutShare: string;
  targetMin: string;
  targetMax: string;
  duplicateCashouts: string;
}

/** What the form sends; the generator validates it and answers 422 with errors per field. */
export type ScenarioDraft = Record<keyof LoadScenario, unknown>;

export type FormErrors = Partial<Record<keyof ScenarioForm | 'form', string>>;

const ERROR_TEXT: Record<string, string> = {
  too_low: 'Too low',
  too_high: 'Too high',
  invalid: 'Not a valid number',
  min_above_max: 'Must not be below the minimum',
};

const STEPS_ERROR_TEXT: Record<string, string> = {
  too_low: 'Add at least one step',
  too_high: 'At most 20 steps',
  invalid: 'Use bots x seconds, separated by commas',
};

const STEP_PATTERN = /^(\d+)\s*(?:[x×]\s*(\d+))?$/i;

const ERROR_FIELDS: Record<string, keyof ScenarioForm | 'form'> = {
  'betAmount.min': 'betAmountMin',
  'betAmount.max': 'betAmountMax',
  betAmount: 'betAmountMax',
  'target.min': 'targetMin',
  'target.max': 'targetMax',
  target: 'targetMax',
};

export function toForm(scenario: LoadScenario): ScenarioForm {
  return {
    name: scenario.name,
    steps: scenario.steps
      .map(step =>
        step.durationSeconds === null ? `${step.bots}` : `${step.bots}x${step.durationSeconds}`,
      )
      .join(', '),
    rampPerSecond: String(scenario.rampPerSecond),
    betProbability: String(scenario.betProbability * 100),
    betAmountMin: String(scenario.betAmount.min),
    betAmountMax: String(scenario.betAmount.max),
    autoCashoutShare: String(scenario.autoCashoutShare * 100),
    targetMin: (scenario.target.min / 100).toFixed(2),
    targetMax: (scenario.target.max / 100).toFixed(2),
    duplicateCashouts: String(scenario.duplicateCashouts),
  };
}

export function toScenario(form: ScenarioForm): ScenarioDraft {
  return {
    name: form.name.trim(),
    steps: steps(form.steps),
    rampPerSecond: number(form.rampPerSecond),
    betProbability: scaled(form.betProbability, value => Number((value / 100).toFixed(4))),
    betAmount: { min: number(form.betAmountMin), max: number(form.betAmountMax) },
    autoCashoutShare: scaled(form.autoCashoutShare, value => Number((value / 100).toFixed(4))),
    target: {
      min: scaled(form.targetMin, value => Math.round(value * 100)),
      max: scaled(form.targetMax, value => Math.round(value * 100)),
    },
    duplicateCashouts: number(form.duplicateCashouts),
  };
}

/** Maps the generator's 422 errors (`betAmount.min: 'too_low'`) to form fields and words. */
export function fieldErrors(errors: Record<string, string>): FormErrors {
  const result: FormErrors = {};
  for (const [path, error] of Object.entries(errors)) {
    if (path === 'steps' || path.startsWith('steps.')) {
      result.steps = stepError(path, error);
      continue;
    }
    const field =
      ERROR_FIELDS[path] ?? (path === 'scenario' ? 'form' : (path as keyof ScenarioForm));
    result[field] = ERROR_TEXT[error] ?? error;
  }
  return result;
}

export function formatLatency(latencyMs: number | null): string {
  if (latencyMs === null) {
    return '–';
  }
  return `${latencyMs < 100 ? latencyMs.toFixed(1) : latencyMs.toFixed(0)} ms`;
}

function steps(text: string): unknown[] {
  return text
    .split(',')
    .map(token => token.trim())
    .filter(token => token !== '')
    .map(token => {
      const match = STEP_PATTERN.exec(token);
      if (!match) {
        return token;
      }
      return {
        bots: Number(match[1]),
        durationSeconds: match[2] === undefined ? null : Number(match[2]),
      };
    });
}

/** `steps.1.bots: too_high` → `Step 2 bots: too high`. */
function stepError(path: string, error: string): string {
  const [, index, field] = path.split('.');
  if (index === undefined) {
    return STEPS_ERROR_TEXT[error] ?? error;
  }
  const step = `Step ${Number(index) + 1}`;
  if (field === undefined) {
    return `${step}: not bots x seconds`;
  }
  const what = field === 'bots' ? 'bots' : 'seconds';
  const text =
    error === 'required'
      ? 'needed, only the last step can run until stopped'
      : (ERROR_TEXT[error] ?? error).toLowerCase();
  return `${step} ${what}: ${text}`;
}

/** A number, or the text as typed when it is not one, so the generator reports it. */
function number(text: string): number | string {
  const value = Number(text.trim());
  return text.trim() === '' || Number.isNaN(value) ? text : value;
}

function scaled(text: string, scale: (value: number) => number): number | string {
  const value = number(text);
  return typeof value === 'number' ? scale(value) : value;
}
