import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

const EVENT_LOOP_PRECISION_MS = 10;
/** Dense from 10 to 100 ms, where the 50 ms objective sits, so percentiles there are not just interpolated across a wide bucket. */
const TICK_DELAY_BUCKETS = [
  0.001, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.075, 0.1, 0.15,
  0.2, 0.25, 0.5, 1, 2.5,
];

/** Every metric of the app (ADR-0006), on its own registry rather than prom-client's global one. */
@Injectable()
export class Metrics {
  readonly registry = new Registry();

  readonly tickDelay = new Histogram({
    name: 'crash_tick_delay_seconds',
    help: 'How much later than planned each round tick fired',
    buckets: TICK_DELAY_BUCKETS,
    registers: [this.registry],
  });

  /** What the last player waits for: the broadcast is one synchronous loop over every socket. */
  readonly tickDeliveryDelay = new Histogram({
    name: 'crash_tick_delivery_delay_seconds',
    help: 'How much later than planned each round tick was handed out to every socket: tick delay plus broadcast',
    buckets: TICK_DELAY_BUCKETS,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      eventLoopMonitoringPrecision: EVENT_LOOP_PRECISION_MS,
    });
  }
}
