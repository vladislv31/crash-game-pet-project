import type { RunAnnotator } from './run-controller';
import type { Scenario } from './scenario';

export interface GrafanaAnnotatorDeps {
  url: URL;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now: () => number;
  logger: { error(event: Record<string, unknown>): void };
}

type Operation = 'run_started' | 'step_started' | 'run_ended';

/** Run and step annotations through the Grafana HTTP API; failures are logged, never thrown (ADR-0008). */
export class GrafanaAnnotator implements RunAnnotator {
  /** The id of each run's region annotation, or null when it could not be created. */
  private readonly runAnnotations = new Map<string, Promise<number | null>>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: GrafanaAnnotatorDeps) {}

  runStarted({ runId, scenario }: { runId: string; scenario: Scenario }): void {
    const created = this.call('run_started', runId, 'POST', '/api/annotations', {
      time: this.deps.now(),
      tags: ['load-run', runId, scenario.name],
      text: `Load run ${runId} · ${scenario.name} · ${describe(scenario)}`,
    }).then(async response => (response ? ((await response.json()) as { id: number }).id : null));
    this.runAnnotations.set(runId, created);
    this.track(created);
  }

  stepStarted(step: { runId: string; index: number; count: number; bots: number }): void {
    this.track(
      this.call('step_started', step.runId, 'POST', '/api/annotations', {
        time: this.deps.now(),
        tags: ['load-step', step.runId],
        text: `Step ${step.index + 1}/${step.count} · ${step.bots} bots`,
      }),
    );
  }

  runEnded(runId: string): void {
    // The end is the moment the run stopped, not when the create call happened to finish.
    const timeEnd = this.deps.now();
    const created = this.runAnnotations.get(runId);
    this.runAnnotations.delete(runId);
    if (!created) {
      return;
    }
    this.track(
      created.then(id =>
        id === null
          ? null
          : this.call('run_ended', runId, 'PATCH', `/api/annotations/${id}`, { timeEnd }),
      ),
    );
  }

  /** Resolves once every call made so far has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private async call(
    operation: Operation,
    runId: string,
    method: string,
    path: string,
    body: unknown,
  ): Promise<Response | null> {
    try {
      const response = await this.deps.fetch(new URL(path, this.deps.url), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        this.deps.logger.error({
          event: 'grafana.annotation_failed',
          operation,
          runId,
          status: response.status,
        });
        return null;
      }
      return response;
    } catch (error) {
      this.deps.logger.error({ event: 'grafana.annotation_failed', operation, runId, err: error });
      return null;
    }
  }

  private track(operation: Promise<unknown>): void {
    const settled = operation.catch(() => undefined).finally(() => this.pending.delete(settled));
    this.pending.add(settled);
  }
}

function describe(scenario: Scenario): string {
  const bots = scenario.steps.map(step => step.bots).join(' → ');
  return `${bots} bots · ${scenario.rampPerSecond}/s`;
}
