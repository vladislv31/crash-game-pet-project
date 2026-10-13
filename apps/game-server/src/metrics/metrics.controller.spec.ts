import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { Metrics } from './metrics';
import { MetricsModule } from './metrics.module';

describe('MetricsController', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MetricsModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves metrics in the Prometheus text format', async () => {
    const response = await request(app.getHttpServer()).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/plain;/);
    expect(response.headers['content-type']).toContain('version=0.0.4');
  });

  it('includes the event loop lag percentiles from the Node defaults', async () => {
    const response = await request(app.getHttpServer()).get('/metrics');

    expect(response.text).toContain('# TYPE nodejs_eventloop_lag_p99_seconds gauge');
    expect(response.text).toContain('# TYPE process_cpu_seconds_total counter');
  });

  it('includes observed tick delays', async () => {
    app.get(Metrics).tickDelay.observe(0.03);

    const response = await request(app.getHttpServer()).get('/metrics');

    expect(response.text).toContain('crash_tick_delay_seconds_bucket{le="0.05"} 1');
    expect(response.text).toContain('crash_tick_delay_seconds_count 1');
  });
});

describe('Metrics', () => {
  it('keeps the metrics of each instance apart', async () => {
    const first = new Metrics();
    const second = new Metrics();

    first.tickDelay.observe(0.01);

    expect(await first.registry.metrics()).toContain('crash_tick_delay_seconds_count 1');
    expect(await second.registry.metrics()).toContain('crash_tick_delay_seconds_count 0');
  });
});
