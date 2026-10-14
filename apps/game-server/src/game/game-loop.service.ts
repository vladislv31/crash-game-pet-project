import { randomUUID } from 'node:crypto';

import type { RoundView } from '@crash/contracts';
import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  OnApplicationBootstrap,
} from '@nestjs/common';

import { APP_LOGGER } from '../logging/logger';
import type { AppLogger } from '../logging/logger';
import { WideEvent } from '../logging/wide-event';
import { Metrics } from '../metrics/metrics';
import { TickDelayTracker } from '../metrics/tick-delay';
import { generateCrashPoint } from './crash-point';
import { GameEvent, GameLoop } from './game-loop';
import { Round } from './round';
import { RoundMetrics } from './round.metrics';
import type { RoundWriteOperation } from './round.metrics';
import { ROUNDS_STORE } from './rounds.store';
import type { RoundsStore } from './rounds.store';

const TICK_MS = 100;
const CRASH_WRITE_FIRST_RETRY_MS = 100;
const CRASH_WRITE_MAX_RETRY_MS = 5_000;

@Injectable()
export class GameLoopService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly listeners: ((event: GameEvent) => void)[] = [];
  private readonly loop: GameLoop;
  private readonly pendingWrites = new Set<Promise<void>>();
  /** Wakes up retry delays early, so shutdown does not wait for them. */
  private readonly retryWakeups = new Set<() => void>();
  /** Rounds created by this process; any other round the loop runs was continued after a restart. */
  private readonly preparedRounds = new Set<string>();
  /** The round log (ADR-0005), emitted once the crash is stored or the app stops. */
  private readonly roundEvents = new Map<string, WideEvent>();
  private readonly tickDelay = new TickDelayTracker(TICK_MS);
  private stopped = false;
  private bettingEndsAt = 0;
  private startedAt: number | null = null;

  constructor(
    @Inject(ROUNDS_STORE) private readonly rounds: RoundsStore,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly roundMetrics: RoundMetrics,
  ) {
    this.loop = new GameLoop({
      tickMs: TICK_MS,
      generateCrashPoint,
      nextRoundId: randomUUID,
      onEvent: event => this.handleEvent(event),
      // The previous round's crash must be on record first (it is retried until stored):
      // settlement treats a round without it as interrupted and refunds its bets.
      beforeNextRound: async () => {
        await Promise.allSettled(this.pendingWrites);
      },
      prepareRound: (round, bettingEndsAt) => this.storeRound(round, bettingEndsAt),
      onError: error => this.logger.error({ event: 'round.prepare_failed', err: error }),
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

    for (const event of this.roundEvents.values()) {
      event.set({ outcome: 'interrupted' });
      event.emit();
    }
    this.roundEvents.clear();
  }

  private handleEvent(event: GameEvent): void {
    this.record(event);

    // A failing subscriber must not stop the game loop or the other subscribers.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ event: 'game.subscriber_failed', type: event.type, err: error });
      }
    }
  }

  private record(event: GameEvent): void {
    switch (event.type) {
      case 'betting':
        this.bettingEndsAt = event.endsAt;
        this.startedAt = null;
        this.openRoundEvent(event.roundId, event.endsAt);
        return;
      case 'started':
        // Ticks are measured from now, when the tick timer is armed, not from the planned start.
        this.tickDelay.start(performance.now());
        // A round starts exactly when its betting ends, also when it is continued after a restart.
        this.bettingEndsAt = event.startedAt;
        this.startedAt = event.startedAt;
        (
          this.roundEvents.get(event.roundId) ?? this.openRoundEvent(event.roundId, event.startedAt)
        ).set({ startedAt: iso(event.startedAt) });
        this.persist(event.roundId, 'mark_started', () =>
          this.rounds.markStarted(event.roundId, event.startedAt),
        );
        return;
      case 'crashed':
        this.roundEvents
          .get(event.roundId)
          ?.set({ crashPoint: event.crashPoint, crashedAt: iso(event.crashedAt) });
        this.track(this.storeCrash(event.roundId, event.crashedAt));
        return;
      case 'tick': {
        // Called synchronously from the tick timer, so this reading is when the tick fired.
        const delayMs = this.tickDelay.tick(performance.now());
        if (delayMs !== null) {
          this.metrics.tickDelay.observe(delayMs / 1000);
        }
        return;
      }
    }
  }

  /** The crash point is stored before betting opens, so every bet's round can be settled later (ADR-0004). */
  private async storeRound(round: Round, bettingEndsAt: number): Promise<void> {
    const write = this.rounds
      .create({ id: round.id, crashPoint: round.crashPoint, bettingEndsAt })
      .catch((error: unknown) => {
        this.roundMetrics.writeFailed('create');
        throw error;
      });
    this.track(write);
    await write;
    this.preparedRounds.add(round.id);
  }

  private openRoundEvent(roundId: string, bettingEndsAt: number): WideEvent {
    const event = new WideEvent(this.logger, 'round', {
      roundId,
      bettingEndsAt: iso(bettingEndsAt),
      continuedAfterRestart: !this.preparedRounds.delete(roundId),
    });
    this.roundEvents.set(roundId, event);
    return event;
  }

  private persist(
    roundId: string,
    operation: RoundWriteOperation,
    write: () => Promise<void>,
  ): void {
    this.track(
      write().catch((error: unknown) => {
        this.roundMetrics.writeFailed(operation);
        this.logger.error({ event: 'round.store_failed', roundId, operation, err: error });
      }),
    );
  }

  private async storeCrash(roundId: string, crashedAt: number): Promise<void> {
    const { stored, retries } = await this.retryUntilStored(roundId, () =>
      this.rounds.markCrashed(roundId, crashedAt),
    );

    const event = this.roundEvents.get(roundId);
    this.roundEvents.delete(roundId);
    if (!event) {
      return;
    }
    event.set({ crashWriteRetries: retries, outcome: stored ? 'crashed' : 'crash_not_stored' });
    if (!stored) {
      event.fail();
    }
    event.emit();
  }

  /** The write is idempotent, so it is safe to repeat until it lands or the app stops. */
  private async retryUntilStored(
    roundId: string,
    write: () => Promise<void>,
  ): Promise<{ stored: boolean; retries: number }> {
    let delay = CRASH_WRITE_FIRST_RETRY_MS;
    let retries = 0;
    while (!this.stopped) {
      try {
        await write();
        return { stored: true, retries };
      } catch (error) {
        this.roundMetrics.writeFailed('mark_crashed');
        this.logger.error({
          event: 'round.crash_write_failed',
          roundId,
          retryInMs: delay,
          err: error,
        });
        retries += 1;
        await this.sleep(delay);
        delay = Math.min(delay * 2, CRASH_WRITE_MAX_RETRY_MS);
      }
    }
    return { stored: false, retries };
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

function iso(time: number): string {
  return new Date(time).toISOString();
}
