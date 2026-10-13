import { Module } from '@nestjs/common';

import { BettingModule } from '../betting/betting.module';
import { GameModule } from '../game/game.module';
import { UsersModule } from '../users/users.module';
import { GameGateway } from './game.gateway';

@Module({
  imports: [GameModule, BettingModule, UsersModule],
  providers: [GameGateway],
})
export class GatewayModule {}
