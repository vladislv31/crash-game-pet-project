import { existsSync } from 'node:fs';

import { DataSource } from 'typeorm';

import { reconciliationDatabaseOptions } from './database/database-options';
import { createLogger, stdoutDestination } from './logging/logger';
import { prettyDestination } from './logging/pretty-destination';
import { Metrics } from './metrics/metrics';
import { ReconciliationMetrics } from './reconciliation/reconciliation.metrics';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { TypeOrmReconciliationStore } from './reconciliation/typeorm-reconciliation.store';

/** One reconciliation run from the command line (ADR-0007): exit code 1 when the money does not add up. */
async function reconcile(): Promise<number> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  // Readable in a terminal; JSON when piped or redirected, for jq and experiment logs.
  const destination = process.stdout.isTTY ? prettyDestination() : stdoutDestination();
  const logger = createLogger(process.env, destination);
  const dataSource = await new DataSource(reconciliationDatabaseOptions()).initialize();
  try {
    // Metrics are required by the service but go nowhere: the verdict is the log line and the exit code.
    const metrics = new ReconciliationMetrics(new Metrics());
    const service = new ReconciliationService(
      new TypeOrmReconciliationStore(dataSource),
      logger,
      metrics,
      0,
    );
    const report = await service.run();
    return report?.mismatches.length === 0 ? 0 : 1;
  } finally {
    await dataSource.destroy();
  }
}

void reconcile().then(code => {
  process.exitCode = code;
});
