import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { GameModule } from './game.module';

describe('GameLoopService', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  async function initApp() {
    const moduleRef = await Test.createTestingModule({ imports: [GameModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    return app;
  }

  // Nest logs its own string messages through the same Logger; keep only game events.
  function loggedEventTypes(): unknown[] {
    return logSpy.mock.calls
      .map(([message]: unknown[]) => message)
      .filter(
        (message): message is { type: unknown } =>
          typeof message === 'object' && message !== null && 'type' in message,
      )
      .map(message => message.type);
  }

  it('starts the game loop when the app starts and logs the betting phase', async () => {
    const app = await initApp();

    expect(loggedEventTypes()).toEqual(['betting']);

    await app.close();
  });

  it('logs the round lifecycle', async () => {
    const app = await initApp();

    jest.advanceTimersByTime(15_000 + 86_078);

    expect(loggedEventTypes()).toEqual(expect.arrayContaining(['betting', 'started', 'crashed']));

    await app.close();
  });

  it('stops the game loop when the app shuts down', async () => {
    const app = await initApp();
    await app.close();
    const callsAfterClose = logSpy.mock.calls.length;

    jest.advanceTimersByTime(60_000);

    expect(logSpy.mock.calls).toHaveLength(callsAfterClose);
  });
});
