import { Inject, Injectable, OnModuleInit } from '@nestjs/common';

import { GameEvent } from '../game/game-loop';
import { GameLoopService } from '../game/game-loop.service';
import { Round, RoundStateError } from '../game/round';
import { APP_LOGGER } from '../logging/logger';
import type { AppLogger } from '../logging/logger';
import { WideEvent } from '../logging/wide-event';
import { User } from '../users/user';
import { Bet } from './bet';
import { effectiveTarget, parseAutoCashout, parseBetAmount, payoutFor } from './bet-rules';
import { BettingError } from './betting.errors';
import { BETS_STORE } from './bets.store';
import type { BetsStore, BetWithBalance } from './bets.store';

export interface GameSource {
  readonly currentRound: Round | null;
  subscribe(listener: (event: GameEvent) => void): void;
}

export type BettingEvent =
  | { type: 'bet_placed'; bet: Bet }
  | { type: 'cashed_out'; bet: Bet; balance: string }
  | { type: 'refunded'; bet: Bet; balance: string };

/** `replayed`: the request was answered with an existing result (a retry, or an auto-cashout that came first). */
export interface BetResult extends BetWithBalance {
  replayed: boolean;
}

export interface PlaceBetRequest {
  requestId: string;
  amount: unknown;
  autoCashout: unknown;
}

interface TrackedBet {
  bet: Bet;
  target: number;
}

type SettlementResult = 'won' | 'lost' | 'refunded' | 'skipped';

/** Bets, cashouts, auto-cashouts and round settlement (ADR-0004). */
@Injectable()
export class BettingService implements OnModuleInit {
  private readonly listeners: ((event: BettingEvent) => void)[] = [];
  /** Active bets with their auto-cashout target, per round. Only for auto-cashout; the store stays the source of truth. */
  private readonly tracked = new Map<string, Map<string, TrackedBet>>();
  /** Money operations still running, so shutdown can wait for them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(BETS_STORE) private readonly store: BetsStore,
    @Inject(GameLoopService) private readonly game: GameSource,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.game.subscribe(event => {
      this.handleGameEvent(event).catch((error: unknown) =>
        this.logger.error({ event: 'betting.game_event_failed', type: event.type, err: error }),
      );
    });
  }

  subscribe(listener: (event: BettingEvent) => void): void {
    this.listeners.push(listener);
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Resolves once no money operation is running, including ones that start while draining. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(this.inFlight);
    }
  }

  /** A retried `requestId` returns the original bet in any phase; the same id with a different bet is a conflict. */
  placeBet(user: User, request: PlaceBetRequest): Promise<BetResult> {
    return this.track(this.placeBetNow(user, request));
  }

  /** `receivedAt` is the server time the request arrived; it alone decides the multiplier (ADR-0002). */
  cashOut(user: User, receivedAt: number): Promise<BetResult> {
    return this.track(this.cashOutNow(user, receivedAt));
  }

  findUserBet(userId: string, roundId: string): Promise<Bet | null> {
    return this.store.findUserBet(userId, roundId);
  }

  handleGameEvent(event: GameEvent): Promise<void> {
    return this.track(this.handleGameEventNow(event));
  }

  private async placeBetNow(user: User, request: PlaceBetRequest): Promise<BetResult> {
    const amount = parseBetAmount(request.amount);
    const autoCashout = parseAutoCashout(request.autoCashout);
    if (!amount.ok || !autoCashout.ok) {
      throw new BettingError('validation_failed', {
        ...(amount.ok ? {} : { amount: amount.error }),
        ...(autoCashout.ok ? {} : { autoCashout: autoCashout.error }),
      });
    }

    // Read before any await: whether betting is open is decided when the request arrives.
    const round = this.game.currentRound;
    const bettingRound = round?.phase === 'BETTING' ? round : null;

    const previous = await this.store.findBetByRequest(user.id, request.requestId);
    if (previous) {
      return asRetryOf(previous, amount.value, autoCashout.value);
    }

    if (!bettingRound) {
      throw new BettingError('betting_closed');
    }

    const result = await this.store.placeBet({
      userId: user.id,
      username: user.username,
      roundId: bettingRound.id,
      amount: amount.value,
      autoCashout: autoCashout.value,
      idempotencyKey: request.requestId,
    });

    if (!('bet' in result)) {
      throw new BettingError(result.status);
    }

    if (result.status === 'duplicate') {
      return asRetryOf(result, amount.value, autoCashout.value);
    }

    this.trackAutoCashout(result.bet);
    this.emit({ type: 'bet_placed', bet: result.bet });

    return { bet: result.bet, balance: result.balance, replayed: false };
  }

  private async cashOutNow(user: User, receivedAt: number): Promise<BetResult> {
    const round = this.game.currentRound;
    if (!round) {
      throw new BettingError('cashout_closed');
    }

    // Read before any await: the multiplier is the one at receipt time.
    const multiplier = this.cashoutMultiplier(round, receivedAt);
    const attempt = await this.store.cashOutUserBet(user.id, round.id, bet => {
      if (multiplier === null) {
        return null;
      }
      const paid = Math.min(multiplier, effectiveTarget(bet.amount, bet.autoCashout));
      return { multiplier: paid, payout: payoutFor(bet.amount, paid) };
    });

    switch (attempt.status) {
      case 'paid':
        this.tracked.get(attempt.bet.roundId)?.delete(attempt.bet.id);
        this.emit({ type: 'cashed_out', bet: attempt.bet, balance: attempt.balance });
        return { bet: attempt.bet, balance: attempt.balance, replayed: false };
      case 'already_paid':
        // A repeated cashout, or an auto-cashout that came first: answer with that result.
        return { bet: attempt.bet, balance: attempt.balance, replayed: true };
      case 'not_paid':
        if (multiplier === null) {
          throw new BettingError('cashout_closed');
        }
        throw new BettingError(attempt.bet ? 'already_settled' : 'no_active_bet');
    }
  }

