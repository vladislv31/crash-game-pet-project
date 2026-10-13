import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// Round history is never deleted, so there is no soft-delete column.
@Entity('rounds')
export class RoundEntity {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'crash_point', type: 'integer' })
  crashPoint: number;

  @Column({ name: 'betting_ends_at', type: 'timestamptz' })
  bettingEndsAt: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'crashed_at', type: 'timestamptz', nullable: true })
  crashedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
