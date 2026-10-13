import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

const EVENT_LOOP_PRECISION_MS = 10;

/** Every metric of the app (ADR-0006), on its own registry rather than prom-client's global one. */
@Injectable()
export class Metrics {
  readonly registry = new Registry();

  readonly tickDelay = new Histogram({
    name: 'crash_tick_delay_seconds',
    help: 'How much later than planned each round tick fired',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      eventLoopMonitoringPrecision: EVENT_LOOP_PRECISION_MS,
    });
  }
}
