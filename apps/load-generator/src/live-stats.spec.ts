import { LiveStats } from './live-stats';

function setup() {
  let time = 100_000;
  const stats = new LiveStats(() => time, 10_000);
  return { stats, advance: (ms: number) => (time += ms) };
}

describe('LiveStats', () => {
  it('reports nothing before any request', () => {
    const { stats } = setup();

    expect(stats.summary()).toEqual({
      requestsPerSecond: 0,
      errorsPerSecond: 0,
      latencyMs: { p50: null, p99: null },
      results: {},
    });
  });

  it('averages request and error rates over the window', () => {
    const { stats } = setup();
    for (let i = 0; i < 30; i++) {
      stats.request('bet', 'accepted', 5);
    }
    for (let i = 0; i < 10; i++) {
      stats.request('cashout', 'cashout_closed', 5);
    }

    expect(stats.summary()).toMatchObject({ requestsPerSecond: 4, errorsPerSecond: 1 });
  });

  it('counts results by type', () => {
    const { stats } = setup();
    stats.request('bet', 'accepted', 1);
    stats.request('cashout', 'accepted', 1);
    stats.request('cashout', 'accepted', 1);
    stats.request('cashout', 'insufficient_funds', 1);

    expect(stats.summary()).toMatchObject({
      errorsPerSecond: 0.1,
      results: { 'bet accepted': 1, 'cashout accepted': 2, 'cashout insufficient_funds': 1 },
    });
  });

  it('does not count replayed answers as errors', () => {
    const { stats } = setup();
    stats.request('cashout', 'replayed', 1);
    stats.request('cashout', 'replayed', 1);

    expect(stats.summary()).toMatchObject({
      errorsPerSecond: 0,
      results: { 'cashout replayed': 2 },
    });
  });

  it('reports the median and the 99th percentile latency', () => {
    const { stats } = setup();
    for (let latency = 1; latency <= 100; latency++) {
      stats.request('bet', 'accepted', latency);
    }

    expect(stats.summary().latencyMs).toEqual({ p50: 50, p99: 99 });
  });

  it('forgets requests older than the window', () => {
    const { stats, advance } = setup();
    stats.request('bet', 'accepted', 500);
    advance(10_001);
    stats.request('bet', 'accepted', 5);

    expect(stats.summary()).toMatchObject({
      requestsPerSecond: 0.1,
      latencyMs: { p50: 5, p99: 5 },
      results: { 'bet accepted': 1 },
    });
  });

  it('keeps requests exactly at the window edge', () => {
    const { stats, advance } = setup();
    stats.request('bet', 'accepted', 5);
    advance(10_000);

    expect(stats.summary().requestsPerSecond).toBe(0.1);
  });
});
