import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

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
}
