import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { reconciliationDatabaseOptions } from '../database/database-options';
import { ReconciliationMetrics } from './reconciliation.metrics';
import {
  RECONCILIATION_INTERVAL_MS,
  reconciliationIntervalMs,
  ReconciliationService,
} from './reconciliation.service';
import { RECONCILIATION_STORE } from './reconciliation.store';
import { TypeOrmReconciliationStore } from './typeorm-reconciliation.store';

const RECONCILIATION_DATA_SOURCE = Symbol('RECONCILIATION_DATA_SOURCE');

@Module({
  providers: [
    {
      provide: RECONCILIATION_DATA_SOURCE,
      useFactory: () => new DataSource(reconciliationDatabaseOptions()).initialize(),
    },
    {
      provide: RECONCILIATION_STORE,
      inject: [RECONCILIATION_DATA_SOURCE],
      useFactory: (dataSource: DataSource) => new TypeOrmReconciliationStore(dataSource),
    },
    {
      provide: RECONCILIATION_INTERVAL_MS,
      useFactory: () => reconciliationIntervalMs(process.env),
    },
    ReconciliationMetrics,
    ReconciliationService,
  ],
})
export class ReconciliationModule implements OnApplicationShutdown {
  constructor(@Inject(RECONCILIATION_DATA_SOURCE) private readonly dataSource: DataSource) {}

  /** After ReconciliationService's shutdown hook has waited for a run in progress. */
  async onApplicationShutdown(): Promise<void> {
    await this.dataSource.destroy();
  }
}
