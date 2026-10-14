import { Metrics } from '../metrics/metrics';
import { createTestLogger } from '../testing/test-logger';
import { ReconciliationMetrics } from './reconciliation.metrics';
import { reconciliationIntervalMs, ReconciliationService } from './reconciliation.service';
import { Mismatch, ReconciliationReport, ReconciliationStore } from './reconciliation.store';

const INTERVAL_MS = 60_000;

function mismatch(type: Mismatch['type'], userId = 'user-1'): Mismatch {
  return {
    type,
    userId,
    betId: 'bet-1',
    expected: 'count=1 total=150',
    actual: 'count=2 total=300',
  };
}

function report(mismatches: Mismatch[] = []): ReconciliationReport {
  return { usersChecked: 10, betsChecked: 40, mismatches };
}

function setup(intervalMs = INTERVAL_MS) {
  const check = jest.fn<Promise<ReconciliationReport>, [string]>(() => Promise.resolve(report()));
  const store: ReconciliationStore = { check };
  const { logger, events } = createTestLogger();
  const metrics = new Metrics();
  const service = new ReconciliationService(
    store,
    logger,
    new ReconciliationMetrics(metrics),
    intervalMs,
  );

  async function sample(name: string, labels: Record<string, string> = {}) {
    const metric = metrics.registry.getSingleMetric(name);
    const { values } = (await metric?.get()) ?? { values: [] };
    return values.find(value =>
      Object.entries(labels).every(([key, label]) => value.labels[key] === label),
    )?.value;
  }

  return { service, check, logged: events, sample };
}

