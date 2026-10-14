import { Injectable } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { DataSource } from 'typeorm';

import { Metrics } from '../metrics/metrics';

/** The counters of a `pg` Pool that the gauge reports. */
interface PoolCounts {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

@Injectable()
export class DatabaseMetrics {
  constructor(metrics: Metrics, dataSource: DataSource) {
    new Gauge({
      name: 'crash_db_pool_connections',
      help: 'Connections of the PostgreSQL pool at scrape time; waiting: requests queued for one',
      labelNames: ['state'],
      registers: [metrics.registry],
      collect() {
        this.reset();
        const pool = postgresPool(dataSource);
        if (!pool) {
          return;
        }
        this.set({ state: 'total' }, pool.totalCount);
        this.set({ state: 'idle' }, pool.idleCount);
        this.set({ state: 'waiting' }, pool.waitingCount);
      },
    });
  }
}

/** The pg Pool behind the connection, or undefined until the DataSource is initialized. */
function postgresPool(dataSource: DataSource): PoolCounts | undefined {
  // TypeORM types `driver` as the generic Driver; for postgres it is a PostgresDriver whose `master` is the pg Pool.
  return (dataSource.driver as { master?: PoolCounts } | undefined)?.master;
}
