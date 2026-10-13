import { MAX_CRASH_POINT } from './crash-point';
import { crashTimeMs, multiplierAt } from './multiplier';

describe('multiplierAt', () => {
  it.each([
    [0, 100],
    [1_000, 111],
    [6_478, 199],
    [6_479, 200],
    [10_000, 291],
  ])('at %i ms returns %i', (elapsedMs, expected) => {
    expect(multiplierAt(elapsedMs)).toBe(expected);
  });

  it('never decreases over a full capped round', () => {
    let previous = multiplierAt(0);

    for (let t = 1; t <= crashTimeMs(MAX_CRASH_POINT); t++) {
      const current = multiplierAt(t);

      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('rejects negative elapsed time', () => {
    expect(() => multiplierAt(-1)).toThrow(RangeError);
  });
});

describe('crashTimeMs', () => {
  it.each([
    [100, 0],
    [101, 93],
    [200, 6_479],
    [MAX_CRASH_POINT, 86_078],
  ])('for crash point %i returns %i ms', (crashPoint, expected) => {
    expect(crashTimeMs(crashPoint)).toBe(expected);
  });

  it('returns the first whole millisecond at which the multiplier reaches the crash point', () => {
    const mismatches: number[] = [];

    for (let crashPoint = 101; crashPoint <= MAX_CRASH_POINT; crashPoint++) {
      const t = crashTimeMs(crashPoint);

      if (multiplierAt(t) < crashPoint || multiplierAt(t - 1) >= crashPoint) {
        mismatches.push(crashPoint);
      }
    }

    expect(mismatches).toEqual([]);
  });
});
