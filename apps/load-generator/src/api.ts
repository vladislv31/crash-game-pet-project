import type { LiveSummary } from './live-stats';
import type { RunStatus, StartResult } from './run-controller';
import { parseScenario, PRESETS, Scenario } from './scenario';

export interface ApiRequest {
  method: string;
  path: string;
  body: string;
}

export type ApiResponse =
  { status: number; json?: unknown } | { status: number; text: string; contentType: string };

export interface ApiDeps {
  runs: {
    start(scenario: Scenario): StartResult;
    stop(): boolean;
    status(): RunStatus | null;
  };
  live: { summary(): LiveSummary };
  metrics: () => Promise<{ contentType: string; body: string }>;
}

/** The generator's control API (ADR-0008); `GET /events` is streamed separately by `streamEvents`. */
export async function handleRequest(deps: ApiDeps, request: ApiRequest): Promise<ApiResponse> {
  const route = `${request.method} ${request.path}`;
  switch (route) {
    case 'GET /presets':
      return { status: 200, json: PRESETS };
    case 'GET /run':
      return { status: 200, json: { run: deps.runs.status(), live: deps.live.summary() } };
    case 'POST /run':
      return startRun(deps, request.body);
    case 'DELETE /run':
      return deps.runs.stop() ? { status: 204 } : { status: 404, json: { error: 'no_active_run' } };
    case 'GET /metrics': {
      const { contentType, body } = await deps.metrics();
      return { status: 200, text: body, contentType };
    }
    default:
      return { status: 404, json: { error: 'not_found' } };
  }
}

function startRun(deps: ApiDeps, body: string): ApiResponse {
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return { status: 422, json: { errors: { scenario: 'invalid' } } };
  }

  const scenario = parseScenario(input);
  if (!scenario.ok) {
    return { status: 422, json: { errors: scenario.errors } };
  }

  const started = deps.runs.start(scenario.value);
  return started.ok
    ? { status: 201, json: { runId: started.runId } }
    : { status: 409, json: { error: started.reason } };
}

/** The part of an HTTP response a server-sent event stream needs. */
export interface EventStreamResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): boolean;
  on(event: 'close', listener: () => void): unknown;
}

/** Sends `snapshot()` at once and then every `intervalMs` until the client disconnects. */
export function streamEvents(
  response: EventStreamResponse,
  snapshot: () => unknown,
  intervalMs: number,
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = () => response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  send();
  const timer = setInterval(send, intervalMs);
  response.on('close', () => clearInterval(timer));
}
