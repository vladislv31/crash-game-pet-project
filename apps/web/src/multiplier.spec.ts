import { formatMultiplier, multiplierAt } from './multiplier';

describe('multiplierAt', () => {
  // Same values as the server curve (ADR-0002), so the local animation matches the ticks.
  it.each([
    [0, 100],
    [1_000, 111],
    [6_479, 200],
    [10_000, 291],
  ])('at %i ms returns %i', (elapsedMs, expected) => {
    expect(multiplierAt(elapsedMs)).toBe(expected);
  });

  it('stays at 1.00x before the start', () => {
    expect(multiplierAt(-500)).toBe(100);
  });
});

describe('formatMultiplier', () => {
  it.each([
    [100, '1.00x'],
    [198, '1.98x'],
    [1_000_000, '10000.00x'],
  ])('formats %i as %s', (multiplier, expected) => {
    expect(formatMultiplier(multiplier)).toBe(expected);
  });
});
