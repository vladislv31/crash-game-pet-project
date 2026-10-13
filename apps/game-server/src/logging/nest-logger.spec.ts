import { createTestLogger } from '../testing/test-logger';
import { NestLogger } from './nest-logger';

function setup() {
  const { logger, events } = createTestLogger();
  return { nest: new NestLogger(logger), events };
}

describe('NestLogger', () => {
  it('drops routine framework messages: the startup event covers them', () => {
    const { nest, events } = setup();

    nest.log('Mapped {/health, GET} route', 'RouterExplorer');

    expect(events()).toEqual([]);
  });

  it('logs warnings at info level with their context', () => {
    const { nest, events } = setup();

    nest.warn('deprecated option', 'Config');

    expect(events()).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'nest',
        context: 'Config',
        msg: 'deprecated option',
      }),
    ]);
  });

  it('logs errors at error level with the stack', () => {
    const { nest, events } = setup();

    nest.error('Unable to connect', 'Error: refused\n    at connect', 'TypeOrmModule');

    expect(events()[0]).toMatchObject({
      level: 'error',
      event: 'nest',
      context: 'TypeOrmModule',
      msg: 'Unable to connect',
      stack: 'Error: refused\n    at connect',
    });
  });

  it('logs fatal errors at error level', () => {
    const { nest, events } = setup();

    nest.fatal('out of memory', 'App');

    expect(events()[0]).toMatchObject({ level: 'error', msg: 'out of memory' });
  });

  it('logs an error object as the error', () => {
    const { nest, events } = setup();

    nest.error(new Error('refused'));

    expect(events()[0]).toMatchObject({
      level: 'error',
      err: { name: 'Error', message: 'refused' },
    });
  });

  it('drops debug and verbose messages', () => {
    const { nest, events } = setup();

    nest.debug('details', 'App');
    nest.verbose('more details', 'App');

    expect(events()).toEqual([]);
  });
});
