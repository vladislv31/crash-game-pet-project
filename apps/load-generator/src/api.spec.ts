import { EventEmitter } from 'node:events';

import { ApiDeps, ApiRequest, handleRequest, streamEvents } from './api';
import { LiveSummary } from './live-stats';
import { RunStatus, StartResult } from './run-controller';
import { PRESETS } from './scenario';

const LIVE: LiveSummary = {
  requestsPerSecond: 0,
  errorsPerSecond: 0,
  latencyMs: { p50: null, p99: null },
  results: {},
};

function setup(overrides: Partial<ApiDeps> = {}) {
  const started: unknown[] = [];
  const deps: ApiDeps = {
    runs: {
      start: scenario => {
        started.push(scenario);
        return { ok: true, runId: 'abc123' };
      },
      stop: () => true,
      status: () => null,
    },
    live: { summary: () => LIVE },
    metrics: () => Promise.resolve({ contentType: 'text/plain; version=0.0.4', body: '# metrics' }),
    ...overrides,
  };
  return { deps, started, call: (request: ApiRequest) => handleRequest(deps, request) };
}

describe('handleRequest', () => {
  it('lists the presets', async () => {
    const { call } = setup();

    await expect(call({ method: 'GET', path: '/presets', body: '' })).resolves.toEqual({
      status: 200,
      json: PRESETS,
    });
  });

  it('starts a run with a valid scenario', async () => {
    const { call, started } = setup();

    const response = await call({
      method: 'POST',
      path: '/run',
      body: JSON.stringify(PRESETS.steady),
    });

    expect(response).toEqual({ status: 201, json: { runId: 'abc123' } });
    expect(started).toEqual([PRESETS.steady]);
  });

  it('rejects an invalid scenario with 422 and the field errors', async () => {
    const { call, started } = setup();

    const response = await call({
      method: 'POST',
      path: '/run',
      body: JSON.stringify({ ...PRESETS.steady, bots: 0 }),
    });

    expect(response).toEqual({ status: 422, json: { errors: { bots: 'too_low' } } });
    expect(started).toEqual([]);
  });

  it('rejects a body that is not JSON with 422', async () => {
    const { call } = setup();

    await expect(call({ method: 'POST', path: '/run', body: '{oops' })).resolves.toEqual({
      status: 422,
      json: { errors: { scenario: 'invalid' } },
    });
  });

  it('answers 409 while another run is active', async () => {
    const result: StartResult = { ok: false, reason: 'already_running' };
    const { call } = setup({
      runs: { start: () => result, stop: () => true, status: () => null },
    });

    await expect(
      call({ method: 'POST', path: '/run', body: JSON.stringify(PRESETS.steady) }),
    ).resolves.toEqual({ status: 409, json: { error: 'already_running' } });
  });

  it('stops the active run', async () => {
    const { call } = setup();

    await expect(call({ method: 'DELETE', path: '/run', body: '' })).resolves.toEqual({
      status: 204,
    });
  });

  it('answers 404 when there is no run to stop', async () => {
    const { call } = setup({
      runs: { start: () => ({ ok: true, runId: 'x' }), stop: () => false, status: () => null },
    });

    await expect(call({ method: 'DELETE', path: '/run', body: '' })).resolves.toEqual({
      status: 404,
      json: { error: 'no_active_run' },
    });
  });

  it('reports the run status with the live numbers', async () => {
    const status: RunStatus = {
      runId: 'abc123',
      scenario: PRESETS.steady!,
      state: 'running',
      startedAt: 0,
      botsStarted: 5,
      botsConnected: 4,
    };
    const { call } = setup({
      runs: { start: () => ({ ok: true, runId: 'x' }), stop: () => true, status: () => status },
    });

    await expect(call({ method: 'GET', path: '/run', body: '' })).resolves.toEqual({
      status: 200,
      json: { run: status, live: LIVE },
    });
  });

  it('serves the metrics in the Prometheus format', async () => {
    const { call } = setup();

    await expect(call({ method: 'GET', path: '/metrics', body: '' })).resolves.toEqual({
      status: 200,
      text: '# metrics',
      contentType: 'text/plain; version=0.0.4',
    });
  });

  it.each([
    ['GET', '/nowhere'],
    ['PUT', '/run'],
    ['POST', '/presets'],
  ])('answers 404 to %s %s', async (method, path) => {
    const { call } = setup();

    await expect(call({ method, path, body: '' })).resolves.toEqual({
      status: 404,
      json: { error: 'not_found' },
    });
  });
});

class FakeResponse extends EventEmitter {
  readonly chunks: string[] = [];
  headers: Record<string, string> = {};
  status = 0;

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe('streamEvents', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends the status as server-sent events at once and then every interval', () => {
    jest.useFakeTimers();
    const response = new FakeResponse();
    let calls = 0;

    streamEvents(response, () => ({ n: ++calls }), 1_000);
    jest.advanceTimersByTime(2_000);

    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ 'Content-Type': 'text/event-stream' });
    expect(response.chunks).toEqual([
      'data: {"n":1}\n\n',
      'data: {"n":2}\n\n',
      'data: {"n":3}\n\n',
    ]);
  });

  it('stops sending once the client goes away', () => {
    jest.useFakeTimers();
    const response = new FakeResponse();

    streamEvents(response, () => ({}), 1_000);
    response.emit('close');
    jest.advanceTimersByTime(5_000);

    expect(response.chunks).toHaveLength(1);
  });
});