  private async handleGameEventNow(event: GameEvent): Promise<void> {
    switch (event.type) {
      case 'tick':
        await this.autoCashOut(
          event.roundId,
          { trigger: 'tick', multiplier: event.multiplier },
          target => target <= event.multiplier,
        );
        return;
      case 'crashed':
        await this.autoCashOut(
          event.roundId,
          { trigger: 'crash', multiplier: event.crashPoint },
          target => target < event.crashPoint,
        );
        return;
      case 'betting':
        await this.settleFinishedRounds(event.roundId);
        return;
      case 'started':
        await this.loadAutoCashouts(event.roundId);
        return;
    }
  }

  /** The multiplier at receipt time, or null when the round no longer accepts cashouts. */
  private cashoutMultiplier(round: Round, receivedAt: number): number | null {
    try {
      return round.cashOut(receivedAt);
    } catch (error) {
      if (error instanceof RoundStateError) {
        return null;
      }
      throw error;
    }
  }

  private async autoCashOut(
    roundId: string,
    pass: { trigger: 'tick' | 'crash'; multiplier: number },
    isReached: (target: number) => boolean,
  ): Promise<void> {
    const bets = this.tracked.get(roundId);
    if (!bets) {
      return;
    }

    const due = [...bets.values()].filter(({ target }) => isReached(target));
    if (due.length === 0) {
      return;
    }
    // Untrack before awaiting, so the next tick does not pay the same bet again.
    due.forEach(({ bet }) => bets.delete(bet.id));

    const event = new WideEvent(this.logger, 'auto_cashout', { roundId, ...pass, due: due.length });
    const results = await Promise.allSettled(
      due.map(({ bet, target }) => this.settleAsWin(bet, target)),
    );
    let paid = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        failed += 1;
        event.fail(result.reason);
      } else if (result.value) {
        paid += 1;
      }
    }
    event.set({ paid, failed });
    event.emit();
  }

  /**
   * Settles every ACTIVE bet of every round except the current one, from the store, so bets left by a
   * restart are settled too. Crashed rounds settle normally; rounds interrupted before their crash was
   * recorded are voided and refunded. A failed bet is logged and retried next time.
   */
  private async settleFinishedRounds(currentRoundId: string): Promise<void> {
    for (const roundId of this.tracked.keys()) {
      if (roundId !== currentRoundId) {
        this.tracked.delete(roundId);
      }
    }

    const event = new WideEvent(this.logger, 'settlement', { roundId: currentRoundId });
    const counts = { found: 0, won: 0, lost: 0, refunded: 0, skipped: 0, failed: 0 };
    try {
      const unsettled = await this.store.findUnsettledBets(currentRoundId);
      counts.found = unsettled.length;
      const results = await Promise.allSettled(
        unsettled.map(({ bet, crashPoint, roundCrashed }) =>
          roundCrashed ? this.settle(bet, crashPoint) : this.refund(bet),
        ),
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          counts.failed += 1;
          event.fail(result.reason);
        } else {
          counts[result.value] += 1;
        }
      }
    } catch (error) {
      event.fail(error);
    } finally {
      event.set(counts);
      event.emit();
    }
  }

  private async settle(bet: Bet, crashPoint: number): Promise<SettlementResult> {
    const target = effectiveTarget(bet.amount, bet.autoCashout);
    if (target < crashPoint) {
      return (await this.settleAsWin(bet, target)) ? 'won' : 'skipped';
    }

    await this.store.markLost(bet.id);
    return 'lost';
  }

  private async refund(bet: Bet): Promise<SettlementResult> {
    const result = await this.store.refund(bet.id);
    if (!result) {
      return 'skipped';
    }

    this.emit({ type: 'refunded', ...result });
    return 'refunded';
  }

  /** Re-reads the round's bets when it starts, so auto-cashouts survive a restart in the middle of a round. */
  private async loadAutoCashouts(roundId: string): Promise<void> {
    const bets = await this.store.findActiveBets(roundId);
    bets.forEach(bet => this.trackAutoCashout(bet));
  }

  private async settleAsWin(bet: Bet, multiplier: number): Promise<BetWithBalance | null> {
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

  private trackAutoCashout(bet: Bet): void {
    // Bets must commit before their round starts (ADR-0004), so this is only a guard: a stray bet is left to the settlement sweep.
    if (this.game.currentRound?.id !== bet.roundId) {
      return;
    }

    const bets = this.tracked.get(bet.roundId) ?? new Map<string, TrackedBet>();
    bets.set(bet.id, { bet, target: effectiveTarget(bet.amount, bet.autoCashout) });
    this.tracked.set(bet.roundId, bets);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(settled);
    void settled.finally(() => this.inFlight.delete(settled));

    return operation;
  }

  private emit(event: BettingEvent): void {
    this.listeners.forEach(listener => listener(event));
  }
}

function asRetryOf(
  previous: BetWithBalance,
  amount: string,
  autoCashout: number | null,
): BetResult {
  if (previous.bet.amount !== amount || previous.bet.autoCashout !== autoCashout) {
    throw new BettingError('request_conflict');
  }

  return { bet: previous.bet, balance: previous.balance, replayed: true };
}
