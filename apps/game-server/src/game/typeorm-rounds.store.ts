import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { RoundPlan } from './game-loop';
import { RoundEntity } from './round.entity';
import { RoundsStore } from './rounds.store';

@Injectable()
export class TypeOrmRoundsStore implements RoundsStore {
  constructor(private readonly dataSource: DataSource) {}

  async create(round: { id: string; crashPoint: number; bettingEndsAt: number }): Promise<void> {
    await this.dataSource.getRepository(RoundEntity).insert({
      id: round.id,
      crashPoint: round.crashPoint,
      bettingEndsAt: new Date(round.bettingEndsAt),
      startedAt: null,
      crashedAt: null,
    });
  }

  async markStarted(id: string, startedAt: number): Promise<void> {
    await this.dataSource
      .getRepository(RoundEntity)
      .update({ id }, { startedAt: new Date(startedAt) });
  }

  async markCrashed(id: string, crashedAt: number): Promise<void> {
    await this.dataSource
      .getRepository(RoundEntity)
      .update({ id }, { crashedAt: new Date(crashedAt) });
  }

  async findLatest(): Promise<RoundPlan | null> {
    const [latest] = await this.dataSource
      .getRepository(RoundEntity)
      .find({ order: { bettingEndsAt: 'DESC' }, take: 1 });

    return latest
      ? {
          id: latest.id,
          crashPoint: latest.crashPoint,
          bettingEndsAt: latest.bettingEndsAt.getTime(),
        }
      : null;
  }
}
