import { Metrics } from './metrics';

async function bucketBounds(metrics: Metrics, name: string): Promise<number[]> {
  const metric = await metrics.registry.getSingleMetric(name)?.get();
  return (metric?.values ?? []).map(value => Number(value.labels.le)).filter(Number.isFinite);
}

describe('Metrics', () => {
  describe.each(['crash_tick_delay_seconds', 'crash_tick_delivery_delay_seconds'])('%s', name => {
    it('has a bucket boundary at the 50 ms tick objective', async () => {
      expect(await bucketBounds(new Metrics(), name)).toContain(0.05);
    });

    it('resolves delays between 10 and 100 ms to at most 25 ms', async () => {
      const bounds = (await bucketBounds(new Metrics(), name)).filter(
        bound => bound >= 0.01 && bound <= 0.1,
      );

      const widestGap = Math.max(...bounds.slice(1).map((bound, i) => bound - (bounds[i] ?? 0)));

      expect(bounds[0]).toBe(0.01);
      expect(bounds.at(-1)).toBe(0.1);
      expect(widestGap).toBeLessThanOrEqual(0.025 + 1e-9);
    });
  });
});
