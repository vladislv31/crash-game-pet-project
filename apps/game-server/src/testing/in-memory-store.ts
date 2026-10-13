import { randomUUID } from 'node:crypto';

import Decimal from 'decimal.js';

import { Bet } from '../betting/bet';
import {
  BetsStore,
  BetWithBalance,
  CashOutInput,
  PlaceBetInput,
  PlaceBetResult,
  UnsettledBet,
} from '../betting/bets.store';
import { RoundPlan } from '../game/game-loop';
import { RoundsStore } from '../game/rounds.store';
import { User } from '../users/user';
import { UsersStore } from '../users/users.store';

interface StoredRound {
  id: string;
  crashPoint: number;
  bettingEndsAt: number;
  startedAt: number | null;
  crashedAt: number | null;
}

/**
 * Test double for the PostgreSQL stores. Each method checks and writes without awaiting in between,
 * so it is atomic on the single JS thread, like the conditional updates it stands in for.
 */
export class InMemoryStore implements UsersStore, BetsStore, RoundsStore {
  readonly users = new Map<string, User>();
  readonly bets = new Map<string, Bet>();
  readonly rounds = new Map<string, StoredRound>();
  readonly ledger: {
    userId: string;
    amount: string;
    type: 'INITIAL' | 'BET' | 'WIN' | 'REFUND';
  }[] = [];
  private readonly idempotencyKeys = new Map<string, string>();

  /** `now` plays the database clock that decides whether a bet commits before betting ends. */
  constructor(private readonly now: () => number = Date.now) {}

  findOrCreate(username: string, initialBalance: string, token: string): Promise<User> {
    const existing = [...this.users.values()].find(user => user.username === username);
    if (existing) {
      return Promise.resolve({ ...existing });
    }

    const user = { id: randomUUID(), username, token, balance: initialBalance };
    this.users.set(user.id, user);
    this.ledger.push({ userId: user.id, amount: initialBalance, type: 'INITIAL' });

    return Promise.resolve({ ...user });
  }

  findByToken(token: string): Promise<User | null> {
    const user = [...this.users.values()].find(candidate => candidate.token === token);

    return Promise.resolve(user ? { ...user } : null);
  }

  placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
    const user = this.mustGetUser(input.userId);
    const existingId = this.idempotencyKeys.get(`${input.userId}:${input.idempotencyKey}`);
    if (existingId) {
      return Promise.resolve({
        status: 'duplicate',
        bet: this.copyBet(existingId),
        balance: user.balance,
      });
    }

    const alreadyBet = [...this.bets.values()].some(
      bet => bet.userId === input.userId && bet.roundId === input.roundId,
    );
    if (alreadyBet) {
      return Promise.resolve({ status: 'already_bet' });
    }

    if (new Decimal(user.balance).lessThan(input.amount)) {
      return Promise.resolve({ status: 'insufficient_funds' });
    }

    const round = this.rounds.get(input.roundId);
    if (!round || this.now() >= round.bettingEndsAt) {
      return Promise.resolve({ status: 'betting_closed' });
    }

    user.balance = new Decimal(user.balance).minus(input.amount).toFixed();
    const bet: Bet = {
      id: randomUUID(),
      roundId: input.roundId,
      userId: input.userId,
      username: input.username,
      amount: input.amount,
      autoCashout: input.autoCashout,
      status: 'ACTIVE',
      cashoutMultiplier: null,
      payout: null,
    };
    this.bets.set(bet.id, bet);
    this.idempotencyKeys.set(`${input.userId}:${input.idempotencyKey}`, bet.id);
    this.ledger.push({ userId: user.id, amount: `-${input.amount}`, type: 'BET' });

