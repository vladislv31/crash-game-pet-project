import { Injectable } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';

import { Metrics } from '../metrics/metrics';

export type AutoCashoutTrigger = 'tick' | 'crash';

/** Bets of one auto-cashout pass by result; `skipped`: already settled by someone else. */
export interface AutoCashoutCounts {
  paid: number;
  skipped: number;
  failed: number;
}

/** Bets of one settlement sweep that read the unsettled bets, as in the `settlement` log event. */
export interface SettlementCounts {
  found: number;
  won: number;
  lost: number;
  refunded: number;
  skipped: number;
  failed: number;
}

/** Betting metrics from ADR-0006, on the app registry. */
@Injectable()
export class BettingMetrics {
  private readonly autoCashouts: Counter<'trigger' | 'result'>;
  private readonly settlementBets: Counter<'result'>;
  private readonly settlementSweeps: Counter<'outcome'>;
  private readonly unsettledBets: Gauge;
  private inFlight: () => number = () => 0;

  constructor(metrics: Metrics) {
    const registers = [metrics.registry];
    this.autoCashouts = new Counter({
      name: 'crash_auto_cashouts_total',
      help: 'Bets due for auto-cashout, by trigger and result',
      labelNames: ['trigger', 'result'],
      registers,
    });
    this.settlementBets = new Counter({
      name: 'crash_settlement_bets_total',
      help: 'Bets handled by settlement sweeps, by result',
      labelNames: ['result'],
      registers,
    });
    this.settlementSweeps = new Counter({
      name: 'crash_settlement_sweeps_total',
      help: 'Settlement sweeps; failed when the unsettled bets could not be read',
      labelNames: ['outcome'],
      registers,
    });
    this.unsettledBets = new Gauge({
      name: 'crash_unsettled_bets',
      help: 'ACTIVE bets of earlier rounds the last successful settlement sweep could not settle',
      registers,
    });

    const inFlight = () => this.inFlight();
    new Gauge({
      name: 'crash_money_ops_in_flight',
      help: 'Bets, cashouts, auto-cashouts and settlements started and not finished',
      registers,
      collect() {
        this.set(inFlight());
      },
    });
  }

  /** The source of the number of money operations in flight, read at scrape time. */
  trackInFlight(count: () => number): void {
    this.inFlight = count;
  }

  autoCashedOut(trigger: AutoCashoutTrigger, counts: AutoCashoutCounts): void {
    this.autoCashouts.inc({ trigger, result: 'paid' }, counts.paid);
    this.autoCashouts.inc({ trigger, result: 'skipped' }, counts.skipped);
    this.autoCashouts.inc({ trigger, result: 'failed' }, counts.failed);
  }

  swept(counts: SettlementCounts): void {
    this.settlementSweeps.inc({ outcome: 'ok' });
    // Losing bets always wait for the next sweep, so only what it failed to settle is stuck.
    this.unsettledBets.set(counts.failed);
    this.settlementBets.inc({ result: 'won' }, counts.won);
    this.settlementBets.inc({ result: 'lost' }, counts.lost);
    this.settlementBets.inc({ result: 'refunded' }, counts.refunded);
    this.settlementBets.inc({ result: 'skipped' }, counts.skipped);
    this.settlementBets.inc({ result: 'failed' }, counts.failed);
  }

  sweepFailed(): void {
    this.settlementSweeps.inc({ outcome: 'failed' });
  }
}
