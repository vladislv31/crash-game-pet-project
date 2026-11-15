import { Module } from '@nestjs/common';

import { LEADERBOARD_CACHE } from './leaderboard-cache';
import { redisClientProvider } from './redis';
import { RedisLeaderboardCache } from './redis-leaderboard-cache';
import { TournamentsController } from './tournaments.controller';
import {
  TOURNAMENT_INTERVALS,
  tournamentIntervals,
  TournamentsService,
} from './tournaments.service';
import { TOURNAMENTS_STORE } from './tournaments.store';
import { TypeOrmTournamentsStore } from './typeorm-tournaments.store';

@Module({
  controllers: [TournamentsController],
  providers: [
    TournamentsService,
    redisClientProvider,
    { provide: TOURNAMENTS_STORE, useClass: TypeOrmTournamentsStore },
    { provide: LEADERBOARD_CACHE, useClass: RedisLeaderboardCache },
    {
      provide: TOURNAMENT_INTERVALS,
      useFactory: () => tournamentIntervals(process.env),
    },
  ],
  exports: [TournamentsService],
})
export class TournamentsModule {}
