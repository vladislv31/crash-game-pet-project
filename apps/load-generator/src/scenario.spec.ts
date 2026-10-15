import { parseScenario, PRESETS, Scenario } from './scenario';

const VALID: Scenario = {
  name: 'custom',
  steps: [{ bots: 100, durationSeconds: null }],
  rampPerSecond: 10,
  betProbability: 0.8,
  betAmount: { min: 100, max: 500 },
  autoCashoutShare: 0.5,
  target: { min: 120, max: 500 },
  duplicateCashouts: 1,
};

function errorsFor(changes: Record<string, unknown>) {
  const result = parseScenario({ ...VALID, ...changes });
  return result.ok ? {} : result.errors;
}

describe('parseScenario', () => {
  it('accepts a valid scenario as it is', () => {
    expect(parseScenario(VALID)).toEqual({ ok: true, value: VALID });
  });

  it('accepts steps that each hold for a while', () => {
    const steps = [
      { bots: 500, durationSeconds: 300 },
      { bots: 1_000, durationSeconds: 300 },
      { bots: 200, durationSeconds: 60 },
    ];

    expect(parseScenario({ ...VALID, steps })).toEqual({ ok: true, value: { ...VALID, steps } });
  });

  it('lets only the last step run until stopped', () => {
    const steps = [
      { bots: 500, durationSeconds: null },
      { bots: 1_000, durationSeconds: 300 },
    ];

    expect(errorsFor({ steps })).toEqual({ 'steps.0.durationSeconds': 'required' });
  });

  it.each<[unknown, Record<string, string>]>([
    ['500', { steps: 'invalid' }],
    [[], { steps: 'too_low' }],
    [Array.from({ length: 21 }, () => ({ bots: 1, durationSeconds: 1 })), { steps: 'too_high' }],
    [[{ bots: 10, durationSeconds: 1 }, 'x'], { 'steps.1': 'invalid' }],
    [[{ bots: 0, durationSeconds: null }], { 'steps.0.bots': 'too_low' }],
    [[{ bots: 20_001, durationSeconds: null }], { 'steps.0.bots': 'too_high' }],
    [[{ bots: 1.5, durationSeconds: null }], { 'steps.0.bots': 'invalid' }],
    [[{ bots: 10, durationSeconds: 0 }], { 'steps.0.durationSeconds': 'too_low' }],
    [[{ bots: 10, durationSeconds: 86_401 }], { 'steps.0.durationSeconds': 'too_high' }],
    [[{ bots: 10, durationSeconds: 'forever' }], { 'steps.0.durationSeconds': 'invalid' }],
  ])('checks steps %p', (steps, errors) => {
    expect(errorsFor({ steps })).toEqual(errors);
  });

  it('accepts the boundary step values', () => {
    const steps = [
      ...Array.from({ length: 19 }, () => ({ bots: 1, durationSeconds: 1 })),
      { bots: 20_000, durationSeconds: 86_400 },
    ];

    expect(errorsFor({ steps })).toEqual({});
  });

  it('drops fields it does not know', () => {
    expect(parseScenario({ ...VALID, extra: 'x' })).toEqual({ ok: true, value: VALID });
  });

  it.each([[null], ['text'], [[]], [42]])('rejects %p as a whole', input => {
    expect(parseScenario(input)).toEqual({ ok: false, errors: { scenario: 'invalid' } });
  });

  it('reports every invalid field at once', () => {
    expect(errorsFor({ rampPerSecond: 0, betProbability: 2 })).toEqual({
      rampPerSecond: 'too_low',
      betProbability: 'too_high',
    });
  });

  it.each<[string, unknown, string]>([
    ['name', '', 'invalid'],
    ['name', 'x'.repeat(41), 'invalid'],
    ['name', 7, 'invalid'],
    ['rampPerSecond', '10', 'invalid'],
    ['rampPerSecond', 0, 'too_low'],
    ['rampPerSecond', 1_001, 'too_high'],
    ['betProbability', -0.1, 'too_low'],
    ['betProbability', 1.1, 'too_high'],
    ['autoCashoutShare', -1, 'too_low'],
    ['autoCashoutShare', 2, 'too_high'],
    ['duplicateCashouts', 0, 'too_low'],
    ['duplicateCashouts', 101, 'too_high'],
  ])('rejects %s = %p as %s', (field, value, error) => {
    expect(errorsFor({ [field]: value })).toEqual({ [field]: error });
  });

  it.each<[string, number]>([
    ['rampPerSecond', 1_000],
    ['betProbability', 0],
    ['betProbability', 1],
    ['autoCashoutShare', 0],
    ['autoCashoutShare', 1],
    ['duplicateCashouts', 100],
  ])('accepts the boundary %s = %p', (field, value) => {
    expect(errorsFor({ [field]: value })).toEqual({});
  });

  it.each<[unknown, Record<string, string>]>([
    [{ min: 99, max: 500 }, { 'betAmount.min': 'too_low' }],
    [{ min: 100, max: 1_001 }, { 'betAmount.max': 'too_high' }],
    [{ min: 100.5, max: 500 }, { 'betAmount.min': 'invalid' }],
    [{ min: 600, max: 500 }, { betAmount: 'min_above_max' }],
    ['100', { betAmount: 'invalid' }],
  ])('checks the bet amount range %p', (betAmount, errors) => {
    expect(errorsFor({ betAmount })).toEqual(errors);
  });

  it('accepts a single bet amount', () => {
    expect(errorsFor({ betAmount: { min: 1_000, max: 1_000 } })).toEqual({});
  });

  it.each<[unknown, Record<string, string>]>([
    [{ min: 100, max: 500 }, { 'target.min': 'too_low' }],
    [{ min: 101, max: 1_000_001 }, { 'target.max': 'too_high' }],
    [{ min: 300, max: 200 }, { target: 'min_above_max' }],
  ])('checks the target range %p', (target, errors) => {
    expect(errorsFor({ target })).toEqual(errors);
  });

  it('accepts the widest target range', () => {
    expect(errorsFor({ target: { min: 101, max: 1_000_000 } })).toEqual({});
  });
});

describe('PRESETS', () => {
  it('makes steps climb for experiment 1, five minutes per step', () => {
    expect(PRESETS.steps?.steps).toEqual([
      { bots: 500, durationSeconds: 300 },
      { bots: 1_000, durationSeconds: 300 },
      { bots: 2_000, durationSeconds: 300 },
      { bots: 4_000, durationSeconds: 300 },
    ]);
  });

  it.each(Object.entries(PRESETS))('%s is a valid scenario', (_name, preset) => {
    expect(parseScenario(preset)).toEqual({ ok: true, value: preset });
  });

  it('includes the presets the experiments need', () => {
    expect(Object.keys(PRESETS).sort()).toEqual([
      'duplicate-cashouts',
      'ramp',
      'spike',
      'steady',
      'steps',
    ]);
  });

  it('makes duplicate-cashouts send copies of manual cashouts only', () => {
    expect(PRESETS['duplicate-cashouts']).toMatchObject({ autoCashoutShare: 0 });
    expect(PRESETS['duplicate-cashouts']?.duplicateCashouts).toBeGreaterThan(1);
  });
});
