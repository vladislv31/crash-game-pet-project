import { randomUUID } from 'node:crypto';

import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { APP_LOGGER } from './logger';
import type { AppLogger } from './logger';
import { WideEvent } from './wide-event';

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_FORMAT = /^[\w.-]{1,128}$/;
// Polled every few seconds by Prometheus and health checks: logging them is noise.
const UNLOGGED_PATHS = new Set(['/health', '/metrics']);

/** One `http.request` event per request (ADR-0005). Handlers add fields through `requestLogOf`. */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    // Only the path: the query string can carry a token.
    const route = req.originalUrl.split('?')[0] ?? '';
    if (UNLOGGED_PATHS.has(route)) {
      next();
      return;
    }

    const requestId = requestIdFrom(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const log = new WideEvent(this.logger, 'http.request', {
      requestId,
      method: req.method,
      route,
    });
    res.locals.requestLog = log;

    res.on('close', () => {
      const { statusCode } = res;
      log.set({ statusCode, outcome: outcomeOf(statusCode, res.writableFinished) });
      if (res.writableFinished && statusCode >= 500) {
        log.fail();
      }
      log.emit();
    });

    next();
  }
}

export function requestLogOf(res: Response): WideEvent | undefined {
  const { requestLog } = res.locals;
  return requestLog instanceof WideEvent ? requestLog : undefined;
}

function requestIdFrom(req: Request): string {
  const header = req.headers[REQUEST_ID_HEADER];
  return typeof header === 'string' && REQUEST_ID_FORMAT.test(header) ? header : randomUUID();
}

function outcomeOf(statusCode: number, finished: boolean): string {
  if (!finished) {
    return 'aborted';
  }
  if (statusCode >= 500) {
    return 'server_error';
  }
  return statusCode >= 400 ? 'client_error' : 'ok';
}
