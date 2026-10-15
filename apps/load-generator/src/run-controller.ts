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

/** Marks runs and steps on the dashboards; must never throw or slow a run down (ADR-0008). */
export interface RunAnnotator {
  runStarted(run: { runId: string; scenario: Scenario }): void;
  stepStarted(step: { runId: string; index: number; count: number; bots: number }): void;
  runEnded(runId: string): void;
}

export interface RunControllerDeps {
  createConnection: (username: string, recorder: BotRecorder, scenario: Scenario) => Connection;
  /** Metrics and live numbers; every bot request and tick also goes here. */
  recorder: BotRecorder;
  newRunId: () => string;
  now: () => number;
  logger: RunLogger;
  annotator: RunAnnotator;
}

export type RunStatus = LoadRunStatus;

export type StartResult = { ok: true; runId: string } | { ok: false; reason: 'already_running' };

interface Run {
  runId: string;
  scenario: Scenario;
  startedAt: number;
  stepIndex: number;
  /** Bots still part of the run, oldest first; a step down stops the newest. */
  active: Connection[];
  botsStarted: number;
  totals: Record<string, number>;
  rampTimer: NodeJS.Timeout | null;
  stepTimer: NodeJS.Timeout | null;
  state: 'running' | 'stopped';
}

/** One load run at a time (ADR-0008): moves bots through the steps, stops them, logs a `load_run` event. */
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
      stepIndex: 0,
      active: [],
      botsStarted: 0,
      totals: {},
      rampTimer: null,
      stepTimer: null,
      state: 'running',
    };
    this.run = run;
    this.deps.annotator.runStarted({ runId: run.runId, scenario });

    // Bots join or leave at the ramp rate; the budget carries fractions between 100 ms steps.
    let budget = 0;
    run.rampTimer = setInterval(() => {
      const target = this.target(run);
      if (run.active.length === target) {
        budget = 0;
        return;
      }
      budget += scenario.rampPerSecond / (1000 / RAMP_STEP_MS);
      while (budget >= 1 && run.active.length < target) {
        this.startBot(run);
        budget -= 1;
      }
      while (budget >= 1 && run.active.length > target) {
        run.active.pop()?.stop();
        budget -= 1;
      }
    }, RAMP_STEP_MS);

    this.enterStep(run, 0);
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
      stepIndex: run.stepIndex,
      botsTarget: this.target(run),
      botsStarted: run.botsStarted,
      botsConnected: run.active.filter(connection => connection.connected).length,
    };
  }

  botCounts(): { target: number; connected: number } {
    const run = this.run;
    if (run?.state !== 'running') {
      return { target: 0, connected: 0 };
    }
    return {
      target: this.target(run),
      connected: run.active.filter(connection => connection.connected).length,
    };
  }

  private target(run: Run): number {
    return run.scenario.steps[run.stepIndex]?.bots ?? 0;
  }

  private enterStep(run: Run, index: number): void {
    const { steps } = run.scenario;
    const step = steps[index];
    if (!step) {
      this.finish(run, 'finished');
      return;
    }

    run.stepIndex = index;
    if (steps.length > 1) {
      this.deps.annotator.stepStarted({
        runId: run.runId,
        index,
        count: steps.length,
        bots: step.bots,
      });
    }
    if (step.durationSeconds !== null) {
      run.stepTimer = setTimeout(() => this.enterStep(run, index + 1), step.durationSeconds * 1000);
    }
  }

  private startBot(run: Run): void {
    run.botsStarted += 1;
    const username = `bot_${run.runId}_${run.botsStarted}`;
    const connection = this.deps.createConnection(username, this.recorderFor(run), run.scenario);
    run.active.push(connection);
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
    if (run.rampTimer) {
      clearInterval(run.rampTimer);
      run.rampTimer = null;
    }
    if (run.stepTimer) {
      clearTimeout(run.stepTimer);
      run.stepTimer = null;
    }
    run.active.forEach(connection => connection.stop());
    run.state = 'stopped';
    this.deps.annotator.runEnded(run.runId);

    this.deps.logger.info({
      event: 'load_run',
      runId: run.runId,
      scenario: run.scenario.name,
      steps: run.scenario.steps,
      stepsReached: run.stepIndex + 1,
      botsStarted: run.botsStarted,
      requests: run.totals,
      outcome,
      durationMs: this.deps.now() - run.startedAt,
    });
  }
}
