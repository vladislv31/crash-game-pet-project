import { performance } from 'node:perf_hooks';

import type { AppLogger } from './logger';

/**
 * One log line per unit of work (ADR-0005): the owner creates it, handlers add fields,
 * and it is emitted once at the end, with its duration.
 */
export class WideEvent {
  private readonly fields: Record<string, unknown>;
  private failed = false;
  private error: unknown = undefined;
  private emitted = false;

  constructor(
    private readonly logger: AppLogger,
    event: string,
    fields: Record<string, unknown> = {},
    private readonly startedAt: number = performance.now(),
  ) {
    this.fields = { event, ...fields };
  }

  set(fields: Record<string, unknown>): void {
    Object.assign(this.fields, fields);
  }

  /** Logs the event at error level; the first error given is attached. */
  fail(error?: unknown): void {
    this.error ??= error;
    this.failed = true;
  }

  emit(): void {
    if (this.emitted) {
      return;
    }
    this.emitted = true;

    const line = {
      ...this.fields,
      ...(this.error === undefined ? {} : { err: this.error }),
      durationMs: Math.round((performance.now() - this.startedAt) * 100) / 100,
    };
    if (this.failed) {
      this.logger.error(line);
      return;
    }
    this.logger.info(line);
  }
}
