import { Module } from '@nestjs/common';

import { GameModule } from '../game/game.module';
import { BettingMetrics } from './betting.metrics';
import { BettingService } from './betting.service';
import { BETS_STORE } from './bets.store';
import { TypeOrmBetsStore } from './typeorm-bets.store';

@Module({
  imports: [GameModule],
  providers: [BettingService, BettingMetrics, { provide: BETS_STORE, useClass: TypeOrmBetsStore }],
  exports: [BettingService],
})
export class BettingModule {}
