import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { GameEvent } from '../game/game-loop';
import { GameLoopService } from '../game/game-loop.service';
import { Round, RoundStateError } from '../game/round';
import { User } from '../users/user';
import { Bet } from './bet';
import { effectiveTarget, parseAutoCashout, parseBetAmount, payoutFor } from './bet-rules';
import { BettingError } from './betting.errors';
import { BETS_STORE } from './bets.store';
import type { BetsStore } from './bets.store';

export interface GameSource {
  readonly currentRound: Round | null;
  subscribe(listener: (event: GameEvent) => void): void;
}

export type BettingEvent =
  { type: 'bet_placed'; bet: Bet } | { type: 'cashed_out'; bet: Bet; balance: string };

export interface PlaceBetRequest {
  requestId: string;
  amount: unknown;
  autoCashout: unknown;
}

interface TrackedBet {
  bet: Bet;
  target: number;
}

/** Bets, cashouts, auto-cashouts and round settlement (ADR-0004). */
@Injectable()
export class BettingService implements OnModuleInit {
  private readonly logger = new Logger(BettingService.name);
  private readonly listeners: ((event: BettingEvent) => void)[] = [];
  /** Active bets with their auto-cashout target, per round. Only for auto-cashout; the store stays the source of truth. */
  private readonly tracked = new Map<string, Map<string, TrackedBet>>();
  /** Crashed rounds waiting to be settled when the next round opens. */
  private readonly crashedRounds = new Map<string, number>();

  constructor(
    @Inject(BETS_STORE) private readonly store: BetsStore,
    @Inject(GameLoopService) private readonly game: GameSource,
  ) {}

  onModuleInit(): void {
    this.game.subscribe(event => {
      this.handleGameEvent(event).catch((error: unknown) =>
        this.logger.error({ message: 'Failed to handle game event', event: event.type, error }),
      );
    });
  }

  subscribe(listener: (event: BettingEvent) => void): void {
    this.listeners.push(listener);
  }

  async placeBet(user: User, request: PlaceBetRequest): Promise<{ bet: Bet; balance: string }> {
    const amount = parseBetAmount(request.amount);
    const autoCashout = parseAutoCashout(request.autoCashout);
    if (!amount.ok || !autoCashout.ok) {
      throw new BettingError('validation_failed', {
        ...(amount.ok ? {} : { amount: amount.error }),
        ...(autoCashout.ok ? {} : { autoCashout: autoCashout.error }),
      });
    }

    const round = this.bettingRound();
    const result = await this.store.placeBet({
      userId: user.id,
      username: user.username,
      roundId: round.id,
      amount: amount.value,
      autoCashout: autoCashout.value,
      idempotencyKey: request.requestId,
    });

    if (!('bet' in result)) {
      throw new BettingError(result.status);
    }

    if (result.status === 'placed') {
      this.track(result.bet);
      this.emit({ type: 'bet_placed', bet: result.bet });
    }

    return { bet: result.bet, balance: result.balance };
  }

  /** `receivedAt` is the server time the request arrived; it alone decides the multiplier (ADR-0002). */
  async cashOut(user: User, receivedAt: number): Promise<{ bet: Bet; balance: string }> {
    const round = this.game.currentRound;
    if (!round) {
      throw new BettingError('cashout_closed');
    }

    const multiplier = this.cashoutMultiplier(round, receivedAt);
    const bet = await this.store.findUserBet(user.id, round.id);
    if (!bet) {
      throw new BettingError('no_active_bet');
    }

    const paidMultiplier = Math.min(multiplier, effectiveTarget(bet.amount, bet.autoCashout));
    const result = await this.settleAsWin(bet, paidMultiplier);
    if (!result) {
      throw new BettingError('already_settled');
    }

    return result;
  }

  findUserBet(userId: string, roundId: string): Promise<Bet | null> {
    return this.store.findUserBet(userId, roundId);
  }

  async handleGameEvent(event: GameEvent): Promise<void> {
    switch (event.type) {
      case 'tick':
        await this.autoCashOut(event.roundId, target => target <= event.multiplier);
        return;
      case 'crashed':
        this.crashedRounds.set(event.roundId, event.crashPoint);
        await this.autoCashOut(event.roundId, target => target < event.crashPoint);
        return;
      case 'betting':
        await this.settleCrashedRounds();
        return;
      case 'started':
        return;
    }
  }

  private bettingRound(): Round {
    const round = this.game.currentRound;
    if (!round || round.phase !== 'BETTING') {
      throw new BettingError('betting_closed');
    }

    return round;
  }

  private cashoutMultiplier(round: Round, receivedAt: number): number {
    try {
      return round.cashOut(receivedAt);
    } catch (error) {
      if (error instanceof RoundStateError) {
        throw new BettingError('cashout_closed');
      }
      throw error;
    }
  }

  private async autoCashOut(
    roundId: string,
    isReached: (target: number) => boolean,
  ): Promise<void> {
    const bets = this.tracked.get(roundId);
    if (!bets) {
      return;
    }

    const due = [...bets.values()].filter(({ target }) => isReached(target));
    // Untrack before awaiting, so the next tick does not pay the same bet again.
    due.forEach(({ bet }) => bets.delete(bet.id));

    await Promise.all(due.map(({ bet, target }) => this.settleAsWin(bet, target)));
  }

  private async settleCrashedRounds(): Promise<void> {
    const rounds = [...this.crashedRounds];
    this.crashedRounds.clear();

    await Promise.all(rounds.map(([roundId, crashPoint]) => this.settleRound(roundId, crashPoint)));
  }

  private async settleRound(roundId: string, crashPoint: number): Promise<void> {
    this.tracked.delete(roundId);
    const activeBets = await this.store.findActiveBets(roundId);

    await Promise.all(
      activeBets.map(async bet => {
        const target = effectiveTarget(bet.amount, bet.autoCashout);
        if (target < crashPoint) {
          await this.settleAsWin(bet, target);
          return;
        }
        await this.store.markLost(bet.id);
      }),
    );
  }

  private async settleAsWin(
    bet: Bet,
    multiplier: number,
  ): Promise<{ bet: Bet; balance: string } | null> {
    const result = await this.store.cashOut({
      betId: bet.id,
      multiplier,
      payout: payoutFor(bet.amount, multiplier),
    });

    if (result) {
      this.tracked.get(bet.roundId)?.delete(bet.id);
      this.emit({ type: 'cashed_out', ...result });
    }

    return result;
  }

  private track(bet: Bet): void {
    // A bet committed after its round moved on is settled when the next round opens instead.
    if (this.game.currentRound?.id !== bet.roundId) {
      return;
    }

    const bets = this.tracked.get(bet.roundId) ?? new Map<string, TrackedBet>();
    bets.set(bet.id, { bet, target: effectiveTarget(bet.amount, bet.autoCashout) });
    this.tracked.set(bet.roundId, bets);
  }

  private emit(event: BettingEvent): void {
    this.listeners.forEach(listener => listener(event));
  }
}
