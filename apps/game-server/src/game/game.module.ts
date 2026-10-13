import { Module } from '@nestjs/common';

import { GameLoopService } from './game-loop.service';
import { ROUNDS_STORE } from './rounds.store';
import { TypeOrmRoundsStore } from './typeorm-rounds.store';

@Module({
  providers: [GameLoopService, { provide: ROUNDS_STORE, useClass: TypeOrmRoundsStore }],
  exports: [GameLoopService],
})
export class GameModule {}
