import { LoggerService } from '@nestjs/common';

import type { AppLogger } from './logger';

/**
 * Routes Nest's own logs into the app logger, with the two levels from ADR-0005. Routine messages
 * (modules loaded, routes mapped) are dropped: the `startup` event says the app is up.
 */
export class NestLogger implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(_message: unknown, ..._params: unknown[]): void {}

  warn(message: unknown, ...params: unknown[]): void {
    this.write('info', message, contextOf(params));
  }

  /** Nest passes `(message, stack?, context?)`. */
  error(message: unknown, ...params: unknown[]): void {
    const stack = params.length > 1 && typeof params[0] === 'string' ? params[0] : undefined;
    this.write('error', message, contextOf(params), stack);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.error(message, ...params);
  }

  debug(_message: unknown, ..._params: unknown[]): void {}

  verbose(_message: unknown, ..._params: unknown[]): void {}

  private write(
    level: 'info' | 'error',
    message: unknown,
    context: string | undefined,
    stack?: string,
  ): void {
    const fields = {
      event: 'nest',
      ...(context === undefined ? {} : { context }),
      ...(stack === undefined ? {} : { stack }),
    };

    if (message instanceof Error) {
      this.logger[level]({ ...fields, err: message });
      return;
    }
    this.logger[level](fields, typeof message === 'string' ? message : JSON.stringify(message));
  }
}

/** Nest passes the context as the last parameter. */
function contextOf(params: unknown[]): string | undefined {
  const last = params.at(-1);
  return typeof last === 'string' ? last : undefined;
}
