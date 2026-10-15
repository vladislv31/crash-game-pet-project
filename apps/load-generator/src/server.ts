import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

import type { Logger } from 'pino';

import { ApiDeps, ApiResponse, handleRequest, streamEvents } from './api';

const MAX_BODY_BYTES = 64 * 1024;
const EVENTS_INTERVAL_MS = 1_000;

/** HTTP around `handleRequest`: one `http.request` log event per call (ADR-0005), except scrapes and streams. */
export function createApiServer(deps: ApiDeps, events: () => unknown, logger: Logger): Server {
  return createServer((request, response) => {
    void serve(deps, events, logger, request, response);
  });
}

async function serve(
  deps: ApiDeps,
  events: () => unknown,
  logger: Logger,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (method === 'GET' && path === '/events') {
    streamEvents(response, events, EVENTS_INTERVAL_MS);
    return;
  }

  const startedAt = performance.now();
  let result: ApiResponse;
  let failure: unknown;
  try {
    result = await handleRequest(deps, { method, path, body: await readBody(request) });
  } catch (error) {
    failure = error;
    result = { status: 500, json: { error: 'internal_error' } };
  }
  write(response, result);

  if (path === '/metrics') {
    return;
  }
  const event = {
    event: 'http.request',
    requestId: randomUUID(),
    method,
    route: path,
    statusCode: result.status,
    outcome: result.status >= 500 ? 'server_error' : result.status >= 400 ? 'client_error' : 'ok',
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    ...(failure === undefined ? {} : { err: failure }),
  };
  if (result.status >= 500) {
    logger.error(event);
  } else {
    logger.info(event);
  }
}

function write(response: ServerResponse, result: ApiResponse): void {
  if ('text' in result) {
    response.writeHead(result.status, { 'Content-Type': result.contentType }).end(result.text);
    return;
  }
  if (result.json === undefined) {
    response.writeHead(result.status).end();
    return;
  }
  response
    .writeHead(result.status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify(result.json));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
