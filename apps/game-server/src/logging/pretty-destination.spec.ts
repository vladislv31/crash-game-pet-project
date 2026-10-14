import { Writable } from 'node:stream';

import { createLogger } from './logger';
import { prettyDestination } from './pretty-destination';

function capture() {
  let output = '';
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const logger = createLogger({}, prettyDestination(sink));
  return { logger, output: () => output };
}

describe('prettyDestination', () => {
  it('puts the level and the event name first', () => {
    const { logger, output } = capture();

    logger.error({ event: 'reconciliation', outcome: 'mismatch' });

    expect(output()).toMatch(/ERROR.*reconciliation/);
  });

  it('shows the fields one per line instead of a JSON line', () => {
    const { logger, output } = capture();

    logger.info({ event: 'reconciliation', mismatches: 0, outcome: 'ok' });

    expect(output()).toContain('mismatches: 0');
    expect(output()).toContain('outcome: "ok"');
    expect(output()).not.toContain('{"');
  });

  it('leaves out the service fields that are the same on every line', () => {
    const { logger, output } = capture();

    logger.info({ event: 'reconciliation' });

    for (const field of ['service', 'serviceVersion', 'commitHash', 'region', 'instanceId']) {
      expect(output()).not.toContain(`${field}:`);
    }
  });

  it('adds no colour codes when the destination is not a terminal, wherever it runs', () => {
    const { logger, output } = capture();

    logger.info({ event: 'reconciliation', mismatches: 0 });

    expect(output()).not.toContain('\u001b[');
  });

  it('shows the time of day', () => {
    const { logger, output } = capture();

    logger.info({ event: 'reconciliation' });

    expect(output()).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
  });
});
