import type { BotRecorder } from './bot';
import { Connection, RunController } from './run-controller';
import { PRESETS, Scenario } from './scenario';

class FakeConnection implements Connection {
  started = false;
  stopped = false;
  connected = false;

  constructor(
    readonly username: string,
    readonly recorder: BotRecorder,
  ) {}

  start(): Promise<void> {
    this.started = true;
    this.connected = true;
    return Promise.resolve();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
  }
}

function setup() {
  jest.useFakeTimers({ now: 0 });
  const connections: FakeConnection[] = [];
  const logged: Record<string, unknown>[] = [];
  const shared: BotRecorder = { request: () => undefined, tick: () => undefined };
  const controller = new RunController({
    createConnection: (username, recorder) => {
      const connection = new FakeConnection(username, recorder);
      connections.push(connection);
      return connection;
    },
    recorder: shared,
    newRunId: () => 'abc123',
    now: () => Date.now(),
    logger: { info: event => logged.push(event), error: event => logged.push(event) },
  });
  return { controller, connections, logged };
}

function scenario(changes: Partial<Scenario> = {}): Scenario {
  return { ...PRESETS.steady!, bots: 10, rampPerSecond: 10, ...changes };
}

describe('RunController', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts bots at the ramp rate', () => {
    const { controller, connections } = setup();

    controller.start(scenario({ bots: 10, rampPerSecond: 10 }));
    jest.advanceTimersByTime(500);
    expect(connections).toHaveLength(5);

    jest.advanceTimersByTime(500);
    expect(connections).toHaveLength(10);
  });

  it('stops starting bots once the scenario count is reached', () => {
    const { controller, connections } = setup();

    controller.start(scenario({ bots: 3, rampPerSecond: 100 }));
    jest.advanceTimersByTime(10_000);

    expect(connections).toHaveLength(3);
  });

  it('names bots uniquely within the run', () => {
    const { controller, connections } = setup();

    controller.start(scenario({ bots: 3, rampPerSecond: 100 }));
    jest.advanceTimersByTime(1_000);

    expect(connections.map(connection => connection.username)).toEqual([
      'bot_abc123_1',
      'bot_abc123_2',
      'bot_abc123_3',
    ]);
    expect(connections.every(connection => connection.started)).toBe(true);
  });

  it('keeps bot names within the 20-character username limit', () => {
    const { controller, connections } = setup();

    controller.start(scenario({ bots: 20_000, rampPerSecond: 1_000 }));
    jest.advanceTimersByTime(20_000);

    expect(connections.at(-1)?.username).toBe('bot_abc123_20000');
    expect(connections.at(-1)!.username.length).toBeLessThanOrEqual(20);
  });

  it('refuses a second run while one is active', () => {
    const { controller } = setup();
    controller.start(scenario());

    expect(controller.start(scenario())).toEqual({ ok: false, reason: 'already_running' });
  });

  it('allows a new run after the previous one stopped', () => {
    const { controller } = setup();
    controller.start(scenario());
    controller.stop();

    expect(controller.start(scenario())).toEqual({ ok: true, runId: 'abc123' });
  });

  it('stops every bot and starts no more after a stop', () => {
    const { controller, connections } = setup();
    controller.start(scenario({ bots: 10, rampPerSecond: 10 }));
    jest.advanceTimersByTime(300);

    expect(controller.stop()).toBe(true);
    jest.advanceTimersByTime(10_000);

    expect(connections).toHaveLength(3);
    expect(connections.every(connection => connection.stopped)).toBe(true);
  });

  it('has nothing to stop when no run is active', () => {
    const { controller } = setup();

    expect(controller.stop()).toBe(false);
  });

  it('stops on its own after the scenario duration', () => {
    const { controller, connections } = setup();
    controller.start(scenario({ durationSeconds: 2 }));

    jest.advanceTimersByTime(1_999);
    expect(controller.status()?.state).toBe('running');

    jest.advanceTimersByTime(1);
    expect(controller.status()?.state).toBe('stopped');
    expect(connections.every(connection => connection.stopped)).toBe(true);
  });

  it('reports the run and how many bots are started and connected', () => {
    const { controller, connections } = setup();
    controller.start(scenario({ bots: 10, rampPerSecond: 10 }));
    jest.advanceTimersByTime(400);
    connections[0]!.connected = false;

    expect(controller.status()).toEqual({
      runId: 'abc123',
      scenario: scenario({ bots: 10, rampPerSecond: 10 }),
      state: 'running',
      startedAt: 0,
      botsStarted: 4,
      botsConnected: 3,
    });
    expect(controller.botCounts()).toEqual({ target: 10, connected: 3 });
  });

  it('reports no bots between runs', () => {
    const { controller } = setup();

    expect(controller.status()).toBeNull();
    expect(controller.botCounts()).toEqual({ target: 0, connected: 0 });
  });

  it('keeps the last run in the status after it stopped', () => {
    const { controller } = setup();
    controller.start(scenario());
    controller.stop();

    expect(controller.status()).toMatchObject({ runId: 'abc123', state: 'stopped' });
    expect(controller.botCounts()).toEqual({ target: 0, connected: 0 });
  });

  it('gives bots a recorder that also counts the run totals', () => {
    const { controller, connections, logged } = setup();
    controller.start(scenario({ bots: 2, rampPerSecond: 100 }));
    jest.advanceTimersByTime(1_000);

    connections[0]!.recorder.request('bet', 'accepted', 5);
    connections[1]!.recorder.request('bet', 'accepted', 7);
    connections[1]!.recorder.request('cashout', 'replayed', 9);
    jest.advanceTimersByTime(2_000);
    controller.stop();

    expect(logged).toEqual([
      {
        event: 'load_run',
        runId: 'abc123',
        scenario: 'steady',
        bots: 2,
        botsStarted: 2,
        requests: { 'bet accepted': 2, 'cashout replayed': 1 },
        outcome: 'stopped',
        durationMs: 3_000,
      },
    ]);
  });

  it('passes every recorded request on to the shared recorder', () => {
    const forwarded: string[] = [];
    jest.useFakeTimers({ now: 0 });
    const connections: FakeConnection[] = [];
    const controller = new RunController({
      createConnection: (username, recorder) => {
        const connection = new FakeConnection(username, recorder);
        connections.push(connection);
        return connection;
      },
      recorder: {
        request: (type, result) => forwarded.push(`${type} ${result}`),
        tick: jitter => forwarded.push(`tick ${jitter}`),
      },
      newRunId: () => 'abc123',
      now: () => Date.now(),
      logger: { info: () => undefined, error: () => undefined },
    });
    controller.start(scenario({ bots: 1, rampPerSecond: 100 }));
    jest.advanceTimersByTime(100);

    connections[0]!.recorder.request('bet', 'accepted', 5);
    connections[0]!.recorder.tick(12);

    expect(forwarded).toEqual(['bet accepted', 'tick 12']);
  });

  it('logs a run that ended by its duration as finished', () => {
    const { controller, logged } = setup();
    controller.start(scenario({ durationSeconds: 1 }));

    jest.advanceTimersByTime(1_000);

    expect(logged).toEqual([expect.objectContaining({ outcome: 'finished', durationMs: 1_000 })]);
  });
});
