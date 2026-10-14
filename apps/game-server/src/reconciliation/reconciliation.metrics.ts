import { Injectable } from '@nestjs/common';
import { Gauge } from 'prom-client';

import { Metrics } from '../metrics/metrics';
import { MISMATCH_TYPES, MismatchType } from './reconciliation.store';

/** Reconciliation metrics from ADR-0007, on the app registry. */
@Injectable()
export class ReconciliationMetrics {
  private readonly mismatches: Gauge<'type'>;
  private readonly lastSuccess: Gauge;

  constructor(metrics: Metrics) {
    const registers = [metrics.registry];
    this.mismatches = new Gauge({
      name: 'crash_reconciliation_mismatches',
      help: 'Broken money invariants found by the last completed reconciliation, by type',
      labelNames: ['type'],
      registers,
    });
    this.lastSuccess = new Gauge({
      name: 'crash_reconciliation_last_success_timestamp_seconds',
      help: 'When the last reconciliation completed, with or without mismatches',
      registers,
    });
  }

  /** Every type is set, so a mismatch that is gone drops back to 0. */
  completed(byType: Partial<Record<MismatchType, number>>, at: number): void {
    for (const type of MISMATCH_TYPES) {
      this.mismatches.set({ type }, byType[type] ?? 0);
    }
    this.lastSuccess.set(at / 1000);
  }
}
