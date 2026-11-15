import { Module } from '@nestjs/common';

import { BettingModule } from '../betting/betting.module';
import { GameModule } from '../game/game.module';
import { TournamentsModule } from '../tournaments/tournaments.module';
import { UsersModule } from '../users/users.module';
import { GameGateway } from './game.gateway';
import { GatewayMetrics } from './gateway.metrics';

@Module({
  imports: [GameModule, BettingModule, UsersModule, TournamentsModule],
  providers: [GameGateway, GatewayMetrics],
})
export class GatewayModule {}
