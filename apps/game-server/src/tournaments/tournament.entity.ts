import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Tournaments are kept as history and never deleted, so there is no soft-delete column.
// A unique index skips NULLs, so it cannot cover ended_at directly; it covers this generated flag instead.
@Entity('tournaments')
@Index('ux_tournaments_active', ['active'], { unique: true, where: '"active"' })
export class TournamentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'now()' })
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({
    type: 'boolean',
    generatedType: 'STORED',
    asExpression: 'ended_at IS NULL',
    insert: false,
    update: false,
  })
  active: boolean;
}
