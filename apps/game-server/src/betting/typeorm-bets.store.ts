import type { BetStatus } from '@crash/contracts';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { fromNumeric, updateReturning, violatedUniqueConstraint } from '../database/postgres';
import { UserEntity } from '../users/user.entity';
import { Bet } from './bet';
import { BetEntity } from './bet.entity';
import {
  BetsStore,
  BetWithBalance,
  CashOutInput,
  PlaceBetInput,
  PlaceBetResult,
  UnsettledBet,
} from './bets.store';
import { LedgerEntryEntity } from './ledger-entry.entity';

/** Money moves through conditional updates and unique constraints, so it stays correct across instances (ADR-0004). */
@Injectable()
export class TypeOrmBetsStore implements BetsStore {
  constructor(private readonly dataSource: DataSource) {}

  async placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
    try {
      return await this.dataSource.transaction(manager => this.placeBetIn(manager, input));
    } catch (error) {
      if (error instanceof BettingClosedError) {
        return { status: 'betting_closed' };
      }

      // Lost a race with a concurrent request; the transaction rolled back, so nothing was debited.
      switch (violatedUniqueConstraint(error)) {
        case 'uq_bets_user_idempotency':
          return this.dataSource.transaction(async manager => {
            const existing = await this.findDuplicate(manager, input);
            if (!existing) {
              throw error;
            }
            return existing;
          });
        case 'uq_bets_user_round':
          return { status: 'already_bet' };
        default:
          throw error;
      }
    }
  }

  cashOut(input: CashOutInput): Promise<BetWithBalance | null> {
    return this.dataSource.transaction(async manager => {
      const settled = await updateReturning<{ user_id: string }>(
        manager,
        `UPDATE bets
         SET status = 'CASHED_OUT', cashout_multiplier = $2, payout = $3, settled_at = now()
         WHERE id = $1 AND status = 'ACTIVE'
         RETURNING user_id`,
        [input.betId, input.multiplier, input.payout],
      );
      const [bet] = settled;
      if (!bet) {
        return null;
      }

      const [user] = await updateReturning<{ balance: string }>(
        manager,
        'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
        [input.payout, bet.user_id],
      );
      await manager.insert(LedgerEntryEntity, {
        userId: bet.user_id,
        betId: input.betId,
        type: 'WIN',
        amount: input.payout,
      });

      const updated = await manager.findOneByOrFail(BetEntity, { id: input.betId });

      return { bet: toBet(updated), balance: fromNumeric(mustExist(user).balance) };
    });
  }

  async markLost(betId: string): Promise<void> {
    await this.dataSource.query(
      "UPDATE bets SET status = 'LOST', settled_at = now() WHERE id = $1 AND status = 'ACTIVE'",
      [betId],
    );
  }

  refund(betId: string): Promise<BetWithBalance | null> {
    return this.dataSource.transaction(async manager => {
      const [voided] = await updateReturning<{ user_id: string; amount: string }>(
        manager,
        `UPDATE bets SET status = 'VOID', settled_at = now()
         WHERE id = $1 AND status = 'ACTIVE'
         RETURNING user_id, amount::text AS amount`,
        [betId],
      );
      if (!voided) {
        return null;
      }

      const [user] = await updateReturning<{ balance: string }>(
        manager,
        'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
        [voided.amount, voided.user_id],
      );
      await manager.insert(LedgerEntryEntity, {
        userId: voided.user_id,
        betId,
        type: 'REFUND',
        amount: voided.amount,
      });

      const bet = await manager.findOneByOrFail(BetEntity, { id: betId });

      return { bet: toBet(bet), balance: fromNumeric(mustExist(user).balance) };
    });
  }

  async findUnsettledBets(currentRoundId: string): Promise<UnsettledBet[]> {
    const rows = await this.dataSource.query<UnsettledBetRow[]>(
      `SELECT b.id, b.round_id, b.user_id, b.username, b.amount::text AS amount, b.auto_cashout,
              b.status, b.cashout_multiplier, b.payout::text AS payout, r.crash_point,
              r.crashed_at IS NOT NULL AS round_crashed
       FROM bets b
       JOIN rounds r ON r.id = b.round_id
       WHERE b.status = 'ACTIVE' AND b.round_id <> $1`,
      [currentRoundId],
    );

    return rows.map(row => ({
      bet: {
        id: row.id,
        roundId: row.round_id,
        userId: row.user_id,
        username: row.username,
        amount: fromNumeric(row.amount),
        autoCashout: row.auto_cashout,
        status: row.status,
        cashoutMultiplier: row.cashout_multiplier,
        payout: row.payout === null ? null : fromNumeric(row.payout),
      },
      crashPoint: row.crash_point,
      roundCrashed: row.round_crashed,
    }));
  }

  async findActiveBets(roundId: string): Promise<Bet[]> {
    const bets = await this.dataSource
      .getRepository(BetEntity)
      .findBy({ roundId, status: 'ACTIVE' });

    return bets.map(toBet);
  }

  async findBetByRequest(userId: string, idempotencyKey: string): Promise<BetWithBalance | null> {
    const bet = await this.dataSource
      .getRepository(BetEntity)
      .findOneBy({ userId, idempotencyKey });

    return bet ? { bet: toBet(bet), balance: await this.getBalance(userId) } : null;
  }

  async getBalance(userId: string): Promise<string> {
    const user = await this.dataSource.getRepository(UserEntity).findOneByOrFail({ id: userId });

    return fromNumeric(user.balance);
  }

  async findUserBet(userId: string, roundId: string): Promise<Bet | null> {
    const bet = await this.dataSource.getRepository(BetEntity).findOneBy({ userId, roundId });

    return bet ? toBet(bet) : null;
  }

  private async placeBetIn(manager: EntityManager, input: PlaceBetInput): Promise<PlaceBetResult> {
    const duplicate = await this.findDuplicate(manager, input);
    if (duplicate) {
      return duplicate;
    }

    const alreadyBet = await manager.existsBy(BetEntity, {
      userId: input.userId,
      roundId: input.roundId,
    });
    if (alreadyBet) {
      return { status: 'already_bet' };
    }

    const [debited] = await updateReturning<{ balance: string }>(
      manager,
      'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
      [input.amount, input.userId],
    );
    if (!debited) {
      return { status: 'insufficient_funds' };
    }

    const bet = await manager.save(
      manager.create(BetEntity, {
        roundId: input.roundId,
        userId: input.userId,
        username: input.username,
        amount: input.amount,
        autoCashout: input.autoCashout,
        status: 'ACTIVE',
        cashoutMultiplier: null,
        payout: null,
        idempotencyKey: input.idempotencyKey,
        settledAt: null,
      }),
    );
    await manager.insert(LedgerEntryEntity, {
      userId: input.userId,
      betId: bet.id,
      type: 'BET',
      amount: `-${input.amount}`,
    });

    // Last statement before commit, so the check is as close to the commit time as possible (ADR-0004).
    const [round] = await manager.query<{ open: boolean }[]>(
      'SELECT clock_timestamp() < betting_ends_at AS open FROM rounds WHERE id = $1',
      [input.roundId],
    );
    if (!round?.open) {
      throw new BettingClosedError();
    }

    return { status: 'placed', bet: toBet(bet), balance: fromNumeric(debited.balance) };
  }

  private async findDuplicate(
    manager: EntityManager,
    input: PlaceBetInput,
  ): Promise<PlaceBetResult | null> {
    const existing = await manager.findOneBy(BetEntity, {
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!existing) {
      return null;
    }

    const user = await manager.findOneByOrFail(UserEntity, { id: input.userId });

    return { status: 'duplicate', bet: toBet(existing), balance: fromNumeric(user.balance) };
  }
}

/** Thrown inside the bet transaction to roll it back, debit included, when betting has already ended. */
class BettingClosedError extends Error {}

interface UnsettledBetRow {
  id: string;
  round_id: string;
  user_id: string;
  username: string;
  amount: string;
  auto_cashout: number | null;
  status: BetStatus;
  cashout_multiplier: number | null;
  payout: string | null;
  crash_point: number;
  round_crashed: boolean;
}

function toBet(entity: BetEntity): Bet {
  return {
    id: entity.id,
    roundId: entity.roundId,
    userId: entity.userId,
    username: entity.username,
    amount: fromNumeric(entity.amount),
    autoCashout: entity.autoCashout,
    status: entity.status,
    cashoutMultiplier: entity.cashoutMultiplier,
    payout: entity.payout === null ? null : fromNumeric(entity.payout),
  };
}

function mustExist<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Expected a row to be returned');
  }

  return value;
}
