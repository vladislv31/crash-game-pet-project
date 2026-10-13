import {
  MAX_CRASH_POINT,
  RANDOM_RANGE,
  crashPointFromRandom,
  generateCrashPoint,
} from './crash-point';

describe('crashPointFromRandom', () => {
  it('returns 1.00x for the lowest random value', () => {
    expect(crashPointFromRandom(0n)).toBe(100);
  });

  it('returns 1.00x at the end of the 1% house zone', () => {
    expect(crashPointFromRandom(RANDOM_RANGE / 100n)).toBe(100);
  });

  it('switches from 1.00x to 1.01x at the exact boundary', () => {
    expect(crashPointFromRandom(89_180_190_640_999n)).toBe(100);
    expect(crashPointFromRandom(89_180_190_641_000n)).toBe(101);
  });

  it('returns 1.98x for the middle of the range', () => {
    expect(crashPointFromRandom(RANDOM_RANGE / 2n)).toBe(198);
  });

  it('caps at 10 000x', () => {
    expect(MAX_CRASH_POINT).toBe(1_000_000);
  });

  it('does not cap values just below 10 000x', () => {
    expect(crashPointFromRandom(4_503_153_771_007_386n)).toBe(999_999);
  });

  it('returns exactly 10 000x when the value reaches the cap', () => {
    expect(crashPointFromRandom(4_503_153_771_007_387n)).toBe(MAX_CRASH_POINT);
  });

  it('returns 10 000x for the highest random value', () => {
    expect(crashPointFromRandom(RANDOM_RANGE - 1n)).toBe(MAX_CRASH_POINT);
  });

  it('is deterministic', () => {
    const h = 1_234_567_890_123n;

    expect(crashPointFromRandom(h)).toBe(crashPointFromRandom(h));
  });

  it.each([-1n, RANDOM_RANGE])('rejects out-of-range value %s', h => {
    expect(() => crashPointFromRandom(h)).toThrow(RangeError);
  });
});

describe('generateCrashPoint', () => {
  const SAMPLES = 10_000;
  const points = Array.from({ length: SAMPLES }, () => generateCrashPoint());

  it('always returns a value between 1.00x and 10 000x', () => {
    expect(points.every(point => point >= 100 && point <= MAX_CRASH_POINT)).toBe(true);
  });

  // 1% house zone + 0.98% of rounds whose true value in [1.00, 1.01) floors to 1.00x
  it('crashes at 1.00x in about 1.98% of rounds', () => {
    const instantShare = points.filter(point => point === 100).length / SAMPLES;

    expect(instantShare).toBeGreaterThan(0.014);
    expect(instantShare).toBeLessThan(0.026);
  });

  it('reaches 2.00x in about 49.5% of rounds', () => {
    const share = points.filter(point => point >= 200).length / SAMPLES;

    expect(share).toBeGreaterThan(0.475);
    expect(share).toBeLessThan(0.515);
  });
});
