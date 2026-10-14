import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';

import { fromNumeric } from '../database/postgres';
import { Mismatch, ReconciliationReport, ReconciliationStore } from './reconciliation.store';

interface BalanceRow {
  user_id: string;
  difference: string;
}

interface EntriesRow {
  bet_id: string;
  user_id: string;
  status: string;
  amount: string;
  payout: string | null;
  bet_count: number;
  bet_total: string;
  win_count: number;
  win_total: string;
  refund_count: number;
  refund_total: string;
}

interface PayoutRow {
  bet_id: string;
  user_id: string;
  payout: string | null;
  expected_payout: string | null;
  cashout_multiplier: number | null;
  crash_point: number | null;
}

interface OrphanRow {
  user_id: string;
  bet_id: string | null;
  type: string;
}

/** The money invariants of ADR-0007 as SQL; only rows that break one come back. */
@Injectable()
export class TypeOrmReconciliationStore implements ReconciliationStore {
  constructor(private readonly dataSource: DataSource) {}

  check(maxWin: string): Promise<ReconciliationReport> {
    // One snapshot for every query, so a balance and its ledger entries are read at the same moment.
    return this.dataSource.transaction('REPEATABLE READ', async manager => {
      await manager.query('SET TRANSACTION READ ONLY');

      const [counts] = await manager.query<{ users: number; bets: number }[]>(
        'SELECT (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM bets)::int AS bets',
      );
      const mismatches = [
        ...(await this.balances(manager)),
        ...(await this.betEntries(manager)),
        ...(await this.payouts(manager, maxWin)),
        ...(await this.orphanEntries(manager)),
      ];

      return { usersChecked: counts?.users ?? 0, betsChecked: counts?.bets ?? 0, mismatches };
    });
  }

  private async balances(manager: EntityManager): Promise<Mismatch[]> {
    const rows = await manager.query<BalanceRow[]>(
      `SELECT u.id AS user_id, (u.balance - COALESCE(l.total, 0))::text AS difference
       FROM users u
       LEFT JOIN (SELECT user_id, SUM(amount) AS total FROM ledger_entries GROUP BY user_id) l
         ON l.user_id = u.id
       WHERE u.balance <> COALESCE(l.total, 0)`,
    );

    return rows.map(row => ({
      type: 'balance',
      userId: row.user_id,
      betId: null,
      expected: '0',
      actual: fromNumeric(row.difference),
    }));
  }

  private async betEntries(manager: EntityManager): Promise<Mismatch[]> {
    const rows = await manager.query<EntriesRow[]>(
      `SELECT b.id AS bet_id, b.user_id, b.status, b.amount::text AS amount, b.payout::text AS payout,
              COUNT(l.id) FILTER (WHERE l.type = 'BET')::int AS bet_count,
              COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'BET'), 0)::text AS bet_total,
              COUNT(l.id) FILTER (WHERE l.type = 'WIN')::int AS win_count,
              COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'WIN'), 0)::text AS win_total,
              COUNT(l.id) FILTER (WHERE l.type = 'REFUND')::int AS refund_count,
              COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'REFUND'), 0)::text AS refund_total
       FROM bets b
       LEFT JOIN ledger_entries l ON l.bet_id = b.id AND l.user_id = b.user_id
       GROUP BY b.id
       HAVING COUNT(l.id) FILTER (WHERE l.type = 'BET') <> 1
           OR COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'BET'), 0) <> -b.amount
           OR COUNT(l.id) FILTER (WHERE l.type = 'WIN') <> (CASE WHEN b.status = 'CASHED_OUT' THEN 1 ELSE 0 END)
           OR COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'WIN'), 0)
                IS DISTINCT FROM (CASE WHEN b.status = 'CASHED_OUT' THEN b.payout ELSE 0 END)
           OR COUNT(l.id) FILTER (WHERE l.type = 'REFUND') <> (CASE WHEN b.status = 'VOID' THEN 1 ELSE 0 END)
           OR COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'REFUND'), 0)
                <> (CASE WHEN b.status = 'VOID' THEN b.amount ELSE 0 END)`,
    );

    return rows.flatMap(row => {
      const amount = fromNumeric(row.amount);
      const cashedOut = row.status === 'CASHED_OUT';
      const voided = row.status === 'VOID';
      const checks: [Mismatch['type'], number, string, number, string][] = [
        ['bet_entry', 1, `-${amount}`, row.bet_count, row.bet_total],
        [
          'win_entry',
          cashedOut ? 1 : 0,
          cashedOut ? fromNumeric(row.payout ?? '0') : '0',
          row.win_count,
          row.win_total,
        ],
        ['refund_entry', voided ? 1 : 0, voided ? amount : '0', row.refund_count, row.refund_total],
      ];

      return checks
        .map(([type, expectedCount, expectedTotal, count, total]) => ({
          type,
          expected: entries(expectedCount, expectedTotal),
          actual: entries(count, fromNumeric(total)),
        }))
        .filter(({ expected, actual }) => expected !== actual)
        .map(({ type, expected, actual }) => ({
          type,
          userId: row.user_id,
          betId: row.bet_id,
          expected,
          actual,
        }));
    });
  }

  private async payouts(manager: EntityManager, maxWin: string): Promise<Mismatch[]> {
    const rows = await manager.query<PayoutRow[]>(
      `SELECT b.id AS bet_id, b.user_id, b.payout::text AS payout,
              (b.amount * b.cashout_multiplier / 100)::text AS expected_payout,
              b.cashout_multiplier, r.crash_point
       FROM bets b
       LEFT JOIN rounds r ON r.id = b.round_id
       WHERE b.status = 'CASHED_OUT'
         AND (b.payout IS DISTINCT FROM b.amount * b.cashout_multiplier / 100
              OR b.payout > $1::numeric
              OR r.crash_point IS NULL
              OR b.cashout_multiplier >= r.crash_point)`,
      [maxWin],
    );

    return rows.flatMap(row => {
      const found: Mismatch[] = [];
      const payout = row.payout === null ? null : fromNumeric(row.payout);
      const expected = row.expected_payout === null ? null : fromNumeric(row.expected_payout);
      const bet = { userId: row.user_id, betId: row.bet_id };

      if (payout !== expected) {
        found.push({ type: 'payout', ...bet, expected, actual: payout });
      }
      if (payout !== null && new Decimal(payout).greaterThan(maxWin)) {
        found.push({
          type: 'payout_above_max_win',
          ...bet,
          expected: fromNumeric(maxWin),
          actual: payout,
        });
      }
      if (
        row.crash_point === null ||
        row.cashout_multiplier === null ||
        row.cashout_multiplier >= row.crash_point
      ) {
        found.push({
          type: 'cashout_at_or_above_crash',
          ...bet,
          expected: row.crash_point === null ? null : `below ${row.crash_point}`,
          actual: row.cashout_multiplier === null ? null : String(row.cashout_multiplier),
        });
      }
      return found;
    });
  }

  private async orphanEntries(manager: EntityManager): Promise<Mismatch[]> {
    const rows = await manager.query<OrphanRow[]>(
      `SELECT l.user_id, l.bet_id, l.type
       FROM ledger_entries l
       WHERE (l.bet_id IS NULL AND l.type <> 'INITIAL')
          OR (l.bet_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.id = l.bet_id AND b.user_id = l.user_id))`,
    );

    return rows.map(row => ({
      type: 'orphan_entry',
      userId: row.user_id,
      betId: row.bet_id,
      expected: null,
      actual: row.type,
    }));
  }
}

function entries(count: number, total: string): string {
  return `count=${count} total=${total}`;
}
