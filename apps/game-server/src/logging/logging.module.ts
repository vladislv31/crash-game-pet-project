import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { APP_LOGGER, createLogger, stdoutDestination } from './logger';
import { RequestLogMiddleware } from './request-log.middleware';

@Global()
@Module({
  providers: [
    { provide: APP_LOGGER, useFactory: () => createLogger(process.env, stdoutDestination()) },
  ],
  exports: [APP_LOGGER],
})
export class LoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogMiddleware).forRoutes('{*path}');
  }
}
