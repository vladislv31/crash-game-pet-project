import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';

import { Metrics } from '../metrics/metrics';

export type RoundWriteOperation = 'create' | 'mark_started' | 'mark_crashed';

@Injectable()
export class RoundMetrics {
  private readonly writeFailures: Counter<'operation'>;

  constructor(metrics: Metrics) {
    this.writeFailures = new Counter({
      name: 'crash_round_write_failures_total',
      help: 'Failed round writes, every failed attempt of the retried crash write included',
      labelNames: ['operation'],
      registers: [metrics.registry],
    });
  }

  writeFailed(operation: RoundWriteOperation): void {
    this.writeFailures.inc({ operation });
  }
}
