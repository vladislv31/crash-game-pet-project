import { performance } from 'node:perf_hooks';

import { createTestLogger } from '../testing/test-logger';
import { WideEvent } from './wide-event';

describe('WideEvent', () => {
  it('logs nothing until emitted', () => {
    const { logger, events } = createTestLogger();

    new WideEvent(logger, 'ws.message', { userId: 'u1' });

    expect(events()).toEqual([]);
  });

  it('logs its name, the initial and added fields and the duration once emitted', () => {
    const { logger, events } = createTestLogger();
    const event = new WideEvent(logger, 'ws.message', { userId: 'u1' });

    event.set({ outcome: 'accepted' });
    event.emit();

    expect(events()).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'ws.message',
        userId: 'u1',
        outcome: 'accepted',
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it('later fields replace earlier ones', () => {
    const { logger, events } = createTestLogger();
    const event = new WideEvent(logger, 'round', { outcome: 'started' });

    event.set({ outcome: 'crashed' });
    event.emit();

    expect(events()[0]).toMatchObject({ outcome: 'crashed' });
  });

  it('measures the duration from the given start', () => {
    const { logger, events } = createTestLogger();
    const event = new WideEvent(logger, 'ws.message', {}, performance.now() - 50);

    event.emit();

    expect(events()[0]!.durationMs).toBeGreaterThanOrEqual(50);
  });

  it('rounds the duration to hundredths of a millisecond', () => {
    const { logger, events } = createTestLogger();
    const event = new WideEvent(logger, 'ws.message', {}, performance.now() - 1.23456);

    event.emit();

    const durationMs = events()[0]!.durationMs as number;
    expect(Math.round(durationMs * 100)).toBeCloseTo(durationMs * 100, 9);
  });

  it('is emitted only once', () => {
    const { logger, events } = createTestLogger();
    const event = new WideEvent(logger, 'round');

    event.emit();
    event.emit();

    expect(events()).toHaveLength(1);
  });

  it('logs a failure at error level with the error', () => {
    const { logger, events } = createTestLogger();
    const event = new WideEvent(logger, 'settlement');

    event.fail(new Error('database down'));
    event.emit();

    expect(events()[0]).toMatchObject({
      level: 'error',
      err: { name: 'Error', message: 'database down' },
    });
  });

  it('logs a failure without an error at error level', () => {
    const { logger, events } = createTestLogger();
    const event = new WideEvent(logger, 'http.request');

    event.fail();
    event.emit();

    expect(events()[0]).toMatchObject({ level: 'error' });
    expect(events()[0]).not.toHaveProperty('err');
  });

  it('keeps the first error of several failures', () => {
    const { logger, events } = createTestLogger();
    const event = new WideEvent(logger, 'settlement');

    event.fail(new Error('first'));
    event.fail(new Error('second'));
    event.emit();

    expect(events()[0]).toMatchObject({ err: { message: 'first' } });
  });
});
