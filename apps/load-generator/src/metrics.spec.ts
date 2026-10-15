import { GeneratorMetrics } from './metrics';

/** One series by its exact name (`_bucket`, `_count`, `_sum` for histograms) and labels. */
async function sample(
  metrics: GeneratorMetrics,
  name: string,
  labels: Record<string, string> = {},
) {
  const base = name.replace(/_(bucket|count|sum)$/, '');
  const metric = metrics.registry.getSingleMetric(base);
  const { values } = (await metric?.get()) ?? { values: [] };
  return values.find(
    value =>
      // Histogram values carry the series name; counters and gauges do not.
      ((value as { metricName?: string }).metricName ?? base) === name &&
      Object.entries(labels).every(([key, label]) => String(value.labels[key]) === label),
  )?.value;
}

describe('GeneratorMetrics', () => {
  it('records request latency in seconds by type and result', async () => {
    const metrics = new GeneratorMetrics();

    metrics.request('cashout', 'replayed', 40);

    const name = 'loadgen_request_duration_seconds_bucket';
    expect(
      await sample(metrics, `${name}`, { type: 'cashout', result: 'replayed', le: '0.05' }),
    ).toBe(1);
    expect(await sample(metrics, name, { type: 'cashout', result: 'replayed', le: '0.025' })).toBe(
      0,
    );
  });

  it('records how late ticks arrive, never below zero', async () => {
    const metrics = new GeneratorMetrics();

    metrics.tick(30);
    metrics.tick(-10);

    const name = 'loadgen_tick_jitter_seconds_bucket';
    expect(await sample(metrics, name, { le: '0' })).toBeUndefined();
    expect(await sample(metrics, name, { le: '0.001' })).toBe(1);
    expect(await sample(metrics, name, { le: '0.05' })).toBe(2);
    expect(await sample(metrics, 'loadgen_tick_jitter_seconds_sum')).toBeCloseTo(0.03, 6);
  });

  it('reads connected and target bots at scrape time', async () => {
    const metrics = new GeneratorMetrics();
    let connected = 3;
    metrics.trackBots(() => ({ target: 10, connected }));

    expect(await sample(metrics, 'loadgen_bots', { state: 'target' })).toBe(10);
    expect(await sample(metrics, 'loadgen_bots', { state: 'connected' })).toBe(3);

    connected = 7;
    expect(await sample(metrics, 'loadgen_bots', { state: 'connected' })).toBe(7);
  });

  it('records connect time and connection problems', async () => {
    const metrics = new GeneratorMetrics();

    metrics.connected(120);
    metrics.connectionFailed('login');
    metrics.disconnected(1012);

    expect(await sample(metrics, 'loadgen_connect_duration_seconds_count')).toBe(1);
    expect(await sample(metrics, 'loadgen_connection_failures_total', { stage: 'login' })).toBe(1);
    expect(await sample(metrics, 'loadgen_disconnects_total', { code: '1012' })).toBe(1);
  });

  it('includes the generator event loop lag, to tell when the generator is the bottleneck', async () => {
    const metrics = new GeneratorMetrics();

    expect(await metrics.registry.metrics()).toContain('nodejs_eventloop_lag_p99_seconds');
  });

  it('keeps each instance on its own registry', async () => {
    const first = new GeneratorMetrics();
    const second = new GeneratorMetrics();

    first.request('bet', 'accepted', 1);

    expect(await sample(second, 'loadgen_request_duration_seconds_count')).toBeUndefined();
  });
});
