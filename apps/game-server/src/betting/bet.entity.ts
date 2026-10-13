import type { BetStatus } from '@crash/contracts';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { UserEntity } from '../users/user.entity';

// Bets are financial records: they are never deleted, so there is no soft-delete column.
// round_id has no foreign key; bets are only accepted into rounds already stored (ADR-0004).
@Entity('bets')
@Unique('uq_bets_user_round', ['userId', 'roundId'])
@Unique('uq_bets_user_idempotency', ['userId', 'idempotencyKey'])
@Index('ix_bets_round_status', ['roundId', 'status'])
export class BetEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'round_id', type: 'uuid' })
  roundId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 20 })
  username: string;

  @Column({ type: 'numeric', precision: 40, scale: 18 })
  amount: string;

  @Column({ name: 'auto_cashout', type: 'integer', nullable: true })
  autoCashout: number | null;

  @Column({ type: 'varchar', length: 16 })
  status: BetStatus;

  @Column({ name: 'cashout_multiplier', type: 'integer', nullable: true })
  cashoutMultiplier: number | null;

  @Column({ type: 'numeric', precision: 40, scale: 18, nullable: true })
  payout: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 64 })
  idempotencyKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true })
  settledAt: Date | null;
}
