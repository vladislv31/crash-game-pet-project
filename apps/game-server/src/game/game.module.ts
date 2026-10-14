import { Module } from '@nestjs/common';

import { GameLoopService } from './game-loop.service';
import { RoundMetrics } from './round.metrics';
import { ROUNDS_STORE } from './rounds.store';
import { TypeOrmRoundsStore } from './typeorm-rounds.store';

@Module({
  providers: [
    GameLoopService,
    RoundMetrics,
    { provide: ROUNDS_STORE, useClass: TypeOrmRoundsStore },
  ],
  exports: [GameLoopService],
})
export class GameModule {}
