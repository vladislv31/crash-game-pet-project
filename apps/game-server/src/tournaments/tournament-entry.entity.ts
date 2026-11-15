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

import { BetEntity } from '../betting/bet.entity';
import { UserEntity } from '../users/user.entity';
import { TournamentEntity } from './tournament.entity';

// Append-only points history (ADR-0009): never updated or deleted, so there is no soft-delete column.
@Entity('tournament_entries')
@Unique('uq_tournament_entries_bet', ['betId'])
@Index('ix_tournament_entries_tournament_user', ['tournamentId', 'userId'])
export class TournamentEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tournament_id', type: 'uuid' })
  tournamentId: string;

  @ManyToOne(() => TournamentEntity)
  @JoinColumn({ name: 'tournament_id' })
  tournament: TournamentEntity;

  @Column({ name: 'bet_id', type: 'uuid' })
  betId: string;

  @ManyToOne(() => BetEntity)
  @JoinColumn({ name: 'bet_id' })
  bet: BetEntity;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  /** Hundredths: the cashout multiplier (230 = 2.30 points). */
  @Column({ type: 'integer' })
  points: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
