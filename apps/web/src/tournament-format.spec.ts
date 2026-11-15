import { describePlace, formatPoints } from './tournament-format';

describe('formatPoints', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [120, '1.20'],
    [350, '3.50'],
    [1_000_000, '10000.00'],
  ])('formats %i as %s', (points, expected) => {
    expect(formatPoints(points)).toBe(expected);
  });
});

describe('describePlace', () => {
  it('shows the place and the points', () => {
    expect(describePlace({ rank: 57, points: 350 })).toBe('#57 · 3.50 points');
  });

  it('shows the first place', () => {
    expect(describePlace({ rank: 1, points: 120 })).toBe('#1 · 1.20 points');
  });

  it('says so when the player has no points yet', () => {
    expect(describePlace({ rank: null, points: 0 })).toBe('No points yet');
  });

  it('says so when the place is not known yet', () => {
    expect(describePlace(null)).toBe('No points yet');
  });
});
