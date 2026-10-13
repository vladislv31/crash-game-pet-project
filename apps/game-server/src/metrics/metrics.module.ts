import { Global, Module } from '@nestjs/common';

import { Metrics } from './metrics';
import { MetricsController } from './metrics.controller';

@Global()
@Module({
  providers: [Metrics],
  controllers: [MetricsController],
  exports: [Metrics],
})
export class MetricsModule {}
