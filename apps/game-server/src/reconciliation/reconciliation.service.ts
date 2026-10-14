import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  OnApplicationBootstrap,
} from '@nestjs/common';

import { MAX_WIN } from '../betting/bet-rules';
import { APP_LOGGER } from '../logging/logger';
import type { AppLogger } from '../logging/logger';
import { WideEvent } from '../logging/wide-event';
import { ReconciliationMetrics } from './reconciliation.metrics';
import { RECONCILIATION_STORE } from './reconciliation.store';
import type {
  MismatchType,
  ReconciliationReport,
  ReconciliationStore,
} from './reconciliation.store';

export const RECONCILIATION_INTERVAL_MS = Symbol('RECONCILIATION_INTERVAL_MS');

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_LOGGED_EXAMPLES = 20;

/** `RECONCILIATION_INTERVAL_MS`: milliseconds between runs, 0 turns the schedule off. */
export function reconciliationIntervalMs(env: NodeJS.ProcessEnv): number {
  const value = env.RECONCILIATION_INTERVAL_MS;
  if (value === undefined) {
    return DEFAULT_INTERVAL_MS;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `RECONCILIATION_INTERVAL_MS must be a whole number of milliseconds, got "${value}"`,
    );
  }
  return Number(value);
}

/** Checks the money invariants on a schedule and reports them as a log event and metrics (ADR-0007). */
@Injectable()
export class ReconciliationService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(RECONCILIATION_STORE) private readonly store: ReconciliationStore,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    private readonly metrics: ReconciliationMetrics,
    @Inject(RECONCILIATION_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs === 0) {
      return;
    }
    this.timer = setInterval(() => this.runUnlessRunning(), this.intervalMs);
  }

  /** Runs before the database closes, so a run in progress is not cut off. */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.running;
  }

  /** One full check; a failure is logged and gives null, so a scheduled run never throws. */
  async run(): Promise<ReconciliationReport | null> {
    const log = new WideEvent(this.logger, 'reconciliation');
    try {
      const report = await this.store.check(MAX_WIN.toFixed());
      const byType = countByType(report.mismatches);
      const found = report.mismatches.length;
      log.set({
        usersChecked: report.usersChecked,
        betsChecked: report.betsChecked,
        mismatches: found,
        mismatchesByType: byType,
        examples: report.mismatches.slice(0, MAX_LOGGED_EXAMPLES),
        outcome: found > 0 ? 'mismatch' : 'ok',
      });
      if (found > 0) {
        log.fail();
      }
      this.metrics.completed(byType, Date.now());
      return report;
    } catch (error) {
      log.set({ outcome: 'failed' });
      log.fail(error);
      return null;
    } finally {
      log.emit();
    }
  }

  private runUnlessRunning(): void {
    if (this.running) {
      return;
    }
    this.running = this.run().finally(() => (this.running = null));
  }
}

function countByType(mismatches: { type: MismatchType }[]): Partial<Record<MismatchType, number>> {
  const counts: Partial<Record<MismatchType, number>> = {};
  for (const { type } of mismatches) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}
