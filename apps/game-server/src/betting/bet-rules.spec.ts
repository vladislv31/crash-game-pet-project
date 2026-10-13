import { MAX_CRASH_POINT } from '../game/crash-point';
import { effectiveTarget, parseAutoCashout, parseBetAmount, payoutFor } from './bet-rules';

describe('parseBetAmount', () => {
  it.each([
    ['100', '100'],
    ['1000', '1000'],
    ['250.5', '250.5'],
    ['250.50', '250.5'],
    ['999.99', '999.99'],
  ])('accepts %s', (input, expected) => {
    expect(parseBetAmount(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['99.99', 'too_low'],
    ['0', 'too_low'],
    ['1000.01', 'too_high'],
    ['5000', 'too_high'],
  ])('rejects %s as %s', (input, error) => {
    expect(parseBetAmount(input)).toEqual({ ok: false, error });
  });

  it.each([[100], [''], ['abc'], ['-100'], ['100.001'], ['1e3'], [' 100'], [null], [undefined]])(
    'rejects malformed input %p',
    input => {
      expect(parseBetAmount(input)).toEqual({ ok: false, error: 'invalid' });
    },
  );
});

describe('parseAutoCashout', () => {
  it.each([undefined, null])('treats %p as no auto-cashout', input => {
    expect(parseAutoCashout(input)).toEqual({ ok: true, value: null });
  });

  it.each([101, 250, MAX_CRASH_POINT])('accepts %i', input => {
    expect(parseAutoCashout(input)).toEqual({ ok: true, value: input });
  });

  it.each([
    [100, 'too_low'],
    [1, 'too_low'],
    [MAX_CRASH_POINT + 1, 'too_high'],
  ])('rejects %i as %s', (input, error) => {
    expect(parseAutoCashout(input)).toEqual({ ok: false, error });
  });

  it.each([['200'], [150.5], [Number.NaN], [Infinity]])('rejects malformed input %p', input => {
    expect(parseAutoCashout(input)).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('payoutFor', () => {
  it.each([
    ['100', 198, '198'],
    ['250.5', 150, '375.75'],
    ['999.99', 101, '1009.9899'],
    ['1000', MAX_CRASH_POINT, '10000000'],
  ])('%s at %i pays %s', (amount, multiplier, expected) => {
    expect(payoutFor(amount, multiplier)).toBe(expected);
  });
});

describe('effectiveTarget', () => {
  it('uses the auto-cashout target when max win is not reachable before it', () => {
    expect(effectiveTarget('100', 250)).toBe(250);
  });

  it('caps the target so the payout never exceeds the max win of 100 000', () => {
    expect(effectiveTarget('1000', null)).toBe(10_000);
    expect(effectiveTarget('1000', 50_000)).toBe(10_000);
  });

  it('rounds the max win target down so the payout stays within the limit', () => {
    expect(effectiveTarget('300', null)).toBe(33_333);
    expect(Number(payoutFor('300', 33_333))).toBeLessThanOrEqual(100_000);
  });

  it('keeps the auto-cashout target when it is below the max win target', () => {
    expect(effectiveTarget('1000', 9_999)).toBe(9_999);
  });
});
