import type { LoadScenario } from '@crash/contracts';

import { fieldErrors, formatLatency, toForm, toScenario } from './scenario-form';

const SCENARIO: LoadScenario = {
  name: 'steady',
  steps: [{ bots: 100, durationSeconds: null }],
  rampPerSecond: 20,
  betProbability: 0.8,
  betAmount: { min: 100, max: 500 },
  autoCashoutShare: 0.5,
  target: { min: 120, max: 500 },
  duplicateCashouts: 1,
};

describe('toForm', () => {
  it('shows multipliers as x values and shares as percents', () => {
    expect(toForm(SCENARIO)).toEqual({
      name: 'steady',
      steps: '100',
      rampPerSecond: '20',
      betProbability: '80',
      betAmountMin: '100',
      betAmountMax: '500',
      autoCashoutShare: '50',
      targetMin: '1.20',
      targetMax: '5.00',
      duplicateCashouts: '1',
    });
  });

  it('shows steps as bots x seconds, the open-ended last one as bots only', () => {
    const steps = [
      { bots: 500, durationSeconds: 300 },
      { bots: 1_000, durationSeconds: 60 },
      { bots: 2_000, durationSeconds: null },
    ];

    expect(toForm({ ...SCENARIO, steps }).steps).toBe('500x300, 1000x60, 2000');
  });
});

describe('toScenario', () => {
  it('turns the form back into the scenario it came from', () => {
    expect(toScenario(toForm(SCENARIO))).toEqual(SCENARIO);
  });

  it('reads steps, with spaces and × allowed', () => {
    expect(toScenario({ ...toForm(SCENARIO), steps: ' 500 x 300 ,1000×60, 2000 ' }).steps).toEqual([
      { bots: 500, durationSeconds: 300 },
      { bots: 1_000, durationSeconds: 60 },
      { bots: 2_000, durationSeconds: null },
    ]);
  });

  it('turns steps it cannot read into text, for the generator to reject', () => {
    expect(toScenario({ ...toForm(SCENARIO), steps: '500x300, lots' }).steps).toEqual([
      { bots: 500, durationSeconds: 300 },
      'lots',
    ]);
  });

  it('sends no steps for an empty field', () => {
    expect(toScenario({ ...toForm(SCENARIO), steps: ' ' }).steps).toEqual([]);
  });

  it('rounds percents and multipliers the way they are shown', () => {
    const scenario = toScenario({
      ...toForm(SCENARIO),
      betProbability: '33.3',
      targetMin: '1.234',
    });

    expect(scenario).toMatchObject({ betProbability: 0.333, target: { min: 123, max: 500 } });
  });

  it('passes text that is not a number on as it is, for the generator to reject', () => {
    const scenario = toScenario({ ...toForm(SCENARIO), rampPerSecond: 'fast', betAmountMin: '' });

    expect(scenario).toMatchObject({ rampPerSecond: 'fast', betAmount: { min: '' } });
  });
});

describe('fieldErrors', () => {
  it('puts each error next to its form field, in words', () => {
    expect(
      fieldErrors({
        rampPerSecond: 'too_high',
        'betAmount.min': 'too_low',
        'target.max': 'invalid',
      }),
    ).toEqual({
      rampPerSecond: 'Too high',
      betAmountMin: 'Too low',
      targetMax: 'Not a valid number',
    });
  });

  it('names the step an error belongs to', () => {
    expect(fieldErrors({ 'steps.1.bots': 'too_high' })).toEqual({ steps: 'Step 2 bots: too high' });
    expect(fieldErrors({ 'steps.0.durationSeconds': 'required' })).toEqual({
      steps: 'Step 1 seconds: needed, only the last step can run until stopped',
    });
    expect(fieldErrors({ 'steps.2': 'invalid' })).toEqual({ steps: 'Step 3: not bots x seconds' });
    expect(fieldErrors({ steps: 'too_low' })).toEqual({ steps: 'Add at least one step' });
  });

  it('shows a reversed range at its upper end', () => {
    expect(fieldErrors({ betAmount: 'min_above_max', target: 'min_above_max' })).toEqual({
      betAmountMax: 'Must not be below the minimum',
      targetMax: 'Must not be below the minimum',
    });
  });

  it('keeps an error it cannot place under the whole form', () => {
    expect(fieldErrors({ scenario: 'invalid' })).toEqual({ form: 'Not a valid number' });
  });
});

describe('formatLatency', () => {
  it.each<[number | null, string]>([
    [null, '–'],
    [4.567, '4.6 ms'],
    [1234, '1234 ms'],
  ])('shows %p as %p', (latency, text) => {
    expect(formatLatency(latency)).toBe(text);
  });
});
