import type { LoadRunStatus } from '@crash/contracts';

import type { BotRecorder, RequestType } from './bot';
import type { Scenario } from './scenario';

const RAMP_STEP_MS = 100;

export interface Connection {
  start(): Promise<void>;
  stop(): void;
  readonly connected: boolean;
}

export interface RunLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface RunControllerDeps {
  createConnection: (username: string, recorder: BotRecorder, scenario: Scenario) => Connection;
  /** Metrics and live numbers; every bot request and tick also goes here. */
  recorder: BotRecorder;
  newRunId: () => string;
  now: () => number;
  logger: RunLogger;
}

export type RunStatus = LoadRunStatus;

export type StartResult = { ok: true; runId: string } | { ok: false; reason: 'already_running' };

interface Run {
  runId: string;
  scenario: Scenario;
  startedAt: number;
  connections: Connection[];
  totals: Record<string, number>;
  rampTimer: NodeJS.Timeout | null;
  durationTimer: NodeJS.Timeout | null;
  state: 'running' | 'stopped';
}

/** One load run at a time (ADR-0008): ramps bots up, stops them, logs a `load_run` event. */
export class RunController {
  private run: Run | null = null;

  constructor(private readonly deps: RunControllerDeps) {}

  start(scenario: Scenario): StartResult {
    if (this.run?.state === 'running') {
      return { ok: false, reason: 'already_running' };
    }

    const run: Run = {
      runId: this.deps.newRunId(),
      scenario,
      startedAt: this.deps.now(),
      connections: [],
      totals: {},
      rampTimer: null,
      durationTimer: null,
      state: 'running',
    };
    this.run = run;

    let step = 0;
    run.rampTimer = setInterval(() => {
      step += 1;
      const due = Math.min(scenario.bots, Math.floor((scenario.rampPerSecond * step) / 10));
      while (run.connections.length < due) {
        this.startBot(run);
      }
      if (run.connections.length === scenario.bots) {
        this.clearRamp(run);
      }
    }, RAMP_STEP_MS);

    if (scenario.durationSeconds !== null) {
      run.durationTimer = setTimeout(
        () => this.finish(run, 'finished'),
        scenario.durationSeconds * 1000,
      );
    }
    return { ok: true, runId: run.runId };
  }

  /** False when no run is active. */
  stop(): boolean {
    if (this.run?.state !== 'running') {
      return false;
    }
    this.finish(this.run, 'stopped');
    return true;
  }

  /** The active run, or the last one once it stopped; null before the first run. */
  status(): RunStatus | null {
    const run = this.run;
    if (!run) {
      return null;
    }
    return {
      runId: run.runId,
      scenario: run.scenario,
      state: run.state,
      startedAt: run.startedAt,
      botsStarted: run.connections.length,
      botsConnected: run.connections.filter(connection => connection.connected).length,
    };
  }

  botCounts(): { target: number; connected: number } {
    const run = this.run;
    if (run?.state !== 'running') {
      return { target: 0, connected: 0 };
    }
    return {
      target: run.scenario.bots,
      connected: run.connections.filter(connection => connection.connected).length,
    };
  }

  private startBot(run: Run): void {
    const username = `bot_${run.runId}_${run.connections.length + 1}`;
    const connection = this.deps.createConnection(username, this.recorderFor(run), run.scenario);
    run.connections.push(connection);
    void connection.start();
  }

  /** Forwards to the shared recorder and adds up the run's own totals for its log event. */
  private recorderFor(run: Run): BotRecorder {
    const shared = this.deps.recorder;
    return {
      request: (type: RequestType, result: string, latencyMs: number) => {
        const key = `${type} ${result}`;
        run.totals[key] = (run.totals[key] ?? 0) + 1;
        shared.request(type, result, latencyMs);
      },
      tick: (jitterMs: number) => shared.tick(jitterMs),
    };
  }

  private finish(run: Run, outcome: 'stopped' | 'finished'): void {
    this.clearRamp(run);
    if (run.durationTimer) {
      clearTimeout(run.durationTimer);
      run.durationTimer = null;
    }
    run.connections.forEach(connection => connection.stop());
    run.state = 'stopped';

    this.deps.logger.info({
      event: 'load_run',
      runId: run.runId,
      scenario: run.scenario.name,
      bots: run.scenario.bots,
      botsStarted: run.connections.length,
      requests: run.totals,
      outcome,
      durationMs: this.deps.now() - run.startedAt,
    });
  }

  private clearRamp(run: Run): void {
    if (run.rampTimer) {
      clearInterval(run.rampTimer);
      run.rampTimer = null;
    }
  }
}
