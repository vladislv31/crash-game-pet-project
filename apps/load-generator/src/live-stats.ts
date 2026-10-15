import type { LoadLiveSummary } from '@crash/contracts';

import type { BotRecorder, RequestType } from './bot';

export type LiveSummary = LoadLiveSummary;

interface Entry {
  at: number;
  key: string;
  error: boolean;
  latencyMs: number;
}

const SUCCESSFUL_RESULTS = new Set(['accepted', 'replayed']);

/** Numbers for the test dashboard over a sliding window; Grafana keeps the history (ADR-0008). */
export class LiveStats implements Pick<BotRecorder, 'request'> {
  private entries: Entry[] = [];

  constructor(
    private readonly now: () => number,
    private readonly windowMs: number,
  ) {}

  request(type: RequestType, result: string, latencyMs: number): void {
    this.entries.push({
      at: this.now(),
      key: `${type} ${result}`,
      error: !SUCCESSFUL_RESULTS.has(result),
      latencyMs,
    });
  }

  summary(): LiveSummary {
    const since = this.now() - this.windowMs;
    this.entries = this.entries.filter(entry => entry.at >= since);

    const seconds = this.windowMs / 1000;
    const results: Record<string, number> = {};
    for (const { key } of this.entries) {
      results[key] = (results[key] ?? 0) + 1;
    }
    const latencies = this.entries.map(entry => entry.latencyMs).sort((a, b) => a - b);

    return {
      requestsPerSecond: this.entries.length / seconds,
      errorsPerSecond: this.entries.filter(entry => entry.error).length / seconds,
      latencyMs: { p50: percentile(latencies, 0.5), p99: percentile(latencies, 0.99) },
      results,
    };
  }
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: number[], quantile: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? null;
}
