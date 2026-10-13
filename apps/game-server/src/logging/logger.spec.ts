import { createLogger } from './logger';

function capture(env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const logger = createLogger(env, { write: (line: string) => void lines.push(line) });
  const events = () => lines.map(line => JSON.parse(line) as Record<string, unknown>);

  return { logger, lines, events };
}

describe('createLogger', () => {
  it('writes each event as one JSON line', () => {
    const { logger, lines } = capture();

    logger.info({ event: 'test' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\{.*\}\n$/);
  });

  it('adds the service fields from the environment to every event', () => {
    const { logger, events } = capture({
      npm_package_version: '1.2.3',
      COMMIT_HASH: 'abc123',
      REGION: 'eu-1',
    });

    logger.info({ event: 'test' });

    expect(events()[0]).toMatchObject({
      event: 'test',
      service: 'game-server',
      serviceVersion: '1.2.3',
      commitHash: 'abc123',
      region: 'eu-1',
    });
  });

  it('falls back to defaults when the environment has no service fields', () => {
    const { logger, events } = capture();

    logger.info({ event: 'test' });

    expect(events()[0]).toMatchObject({
      serviceVersion: 'unknown',
      commitHash: 'unknown',
      region: 'local',
    });
  });

  it('stamps events with UTC ISO-8601 time', () => {
    const { logger, events } = capture();

    logger.info({ event: 'test' });

    const { timestamp } = events()[0]!;
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('names the level', () => {
    const { logger, events } = capture();

    logger.info({ event: 'ok' });
    logger.error({ event: 'failed' });

    expect(events().map(event => event.level)).toEqual(['info', 'error']);
  });

  it('keeps one instance id per logger, different between loggers', () => {
    const first = capture();
    const second = capture();

    first.logger.info({ event: 'a' });
    first.logger.info({ event: 'b' });
    second.logger.info({ event: 'c' });

    const [a, b] = first.events();
    const [c] = second.events();
    expect(a!.instanceId).toEqual(expect.any(String));
    expect(b!.instanceId).toBe(a!.instanceId);
    expect(c!.instanceId).not.toBe(a!.instanceId);
  });

  it('does not add process id or host name', () => {
    const { logger, events } = capture();

    logger.info({ event: 'test' });

    expect(events()[0]).not.toHaveProperty('pid');
    expect(events()[0]).not.toHaveProperty('hostname');
  });

  it('keeps only the name, message, code and stack of an error', () => {
    const { logger, events } = capture();
    const error = Object.assign(new Error('query failed'), {
      code: '23505',
      query: 'SELECT * FROM users WHERE token = $1',
      parameters: ['secret-token'],
    });

    logger.error({ event: 'failed', err: error });

    expect(events()[0]!.err).toEqual({
      name: 'Error',
      message: 'query failed',
      code: '23505',
      stack: expect.stringContaining('query failed'),
    });
  });

  it('logs a thrown non-error value as a message', () => {
    const { logger, events } = capture();

    logger.error({ event: 'failed', err: 'boom' });

    expect(events()[0]!.err).toEqual({ message: 'boom' });
  });

  it('removes tokens', () => {
    const { logger, events } = capture();

    logger.info({ event: 'test', token: 'secret', user: { token: 'secret' } });

    expect(JSON.stringify(events()[0])).not.toContain('secret');
  });
});
