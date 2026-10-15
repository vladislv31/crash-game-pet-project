import type { LoadScenario } from '@crash/contracts';

import { fieldErrors, formatLatency, toForm, toScenario } from './scenario-form';

const SCENARIO: LoadScenario = {
  name: 'steady',
  bots: 100,
  rampPerSecond: 20,
  durationSeconds: null,
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
      bots: '100',
      rampPerSecond: '20',
      durationSeconds: '',
      betProbability: '80',
      betAmountMin: '100',
      betAmountMax: '500',
      autoCashoutShare: '50',
      targetMin: '1.20',
      targetMax: '5.00',
      duplicateCashouts: '1',
    });
  });

  it('shows a fixed duration', () => {
    expect(toForm({ ...SCENARIO, durationSeconds: 60 }).durationSeconds).toBe('60');
  });
});

describe('toScenario', () => {
  it('turns the form back into the scenario it came from', () => {
    expect(toScenario(toForm(SCENARIO))).toEqual(SCENARIO);
  });

  it('reads an empty duration as running until stopped', () => {
    expect(toScenario({ ...toForm(SCENARIO), durationSeconds: '  ' }).durationSeconds).toBeNull();
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
    const scenario = toScenario({ ...toForm(SCENARIO), bots: 'many', durationSeconds: 'soon' });

    expect(scenario).toMatchObject({ bots: 'many', durationSeconds: 'soon' });
  });
});

describe('fieldErrors', () => {
  it('puts each error next to its form field, in words', () => {
    expect(
      fieldErrors({
        bots: 'too_high',
        'betAmount.min': 'too_low',
        'target.max': 'invalid',
        durationSeconds: 'too_low',
      }),
    ).toEqual({
      bots: 'Too high',
      betAmountMin: 'Too low',
      targetMax: 'Not a valid number',
      durationSeconds: 'Too low',
    });
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
