import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { UserEntity } from '../users/user.entity';

export type LedgerEntryType = 'INITIAL' | 'BET' | 'WIN';

// Append-only money history (ADR-0004): never updated or deleted, so there is no soft-delete column.
@Entity('ledger_entries')
@Index('ix_ledger_entries_user', ['userId'])
export class LedgerEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ name: 'bet_id', type: 'uuid', nullable: true })
  betId: string | null;

  @Column({ type: 'varchar', length: 16 })
  type: LedgerEntryType;

  @Column({ type: 'numeric', precision: 40, scale: 18 })
  amount: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
