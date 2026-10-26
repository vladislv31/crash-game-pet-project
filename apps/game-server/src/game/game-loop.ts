import { crashTimeMs } from './multiplier';
import { Round } from './round';

export type GameEvent =
  | { type: 'betting'; roundId: string; endsAt: number }
  | { type: 'started'; roundId: string; startedAt: number }
  | { type: 'tick'; roundId: string; multiplier: number }
  | { type: 'crashed'; roundId: string; crashPoint: number; crashedAt: number };

/** Everything that defines a round's timeline: it starts at `bettingEndsAt` and crashes `crashTimeMs(crashPoint)` later. */
export interface RoundPlan {
  id: string;
  crashPoint: number;
  bettingEndsAt: number;
}

export interface GameLoopOptions {
  generateCrashPoint: () => number;
  nextRoundId: () => string;
  onEvent: (event: GameEvent) => void;
  /** Awaited before the next round is planned, so a slow wait cannot eat into its betting phase. */
  beforeNextRound?: () => Promise<void>;
  /** Runs before betting opens (e.g. persisting the round); betting waits for it and keeps its planned end. */
  prepareRound?: (round: Round, bettingEndsAt: number) => Promise<void>;
  /** A failed `prepareRound`; the loop tries a new round after the pause. */
  onError?: (error: unknown) => void;
  now?: () => number;
  bettingMs?: number;
  tickMs?: number;
  pauseMs?: number;
}

const DEFAULT_BETTING_MS = 15_000;
const DEFAULT_TICK_MS = 100;
const DEFAULT_PAUSE_MS = 5_000;

/** Drives rounds forever: BETTING (15 s) → RUNNING (ticks every 100 ms) → CRASHED → pause (5 s) → next round. */
export class GameLoop {
  private round: Round | null = null;
  private phaseTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly now: () => number;
  private readonly bettingMs: number;
  private readonly tickMs: number;
  private readonly pauseMs: number;

  constructor(private readonly options: GameLoopOptions) {
    this.now = options.now ?? Date.now;
    this.bettingMs = options.bettingMs ?? DEFAULT_BETTING_MS;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  }

  get currentRound(): Round | null {
    return this.round;
  }

  /** Continues `resume` (e.g. the last stored round after a restart) if its timeline is not over yet. */
  start(resume: RoundPlan | null = null): void {
    if (this.running) {
      throw new Error('Game loop is already running');
    }

    this.running = true;
    if (resume && this.resume(resume)) {
      return;
    }
    this.openBetting();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
  }

  private openBetting(): void {
    const { beforeNextRound } = this.options;
    if (!beforeNextRound) {
      this.planRound();
      return;
    }

    void beforeNextRound().then(
      () => {
        if (this.running) {
          this.planRound();
        }
      },
      (error: unknown) => this.retryLater(error),
    );
  }

  private planRound(): void {
    const round = new Round(this.options.nextRoundId(), this.options.generateCrashPoint());
    const bettingEndsAt = this.now() + this.bettingMs;

    if (!this.options.prepareRound) {
      this.publishBetting(round, bettingEndsAt);
      return;
    }

    void this.options.prepareRound(round, bettingEndsAt).then(
      () => {
        if (this.running) {
          this.publishBetting(round, bettingEndsAt);
        }
      },
      (error: unknown) => this.retryLater(error),
    );
  }

  private retryLater(error: unknown): void {
    this.options.onError?.(error);
    if (this.running) {
      this.phaseTimer = setTimeout(() => this.openBetting(), this.pauseMs);
    }
  }

  private resume(plan: RoundPlan): boolean {
    const now = this.now();
    const round = new Round(plan.id, plan.crashPoint);

    if (now < plan.bettingEndsAt) {
      this.publishBetting(round, plan.bettingEndsAt);
      return true;
    }

    if (now < plan.bettingEndsAt + crashTimeMs(plan.crashPoint)) {
      this.round = round;
      this.startRound(round, plan.bettingEndsAt);
      return true;
    }

    return false;
  }

  private publishBetting(round: Round, bettingEndsAt: number): void {
    this.round = round;

    this.options.onEvent({ type: 'betting', roundId: round.id, endsAt: bettingEndsAt });
    this.phaseTimer = setTimeout(
      () => this.startRound(round, bettingEndsAt),
      Math.max(0, bettingEndsAt - this.now()),
    );
  }

  /** Starts at the planned time, not when the timer fired, so the timeline matches the stored plan. */
  private startRound(round: Round, startedAt: number): void {
    round.start(startedAt);

    this.tickTimer = setInterval(() => this.tick(round), this.tickMs);
    this.options.onEvent({ type: 'started', roundId: round.id, startedAt });
    this.scheduleCrash(round);
  }

  private tick(round: Round): void {
    const multiplier = round.multiplier(this.now());

    // The crash timer owns the crash; a tick in the same millisecond must not show the crash point.
    if (multiplier < round.crashPoint) {
      this.options.onEvent({ type: 'tick', roundId: round.id, multiplier });
    }
  }

  /** Re-arms itself if the timer fires before the crash time, so the round never crashes early. */
  private scheduleCrash(round: Round): void {
    const now = this.now();
    const delay = round.crashesAt - now;

    if (delay > 0) {
      this.phaseTimer = setTimeout(() => this.scheduleCrash(round), delay);
      return;
    }

    round.crash(now);
    this.clearTimers();

    this.options.onEvent({
      type: 'crashed',
      roundId: round.id,
      crashPoint: round.crashPoint,
      crashedAt: now,
    });
    this.phaseTimer = setTimeout(() => this.openBetting(), this.pauseMs);
  }

  private clearTimers(): void {
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
