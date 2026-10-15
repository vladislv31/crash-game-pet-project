import { createLogger } from './logger';

function capture(env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const logger = createLogger(env, { write: (line: string) => void lines.push(line) });
  return { logger, events: () => lines.map(line => JSON.parse(line) as Record<string, unknown>) };
}

describe('createLogger', () => {
  it('writes JSON events with the service fields and UTC ISO time', () => {
    const { logger, events } = capture({ npm_package_version: '1.0.0', COMMIT_HASH: 'abc' });

    logger.info({ event: 'load_run' });

    expect(events()[0]).toMatchObject({
      level: 'info',
      event: 'load_run',
      service: 'load-generator',
      serviceVersion: '1.0.0',
      commitHash: 'abc',
      region: 'local',
      instanceId: expect.any(String),
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
  });

  it('keeps only the name, message, code and stack of an error', () => {
    const { logger, events } = capture();
    const error = Object.assign(new Error('refused'), { code: 'ECONNREFUSED', address: '::1' });

    logger.error({ event: 'http.request', err: error });

    expect(events()[0]!.err).toEqual({
      name: 'Error',
      message: 'refused',
      code: 'ECONNREFUSED',
      stack: expect.stringContaining('refused'),
    });
  });
});
