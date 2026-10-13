import { randomUUID } from 'node:crypto';

import type { RoundView } from '@crash/contracts';
import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';

import { generateCrashPoint } from './crash-point';
import { GameEvent, GameLoop } from './game-loop';
import { Round } from './round';
import { ROUNDS_STORE } from './rounds.store';
import type { RoundsStore } from './rounds.store';

const CRASH_WRITE_FIRST_RETRY_MS = 100;
const CRASH_WRITE_MAX_RETRY_MS = 5_000;

@Injectable()
export class GameLoopService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('GameLoop');
  private readonly listeners: ((event: GameEvent) => void)[] = [];
  private readonly loop: GameLoop;
  private readonly pendingWrites = new Set<Promise<void>>();
  /** Wakes up retry delays early, so shutdown does not wait for them. */
  private readonly retryWakeups = new Set<() => void>();
  private stopped = false;
  private bettingEndsAt = 0;
  private startedAt: number | null = null;

  constructor(@Inject(ROUNDS_STORE) private readonly rounds: RoundsStore) {
    this.loop = new GameLoop({
      generateCrashPoint,
      nextRoundId: randomUUID,
      onEvent: event => this.handleEvent(event),
      // The previous round's crash must be on record first (it is retried until stored):
      // settlement treats a round without it as interrupted and refunds its bets.
      beforeNextRound: async () => {
        await Promise.allSettled(this.pendingWrites);
      },
      prepareRound: (round, bettingEndsAt) => this.storeRound(round, bettingEndsAt),
      onError: error => this.logger.error({ message: 'Failed to store round', error }),
    });
  }

  get currentRound(): Round | null {
    return this.loop.currentRound;
  }

  /** Public view of the current round: never includes the crash point. */
  currentRoundView(): RoundView | null {
    const round = this.loop.currentRound;
    if (!round) {
      return null;
    }

    return {
      id: round.id,
      phase: round.phase,
      bettingEndsAt: this.bettingEndsAt,
      startedAt: this.startedAt,
    };
  }

  subscribe(listener: (event: GameEvent) => void): void {
    this.listeners.push(listener);
  }

  /** Continues the last stored round if its timeline is not over, so a restart does not abandon it. */
  async onApplicationBootstrap(): Promise<void> {
    this.loop.start(await this.rounds.findLatest());
  }

  /** Runs before TypeORM closes its connection in onApplicationShutdown, so round writes are not cut off. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Stops the loop and waits for round writes; retries in progress give up. Safe to call twice. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.loop.stop();
    this.retryWakeups.forEach(wakeUp => wakeUp());
    await Promise.allSettled(this.pendingWrites);
  }

  private handleEvent(event: GameEvent): void {
    this.logger.log(event);
    this.record(event);

    // A failing subscriber must not stop the game loop or the other subscribers.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ message: 'Game event subscriber failed', event: event.type, error });
      }
    }
  }

  private record(event: GameEvent): void {
    switch (event.type) {
      case 'betting':
        this.bettingEndsAt = event.endsAt;
        this.startedAt = null;
        return;
      case 'started':
        // A round starts exactly when its betting ends, also when it is continued after a restart.
        this.bettingEndsAt = event.startedAt;
        this.startedAt = event.startedAt;
        this.persist(this.rounds.markStarted(event.roundId, event.startedAt));
        return;
      case 'crashed':
        this.track(
          this.retryUntilStored(() => this.rounds.markCrashed(event.roundId, event.crashedAt)),
        );
        return;
      case 'tick':
        return;
    }
  }

  /** The crash point is stored before betting opens, so every bet's round can be settled later (ADR-0004). */
  private async storeRound(round: Round, bettingEndsAt: number): Promise<void> {
    const write = this.rounds.create({ id: round.id, crashPoint: round.crashPoint, bettingEndsAt });
    this.track(write);
    await write;
  }

  private persist(write: Promise<void>): void {
    this.track(
      write.catch((error: unknown) =>
        this.logger.error({ message: 'Failed to store round', error }),
      ),
    );
  }

  /** The write is idempotent, so it is safe to repeat until it lands or the app stops. */
  private async retryUntilStored(write: () => Promise<void>): Promise<void> {
    let delay = CRASH_WRITE_FIRST_RETRY_MS;
    while (!this.stopped) {
      try {
        await write();
        return;
      } catch (error) {
        this.logger.error({
          message: 'Failed to store round crash, retrying',
          retryInMs: delay,
          error,
        });
        await this.sleep(delay);
        delay = Math.min(delay * 2, CRASH_WRITE_MAX_RETRY_MS);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const wakeUp = () => {
        clearTimeout(timer);
        this.retryWakeups.delete(wakeUp);
        resolve();
      };
      const timer = setTimeout(wakeUp, ms);
      this.retryWakeups.add(wakeUp);
    });
  }

  private track(write: Promise<void>): void {
    const settled = write.catch(() => undefined).finally(() => this.pendingWrites.delete(settled));
    this.pendingWrites.add(settled);
  }
}
