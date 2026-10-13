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

@Injectable()
export class GameLoopService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('GameLoop');
  private readonly listeners: ((event: GameEvent) => void)[] = [];
  private readonly loop: GameLoop;
  private readonly pendingWrites = new Set<Promise<void>>();
  private bettingEndsAt = 0;
  private startedAt: number | null = null;

  constructor(@Inject(ROUNDS_STORE) private readonly rounds: RoundsStore) {
    this.loop = new GameLoop({
      generateCrashPoint,
      nextRoundId: randomUUID,
      onEvent: event => this.handleEvent(event),
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

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  /** Runs before TypeORM closes its connection in onApplicationShutdown, so round writes are not cut off. */
  async beforeApplicationShutdown(): Promise<void> {
    this.loop.stop();
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
      case 'betting': {
        this.bettingEndsAt = event.endsAt;
        this.startedAt = null;
        const crashPoint = this.loop.currentRound?.crashPoint;
        if (crashPoint !== undefined) {
          this.persist(
            this.rounds.create({ id: event.roundId, crashPoint, bettingEndsAt: event.endsAt }),
          );
        }
        return;
      }
      case 'started':
        this.startedAt = event.startedAt;
        this.persist(this.rounds.markStarted(event.roundId, event.startedAt));
        return;
      case 'crashed':
        this.persist(this.rounds.markCrashed(event.roundId, event.crashedAt));
        return;
      case 'tick':
        return;
    }
  }

  private persist(write: Promise<void>): void {
    const tracked = write
      .catch((error: unknown) => this.logger.error({ message: 'Failed to store round', error }))
      .finally(() => this.pendingWrites.delete(tracked));
    this.pendingWrites.add(tracked);
  }
}
