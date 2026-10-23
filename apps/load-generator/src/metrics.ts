import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import type { BotRecorder, RequestType } from './bot';

export type ConnectionStage = 'login' | 'socket';

/** The player-side metrics of ADR-0008, on the generator's own registry. */
export class GeneratorMetrics implements BotRecorder {
  readonly registry = new Registry();
  private bots: () => { target: number; connected: number } = () => ({ target: 0, connected: 0 });

  private readonly requestDuration = new Histogram({
    name: 'loadgen_request_duration_seconds',
    help: 'From the moment a bot planned a request to its answer, by type and result',
    labelNames: ['type', 'result'],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly tickJitter = new Histogram({
    name: 'loadgen_tick_jitter_seconds',
    help: 'How much later than one tick period after the previous tick a tick arrived',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });

  private readonly connectDuration = new Histogram({
    name: 'loadgen_connect_duration_seconds',
    help: 'From login to the first snapshot',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly connectionFailures = new Counter({
    name: 'loadgen_connection_failures_total',
    help: 'Failed bot logins and socket connections',
    labelNames: ['stage'],
    registers: [this.registry],
  });

  private readonly disconnects = new Counter({
    name: 'loadgen_disconnects_total',
    help: 'Bot sockets closed by the server or the network, by close code',
    labelNames: ['code'],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, eventLoopMonitoringPrecision: 10 });
    const bots = () => this.bots();
    new Gauge({
      name: 'loadgen_bots',
      help: 'Bots the run aims for and bots connected now',
      labelNames: ['state'],
      registers: [this.registry],
      collect() {
        const { target, connected } = bots();
        this.set({ state: 'target' }, target);
        this.set({ state: 'connected' }, connected);
      },
    });
  }

  trackBots(source: () => { target: number; connected: number }): void {
    this.bots = source;
  }

  request(type: RequestType, result: string, latencyMs: number): void {
    this.requestDuration.observe({ type, result }, latencyMs / 1000);
  }

  tick(jitterMs: number): void {
    // An early tick only makes up for a late one; lateness is what players notice.
    this.tickJitter.observe(Math.max(0, jitterMs) / 1000);
  }

  connected(durationMs: number): void {
    this.connectDuration.observe(durationMs / 1000);
  }

  connectionFailed(stage: ConnectionStage): void {
    this.connectionFailures.inc({ stage });
  }

  disconnected(code: number): void {
    this.disconnects.inc({ code: String(code) });
  }
}
