import { Injectable } from '@nestjs/common';
import { Gauge, Histogram } from 'prom-client';

import { Metrics } from '../metrics/metrics';

/** `bet` and `cashout` as parsed; `invalid` when the message could not be parsed. */
export type RequestType = 'bet' | 'cashout' | 'invalid';

/** What the gateway reads from its open sockets at scrape time. */
export interface TrackedSocket {
  readonly bufferedAmount: number;
}

/** Gateway metrics from ADR-0006, on the app registry. */
@Injectable()
export class GatewayMetrics {
  /** `result`: `accepted`, `replayed` or the error code sent, as `outcome` in the ws.message log. */
  readonly requestDuration: Histogram<'type' | 'result'>;
  /** `type`: the server message type, e.g. `round:tick`. */
  readonly broadcastDuration: Histogram<'type'>;
  readonly draining: Gauge;
  private sockets: () => readonly TrackedSocket[] = () => [];

  constructor(metrics: Metrics) {
    const registers = [metrics.registry];
    this.requestDuration = new Histogram({
      name: 'crash_ws_request_duration_seconds',
      help: 'Time from receipt of a client message to the response, by message type and result',
      labelNames: ['type', 'result'],
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.broadcastDuration = new Histogram({
      name: 'crash_broadcast_duration_seconds',
      help: 'Synchronous time to serialize one broadcast and hand it to every open socket',
      labelNames: ['type'],
      buckets: [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
      registers,
    });
    this.draining = new Gauge({
      name: 'crash_draining',
      help: '1 while the server shuts down and drains, otherwise 0',
      registers,
    });

    const sockets = () => this.sockets();
    new Gauge({
      name: 'crash_ws_connections',
      help: 'Open sockets tracked by the gateway, authenticated or waiting for the token check',
      registers,
      collect() {
        this.set(sockets().length);
      },
    });
    new Gauge({
      name: 'crash_ws_buffered_bytes',
      help: 'Bytes queued for sending over all open sockets',
      registers,
      collect() {
        this.set(sockets().reduce((sum, socket) => sum + socket.bufferedAmount, 0));
      },
    });
    new Gauge({
      name: 'crash_ws_buffered_bytes_max',
      help: 'Largest number of bytes queued for sending on one open socket',
      registers,
      collect() {
        this.set(sockets().reduce((max, socket) => Math.max(max, socket.bufferedAmount), 0));
      },
    });
  }

  /** The source of the open sockets, read at scrape time. */
  trackSockets(sockets: () => readonly TrackedSocket[]): void {
    this.sockets = sockets;
  }
}

/** Seconds elapsed since a `performance.now()` reading. */
export function secondsSince(startedAt: number): number {
  return (performance.now() - startedAt) / 1000;
}
