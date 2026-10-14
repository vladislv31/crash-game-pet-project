import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { BettingModule } from './betting/betting.module';
import { appDatabaseOptions } from './database/database-options';
import { DatabaseMetrics } from './database/database.metrics';
import { GameModule } from './game/game.module';
import { GatewayModule } from './gateway/gateway.module';
import { LoggingModule } from './logging/logging.module';
import { MetricsModule } from './metrics/metrics.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggingModule,
    MetricsModule,
    // Factory runs after ConfigModule has loaded .env into process.env.
    TypeOrmModule.forRootAsync({ useFactory: () => appDatabaseOptions() }),
    GameModule,
    UsersModule,
    BettingModule,
    GatewayModule,
    ReconciliationModule,
  ],
  controllers: [AppController],
  providers: [DatabaseMetrics],
})
export class AppModule {}