    return Promise.resolve({ status: 'placed', bet: { ...bet }, balance: user.balance });
  }

  cashOut(input: CashOutInput): Promise<BetWithBalance | null> {
    const bet = this.bets.get(input.betId);
    if (!bet || bet.status !== 'ACTIVE') {
      return Promise.resolve(null);
    }

    bet.status = 'CASHED_OUT';
    bet.cashoutMultiplier = input.multiplier;
    bet.payout = input.payout;
    const user = this.mustGetUser(bet.userId);
    user.balance = new Decimal(user.balance).plus(input.payout).toFixed();
    this.ledger.push({ userId: user.id, amount: input.payout, type: 'WIN' });

    return Promise.resolve({ bet: { ...bet }, balance: user.balance });
  }

  markLost(betId: string): Promise<void> {
    const bet = this.bets.get(betId);
    if (bet?.status === 'ACTIVE') {
      bet.status = 'LOST';
    }

    return Promise.resolve();
  }

  refund(betId: string): Promise<BetWithBalance | null> {
    const bet = this.bets.get(betId);
    if (!bet || bet.status !== 'ACTIVE') {
      return Promise.resolve(null);
    }

    bet.status = 'VOID';
    const user = this.mustGetUser(bet.userId);
    user.balance = new Decimal(user.balance).plus(bet.amount).toFixed();
    this.ledger.push({ userId: user.id, amount: bet.amount, type: 'REFUND' });

    return Promise.resolve({ bet: { ...bet }, balance: user.balance });
  }

  findUnsettledBets(currentRoundId: string): Promise<UnsettledBet[]> {
    const unsettled: UnsettledBet[] = [];
    for (const bet of this.bets.values()) {
      const round = this.rounds.get(bet.roundId);
      if (bet.status === 'ACTIVE' && round && round.id !== currentRoundId) {
        unsettled.push({
          bet: { ...bet },
          crashPoint: round.crashPoint,
          roundCrashed: round.crashedAt !== null,
        });
      }
    }

    return Promise.resolve(unsettled);
  }

  findActiveBets(roundId: string): Promise<Bet[]> {
    return Promise.resolve(
      [...this.bets.values()]
        .filter(bet => bet.roundId === roundId && bet.status === 'ACTIVE')
        .map(bet => ({ ...bet })),
    );
  }

  findBetByRequest(userId: string, idempotencyKey: string): Promise<BetWithBalance | null> {
    const betId = this.idempotencyKeys.get(`${userId}:${idempotencyKey}`);

    return Promise.resolve(
      betId ? { bet: this.copyBet(betId), balance: this.mustGetUser(userId).balance } : null,
    );
  }

  getBalance(userId: string): Promise<string> {
    return Promise.resolve(this.mustGetUser(userId).balance);
  }

  findUserBet(userId: string, roundId: string): Promise<Bet | null> {
    const bet = [...this.bets.values()].find(
      candidate => candidate.userId === userId && candidate.roundId === roundId,
    );

    return Promise.resolve(bet ? { ...bet } : null);
  }

  create(round: { id: string; crashPoint: number; bettingEndsAt: number }): Promise<void> {
    this.rounds.set(round.id, { ...round, startedAt: null, crashedAt: null });

    return Promise.resolve();
  }

  markStarted(id: string, startedAt: number): Promise<void> {
    const round = this.rounds.get(id);
    if (round) {
      round.startedAt = startedAt;
    }

    return Promise.resolve();
  }

  markCrashed(id: string, crashedAt: number): Promise<void> {
    const round = this.rounds.get(id);
    if (round) {
      round.crashedAt = crashedAt;
    }

    return Promise.resolve();
  }

  findLatest(): Promise<RoundPlan | null> {
    const latest = [...this.rounds.values()].sort((a, b) => b.bettingEndsAt - a.bettingEndsAt)[0];

    return Promise.resolve(
      latest
        ? { id: latest.id, crashPoint: latest.crashPoint, bettingEndsAt: latest.bettingEndsAt }
        : null,
    );
  }

  private mustGetUser(id: string): User {
    const user = this.users.get(id);
    if (!user) {
      throw new Error(`Unknown user ${id}`);
    }

    return user;
  }

  private copyBet(id: string): Bet {
    const bet = this.bets.get(id);
    if (!bet) {
      throw new Error(`Unknown bet ${id}`);
    }

    return { ...bet };
  }
}
