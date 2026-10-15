import type { ClientMessage, ServerMessage } from '@crash/contracts';

import type { Range, Scenario } from './scenario';

// Same curve as the server (ADR-0002), so a bot knows when its target is reached without ticks.
const GROWTH_PER_MS = 0.000107;
const TICK_PERIOD_MS = 100;

/** First whole millisecond after the round started at which the multiplier reaches `target`. */
export function msToReach(target: number): number {
  return Math.ceil(Math.log(target / 100) / GROWTH_PER_MS);
}

export type RequestType = 'bet' | 'cashout';

export interface BotRecorder {
  /** `latencyMs` runs from the moment the request was planned, not from when it was sent (ADR-0008). */
  request(type: RequestType, result: string, latencyMs: number): void;
  /** Gap between two consecutive ticks minus the tick period. */
  tick(jitterMs: number): void;
}

export interface BotDeps {
  scenario: Scenario;
  random: () => number;
  now: () => number;
  /** Runs `action` at time `at` of `now()`'s clock; returns a function that cancels it. */
  schedule: (at: number, action: () => void) => () => void;
  send: (message: ClientMessage) => void;
  newRequestId: () => string;
  recorder: BotRecorder;
}

interface PendingRequest {
  type: RequestType;
  plannedAt: number;
  answersLeft: number;
}

interface RoundBet {
  roundId: string;
  /** Set for a manual cash-out; null when the server cashes out automatically. */
  manualTarget: number | null;
  accepted: boolean;
}

/**
 * One virtual player: decides when to bet and cash out from the scenario and the round events it
 * receives. Pure apart from its injected clock, timers, randomness and transport.
 */
export class Bot {
  private readonly pending = new Map<string, PendingRequest>();
  private bet: RoundBet | null = null;
  private cancelPlanned: (() => void) | null = null;
  private lastTickAt: number | null = null;

  constructor(private readonly deps: BotDeps) {}

  handle(message: ServerMessage): void {
    switch (message.type) {
      case 'snapshot':
        if (message.round?.phase === 'BETTING') {
          this.joinBetting(message.round.id, message.round.bettingEndsAt - message.serverTime);
        }
        return;
      case 'round:betting':
        this.joinBetting(message.roundId, message.endsAt - this.deps.now());
        return;
      case 'round:started':
        this.planCashout(message.roundId);
        return;
      case 'round:tick':
        this.recordTick();
        return;
      case 'round:crashed':
        this.lastTickAt = null;
        this.cancel();
        return;
      case 'bet:accepted':
      case 'cashout:accepted':
      case 'error':
        this.answered(message);
        return;
      default:
        return;
    }
  }

  /** Requests still waiting for an answer will never get one. */
  disconnected(): void {
    this.cancel();
    this.lastTickAt = null;
    for (const [requestId, request] of this.pending) {
      for (let i = 0; i < request.answersLeft; i++) {
        this.record(request, 'no_response');
      }
      this.pending.delete(requestId);
    }
  }

  private joinBetting(roundId: string, remainingMs: number): void {
    this.cancel();
    this.bet = null;
    const { scenario, random, now } = this.deps;
    if (remainingMs <= 0 || random() >= scenario.betProbability) {
      return;
    }

    const plannedAt = now() + random() * (remainingMs / 2);
    this.plan(plannedAt, () => this.placeBet(roundId, plannedAt));
  }

  private placeBet(roundId: string, plannedAt: number): void {
    const { scenario, random } = this.deps;
    const amount = draw(scenario.betAmount, random());
    const automatic = random() < scenario.autoCashoutShare;
    const target = draw(scenario.target, random());
    this.bet = { roundId, manualTarget: automatic ? null : target, accepted: false };

    const requestId = this.request('bet', plannedAt, 1);
    this.deps.send({
      type: 'bet',
      requestId,
      amount: String(amount),
      ...(automatic ? { autoCashout: target } : {}),
    });
  }

  private planCashout(roundId: string): void {
    const bet = this.bet;
    if (!bet || bet.roundId !== roundId || !bet.accepted || bet.manualTarget === null) {
      return;
    }

    const plannedAt = this.deps.now() + msToReach(bet.manualTarget);
    this.plan(plannedAt, () => {
      const copies = this.deps.scenario.duplicateCashouts;
      const requestId = this.request('cashout', plannedAt, copies);
      for (let i = 0; i < copies; i++) {
        this.deps.send({ type: 'cashout', requestId });
      }
    });
  }

  private request(type: RequestType, plannedAt: number, answers: number): string {
    const requestId = this.deps.newRequestId();
    this.pending.set(requestId, { type, plannedAt, answersLeft: answers });
    return requestId;
  }

  private answered(
    message: Extract<ServerMessage, { type: 'bet:accepted' | 'cashout:accepted' | 'error' }>,
  ): void {
    const request = message.requestId ? this.pending.get(message.requestId) : undefined;
    if (!request || !message.requestId) {
      return;
    }

    this.record(request, message.type === 'error' ? message.code : 'accepted');
    request.answersLeft -= 1;
    if (request.answersLeft === 0) {
      this.pending.delete(message.requestId);
    }
    if (message.type === 'bet:accepted' && this.bet) {
      this.bet.accepted = true;
    }
  }

  private record(request: PendingRequest, result: string): void {
    this.deps.recorder.request(request.type, result, this.deps.now() - request.plannedAt);
  }

  private recordTick(): void {
    const now = this.deps.now();
    if (this.lastTickAt !== null) {
      this.deps.recorder.tick(now - this.lastTickAt - TICK_PERIOD_MS);
    }
    this.lastTickAt = now;
  }

  private plan(at: number, action: () => void): void {
    this.cancelPlanned = this.deps.schedule(at, () => {
      this.cancelPlanned = null;
      action();
    });
  }

  private cancel(): void {
    this.cancelPlanned?.();
    this.cancelPlanned = null;
  }
}

/** A whole number in the range, both ends included. */
function draw(range: Range, random: number): number {
  return range.min + Math.floor(random * (range.max - range.min + 1));
}
