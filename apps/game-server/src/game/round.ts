import { crashTimeMs, multiplierAt } from './multiplier';

export type RoundPhase = 'BETTING' | 'RUNNING' | 'CRASHED';

export class RoundStateError extends Error {
  override readonly name = 'RoundStateError';
}

/**
 * One round's lifecycle: BETTING → RUNNING → CRASHED. Time is always passed in
 * (ms since epoch), so the round never reads the clock itself.
 */
export class Round {
  private currentPhase: RoundPhase = 'BETTING';
  private startedAt: number | null = null;

  constructor(
    readonly id: string,
    readonly crashPoint: number,
  ) {}

  get phase(): RoundPhase {
    return this.currentPhase;
  }

  get crashesAt(): number {
    return this.runningSince() + crashTimeMs(this.crashPoint);
  }

  assertBettingOpen(): void {
    this.assertPhase('BETTING');
  }

  start(now: number): void {
    this.assertPhase('BETTING');
    this.startedAt = now;
    this.currentPhase = 'RUNNING';
  }

  multiplier(now: number): number {
    return multiplierAt(now - this.runningSince());
  }

  /** Returns the cashout multiplier, or throws if the round has already reached its crash point. */
  cashOut(now: number): number {
    this.assertPhase('RUNNING');
    const multiplier = this.multiplier(now);

    if (multiplier >= this.crashPoint) {
      throw new RoundStateError(`Round ${this.id} has reached its crash point`);
    }

    return multiplier;
  }

  crash(now: number): void {
    this.assertPhase('RUNNING');

    if (this.multiplier(now) < this.crashPoint) {
      throw new RoundStateError(`Round ${this.id} has not reached its crash point yet`);
    }

    this.currentPhase = 'CRASHED';
  }

  private runningSince(): number {
    if (this.startedAt === null) {
      throw new RoundStateError(`Round ${this.id} has not started`);
    }

    return this.startedAt;
  }

  private assertPhase(expected: RoundPhase): void {
    if (this.currentPhase !== expected) {
      throw new RoundStateError(`Round ${this.id} is ${this.currentPhase}, expected ${expected}`);
    }
  }
}