describe('ReconciliationService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('run', () => {
    it('checks against the max win', async () => {
      const { service, check } = setup();

      await service.run();

      expect(check).toHaveBeenCalledWith('100000');
    });

    it('logs a clean run at info level', async () => {
      const { service, logged } = setup();

      await service.run();

      expect(logged('reconciliation')).toEqual([
        expect.objectContaining({
          level: 'info',
          outcome: 'ok',
          usersChecked: 10,
          betsChecked: 40,
          mismatches: 0,
          mismatchesByType: {},
          examples: [],
          durationMs: expect.any(Number),
        }),
      ]);
    });

    it('logs mismatches at error level, counted by type, with examples', async () => {
      const { service, check, logged } = setup();
      const found = [mismatch('balance'), mismatch('win_entry'), mismatch('win_entry', 'user-2')];
      check.mockResolvedValueOnce(report(found));

      await service.run();

      expect(logged('reconciliation')).toEqual([
        expect.objectContaining({
          level: 'error',
          outcome: 'mismatch',
          mismatches: 3,
          mismatchesByType: { balance: 1, win_entry: 2 },
          examples: found,
        }),
      ]);
    });

    it('logs at most 20 examples, but counts every mismatch', async () => {
      const { service, check, logged } = setup();
      const found = Array.from({ length: 25 }, (_, i) => mismatch('payout', `user-${i}`));
      check.mockResolvedValueOnce(report(found));

      await service.run();

      const [event] = logged('reconciliation');
      expect(event).toMatchObject({ mismatches: 25, mismatchesByType: { payout: 25 } });
      expect(event?.examples).toEqual(found.slice(0, 20));
    });

    it('returns the report', async () => {
      const { service, check } = setup();
      const found = report([mismatch('balance')]);
      check.mockResolvedValueOnce(found);

      await expect(service.run()).resolves.toEqual(found);
    });

    it('logs a failed run at error level and returns null instead of throwing', async () => {
      const { service, check, logged } = setup();
      check.mockRejectedValueOnce(new Error('database down'));

      await expect(service.run()).resolves.toBeNull();

      expect(logged('reconciliation')).toEqual([
        expect.objectContaining({
          level: 'error',
          outcome: 'failed',
          err: expect.objectContaining({ message: 'database down' }),
        }),
      ]);
    });
  });

  describe('metrics', () => {
    it('reports the mismatches of the last run by type, every type even at 0', async () => {
      const { service, check, sample } = setup();
      check.mockResolvedValueOnce(report([mismatch('win_entry'), mismatch('win_entry')]));

      await service.run();

      const name = 'crash_reconciliation_mismatches';
      expect(await sample(name, { type: 'win_entry' })).toBe(2);
      expect(await sample(name, { type: 'balance' })).toBe(0);
      expect(await sample(name, { type: 'orphan_entry' })).toBe(0);
    });

    it('clears mismatches that are gone in the next run', async () => {
      const { service, check, sample } = setup();
      check.mockResolvedValueOnce(report([mismatch('balance')]));
      await service.run();

      await service.run();

      expect(await sample('crash_reconciliation_mismatches', { type: 'balance' })).toBe(0);
    });

    it('records when the last run completed, also when it found mismatches', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      const { service, check, sample } = setup();
      check.mockResolvedValueOnce(report([mismatch('balance')]));

      await service.run();

      expect(await sample('crash_reconciliation_last_success_timestamp_seconds')).toBe(
        1_700_000_000,
      );
    });

    it('keeps the previous results when a run fails', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      const { service, check, sample } = setup();
      check.mockResolvedValueOnce(report([mismatch('balance')]));
      await service.run();
      jest.setSystemTime(1_700_000_060_000);
      check.mockRejectedValueOnce(new Error('database down'));

      await service.run();

      expect(await sample('crash_reconciliation_mismatches', { type: 'balance' })).toBe(1);
      expect(await sample('crash_reconciliation_last_success_timestamp_seconds')).toBe(
        1_700_000_000,
      );
    });
  });

  describe('schedule', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: 0 });
    });

    it('runs every interval, not at startup', async () => {
      const { service, check } = setup();

      service.onApplicationBootstrap();
      expect(check).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(check).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(check).toHaveBeenCalledTimes(2);
    });

    it('does not run on a schedule when the interval is 0', async () => {
      const { service, check } = setup(0);

      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(10 * INTERVAL_MS);

      expect(check).not.toHaveBeenCalled();
    });

    it('skips a tick while the previous run is still going', async () => {
      const { service, check } = setup();
      let finish = () => undefined as void;
      check.mockImplementationOnce(
        () => new Promise(resolve => (finish = () => resolve(report()))),
      );
      service.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(3 * INTERVAL_MS);
      expect(check).toHaveBeenCalledTimes(1);

      finish();
      await jest.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(check).toHaveBeenCalledTimes(2);
    });

    it('stops running on shutdown', async () => {
      const { service, check } = setup();
      service.onApplicationBootstrap();

      await service.beforeApplicationShutdown();
      await jest.advanceTimersByTimeAsync(10 * INTERVAL_MS);

      expect(check).not.toHaveBeenCalled();
    });

    it('waits for a run in progress before the database closes', async () => {
      const { service, check } = setup();
      let finish = () => undefined as void;
      check.mockImplementationOnce(
        () => new Promise(resolve => (finish = () => resolve(report()))),
      );
      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(INTERVAL_MS);

      let closed = false;
      const closing = service.beforeApplicationShutdown().then(() => (closed = true));
      await jest.advanceTimersByTimeAsync(0);
      expect(closed).toBe(false);

      finish();
      await closing;
      expect(closed).toBe(true);
    });
  });
});

describe('reconciliationIntervalMs', () => {
  it('defaults to one minute', () => {
    expect(reconciliationIntervalMs({})).toBe(60_000);
  });

  it.each([
    ['0', 0],
    ['5000', 5_000],
  ])('reads %s from the environment', (value, expected) => {
    expect(reconciliationIntervalMs({ RECONCILIATION_INTERVAL_MS: value })).toBe(expected);
  });

  it.each([['abc'], ['-1'], ['1.5'], ['']])('rejects %p', value => {
    expect(() => reconciliationIntervalMs({ RECONCILIATION_INTERVAL_MS: value })).toThrow(
      'RECONCILIATION_INTERVAL_MS',
    );
  });
});
