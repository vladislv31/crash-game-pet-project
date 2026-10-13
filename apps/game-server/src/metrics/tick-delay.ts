/**
 * How late each tick fired (ADR-0006). Ticks come from `setInterval`, which schedules the next run
 * from the moment the previous one ran, so the gap between ticks minus the period is the delay.
 */
export class TickDelayTracker {
  private lastAt: number | null = null;

  constructor(private readonly tickMs: number) {}

  start(at: number): void {
    this.lastAt = at;
  }

  /** Milliseconds the tick came after its planned time, or null outside a running round. */
  tick(at: number): number | null {
    if (this.lastAt === null) {
      return null;
    }

    const delay = Math.max(0, at - this.lastAt - this.tickMs);
    this.lastAt = at;
    return delay;
  }
}
