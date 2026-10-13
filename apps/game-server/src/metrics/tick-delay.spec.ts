import { TickDelayTracker } from './tick-delay';

describe('TickDelayTracker', () => {
  it('measures nothing before a round starts', () => {
    const tracker = new TickDelayTracker(100);

    expect(tracker.tick(1_000)).toBeNull();
  });

  it('measures the first tick from the round start', () => {
    const tracker = new TickDelayTracker(100);
    tracker.start(1_000);

    expect(tracker.tick(1_130)).toBe(30);
  });

  it('measures each tick from the previous one', () => {
    const tracker = new TickDelayTracker(100);
    tracker.start(1_000);
    tracker.tick(1_100);

    expect(tracker.tick(1_240)).toBe(40);
    expect(tracker.tick(1_340)).toBe(0);
  });

  it('reports a tick on time as zero, never negative', () => {
    const tracker = new TickDelayTracker(100);
    tracker.start(1_000);

    expect(tracker.tick(1_099.6)).toBe(0);
  });

  it('starts over with the next round', () => {
    const tracker = new TickDelayTracker(100);
    tracker.start(1_000);
    tracker.tick(1_100);
    tracker.start(20_000);

    expect(tracker.tick(20_105)).toBe(5);
  });
});
