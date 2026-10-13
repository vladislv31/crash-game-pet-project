import { Module } from '@nestjs/common';

import { GameLoopService } from './game-loop.service';

@Module({
  providers: [GameLoopService],
})
export class GameModule {}
