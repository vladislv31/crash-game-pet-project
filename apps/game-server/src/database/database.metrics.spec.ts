import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { Metrics } from '../metrics/metrics';
import { DatabaseMetrics } from './database.metrics';

interface FakePool {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

describe('DatabaseMetrics', () => {
  let metrics: Metrics;
  let driver: { master?: FakePool };

  beforeEach(async () => {
    driver = {};
    const moduleRef = await Test.createTestingModule({
      providers: [Metrics, DatabaseMetrics, { provide: DataSource, useValue: { driver } }],
    }).compile();
    metrics = moduleRef.get(Metrics);
    moduleRef.get(DatabaseMetrics);
  });

  async function poolConnections(): Promise<Record<string, number>> {
    const metric = metrics.registry.getSingleMetric('crash_db_pool_connections');
    const { values } = (await metric?.get()) ?? { values: [] };
    return Object.fromEntries(
      values.map((entry): [string, number] => [String(entry.labels.state), entry.value]),
    );
  }

  it('reports the total, idle and waiting connections of the pool', async () => {
    driver.master = { totalCount: 10, idleCount: 3, waitingCount: 2 };

    expect(await poolConnections()).toEqual({ total: 10, idle: 3, waiting: 2 });
  });

  it('reads the pool at scrape time', async () => {
    driver.master = { totalCount: 1, idleCount: 1, waitingCount: 0 };
    await poolConnections();

    driver.master.totalCount = 10;
    driver.master.idleCount = 0;
    driver.master.waitingCount = 7;

    expect(await poolConnections()).toEqual({ total: 10, idle: 0, waiting: 7 });
  });

  it('reports nothing before the pool exists', async () => {
    expect(await poolConnections()).toEqual({});
  });

  it('reports nothing once the pool is closed', async () => {
    driver.master = { totalCount: 4, idleCount: 4, waitingCount: 0 };
    await poolConnections();

    delete driver.master;

    expect(await poolConnections()).toEqual({});
  });

  it('serves the pool state in the Prometheus text format', async () => {
    driver.master = { totalCount: 4, idleCount: 1, waitingCount: 0 };

    const text = await metrics.registry.metrics();

    expect(text).toContain('# TYPE crash_db_pool_connections gauge');
    expect(text).toContain('crash_db_pool_connections{state="total"} 4');
    expect(text).toContain('crash_db_pool_connections{state="idle"} 1');
    expect(text).toContain('crash_db_pool_connections{state="waiting"} 0');
  });
});
