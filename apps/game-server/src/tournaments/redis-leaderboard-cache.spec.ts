import { decodeMemberUserId, encodeMember } from './redis-leaderboard-cache';

const USER = '6f1c2a4e-0b7d-4e7a-9c1d-2b3e4f5a6b7c';

describe('leaderboard member', () => {
  it('decodes the user id it encoded', () => {
    expect(decodeMemberUserId(encodeMember(1_762_780_800_000, USER))).toBe(USER);
  });

  it('has the same length for any time, so members compare by time first', () => {
    expect(encodeMember(0, USER)).toHaveLength(encodeMember(1_762_780_800_000, USER).length);
  });

  // Redis orders equal scores by member, descending for ZREVRANGE.
  it('sorts the earlier time after the later one, so ZREVRANGE ranks it higher', () => {
    const earlier = encodeMember(1_762_780_800_000, USER);
    const later = encodeMember(1_762_780_800_001, USER);

    expect(earlier > later).toBe(true);
  });

  it('sorts by user id at the same time', () => {
    const lower = encodeMember(1_762_780_800_000, 'aaaa');
    const higher = encodeMember(1_762_780_800_000, 'bbbb');

    expect(higher > lower).toBe(true);
  });

  it('keeps the order between the earliest and a far future time', () => {
    expect(encodeMember(0, USER) > encodeMember(Date.UTC(2200, 0, 1), USER)).toBe(true);
  });
});
