import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { BettingModule } from './betting/betting.module';
import { databaseOptions } from './database/database-options';
import { GameModule } from './game/game.module';
import { GatewayModule } from './gateway/gateway.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Factory runs after ConfigModule has loaded .env into process.env.
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...databaseOptions(), migrationsRun: true }),
    }),
    GameModule,
    UsersModule,
    BettingModule,
    GatewayModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
