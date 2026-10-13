import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { fromNumeric, updateReturning, violatedUniqueConstraint } from '../database/postgres';
import { UserEntity } from '../users/user.entity';
import { Bet } from './bet';
import { BetEntity } from './bet.entity';
import { BetsStore, CashOutInput, PlaceBetInput, PlaceBetResult } from './bets.store';
import { LedgerEntryEntity } from './ledger-entry.entity';

/** Money moves through conditional updates and unique constraints, so it stays correct across instances (ADR-0004). */
@Injectable()
export class TypeOrmBetsStore implements BetsStore {
  constructor(private readonly dataSource: DataSource) {}

  async placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
    try {
      return await this.dataSource.transaction(manager => this.placeBetIn(manager, input));
    } catch (error) {
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

  cashOut(input: CashOutInput): Promise<{ bet: Bet; balance: string } | null> {
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

  async findActiveBets(roundId: string): Promise<Bet[]> {
    const bets = await this.dataSource
      .getRepository(BetEntity)
      .findBy({ roundId, status: 'ACTIVE' });

    return bets.map(toBet);
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
