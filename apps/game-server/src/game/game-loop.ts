import { Round } from './round';

export type GameEvent =
  | { type: 'betting'; roundId: string; endsAt: number }
  | { type: 'started'; roundId: string; startedAt: number }
  | { type: 'tick'; roundId: string; multiplier: number }
  | { type: 'crashed'; roundId: string; crashPoint: number; crashedAt: number };

export interface GameLoopOptions {
  generateCrashPoint: () => number;
  nextRoundId: () => string;
  onEvent: (event: GameEvent) => void;
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

  start(): void {
    if (this.running) {
      throw new Error('Game loop is already running');
    }

    this.running = true;
    this.openBetting();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
  }

  private openBetting(): void {
    const round = new Round(this.options.nextRoundId(), this.options.generateCrashPoint());
    this.round = round;

    this.options.onEvent({
      type: 'betting',
      roundId: round.id,
      endsAt: this.now() + this.bettingMs,
    });
    this.phaseTimer = setTimeout(() => this.startRound(round), this.bettingMs);
  }

  private startRound(round: Round): void {
    const startedAt = this.now();
    round.start(startedAt);

    this.options.onEvent({ type: 'started', roundId: round.id, startedAt });
    this.tickTimer = setInterval(() => this.tick(round), this.tickMs);
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
