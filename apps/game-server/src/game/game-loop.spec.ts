import { GameEvent, GameLoop, GameLoopOptions } from './game-loop';
import { crashTimeMs, multiplierAt } from './multiplier';

const BETTING_MS = 15_000;
const TICK_MS = 100;
const PAUSE_MS = 5_000;

function createLoop(crashPoints: number[], overrides: Partial<GameLoopOptions> = {}) {
  const events: GameEvent[] = [];
  let roundNumber = 0;
  const queue = [...crashPoints];

  const loop = new GameLoop({
    generateCrashPoint: () => {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('No crash points left in test setup');
      }
      return next;
    },
    nextRoundId: () => `round-${++roundNumber}`,
    onEvent: event => events.push(event),
    ...overrides,
  });

  return { loop, events };
}

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T) {
  return events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

describe('GameLoop', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens betting for the first round on start', () => {
    const { loop, events } = createLoop([200]);

    loop.start();

    expect(events).toEqual([{ type: 'betting', roundId: 'round-1', endsAt: BETTING_MS }]);
    expect(loop.currentRound?.phase).toBe('BETTING');
  });

  it('cannot be started twice', () => {
    const { loop } = createLoop([200]);
    loop.start();

    expect(() => loop.start()).toThrow();
  });

  it('keeps betting open until the betting phase ends', () => {
    const { loop, events } = createLoop([200]);
    loop.start();

    jest.advanceTimersByTime(BETTING_MS - 1);

    expect(ofType(events, 'started')).toEqual([]);
    expect(loop.currentRound?.phase).toBe('BETTING');
  });

  it('starts the round when the betting phase ends', () => {
    const { loop, events } = createLoop([200]);
    loop.start();

    jest.advanceTimersByTime(BETTING_MS);

    expect(ofType(events, 'started')).toEqual([
      { type: 'started', roundId: 'round-1', startedAt: BETTING_MS },
    ]);
    expect(loop.currentRound?.phase).toBe('RUNNING');
  });

  it('broadcasts the multiplier every tick while running', () => {
    const { loop, events } = createLoop([300]);
    loop.start();

    jest.advanceTimersByTime(BETTING_MS + 3 * TICK_MS);

    expect(ofType(events, 'tick')).toEqual([
      { type: 'tick', roundId: 'round-1', multiplier: multiplierAt(100) },
      { type: 'tick', roundId: 'round-1', multiplier: multiplierAt(200) },
      { type: 'tick', roundId: 'round-1', multiplier: multiplierAt(300) },
    ]);
  });

  it('crashes exactly at the crash time', () => {
    const { loop, events } = createLoop([200]);
    loop.start();

    jest.advanceTimersByTime(BETTING_MS + crashTimeMs(200) - 1);
    expect(loop.currentRound?.phase).toBe('RUNNING');

    jest.advanceTimersByTime(1);
    expect(loop.currentRound?.phase).toBe('CRASHED');
    expect(ofType(events, 'crashed')).toEqual([
      {
        type: 'crashed',
        roundId: 'round-1',
        crashPoint: 200,
        crashedAt: BETTING_MS + crashTimeMs(200),
      },
    ]);
  });

  it('never ticks at or above the crash point and stops ticking after the crash', () => {
    const { loop, events } = createLoop([200]);
    loop.start();

    jest.advanceTimersByTime(BETTING_MS + crashTimeMs(200) + 10 * TICK_MS);

    const ticks = ofType(events, 'tick');
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every(tick => tick.multiplier < 200)).toBe(true);
    expect(events.at(-1)?.type).toBe('crashed');
  });

  it('skips a tick that reads the clock past the crash time before the crash timer fires', () => {
    // Simulates event loop lag: the clock runs one tick ahead of the timers.
    let clockLead = 0;
    const { loop, events } = createLoop([200], { now: () => Date.now() + clockLead });
    loop.start();
    jest.advanceTimersByTime(BETTING_MS);

    clockLead = TICK_MS;
    jest.advanceTimersByTime(crashTimeMs(200));

    expect(ofType(events, 'tick').every(tick => tick.multiplier < 200)).toBe(true);
    expect(ofType(events, 'crashed')).toHaveLength(1);
  });

  it('crashes a 1.00x round as soon as it starts, without ticks', () => {
    const { loop, events } = createLoop([100]);
    loop.start();

    jest.advanceTimersByTime(BETTING_MS);

    expect(loop.currentRound?.phase).toBe('CRASHED');
    expect(ofType(events, 'tick')).toEqual([]);
  });

  it('opens betting for the next round after the pause', () => {
    const { loop, events } = createLoop([100, 300]);
    loop.start();

    jest.advanceTimersByTime(BETTING_MS + PAUSE_MS - 1);
    expect(ofType(events, 'betting')).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(ofType(events, 'betting')).toEqual([
      { type: 'betting', roundId: 'round-1', endsAt: BETTING_MS },
      { type: 'betting', roundId: 'round-2', endsAt: BETTING_MS + PAUSE_MS + BETTING_MS },
    ]);
    expect(loop.currentRound?.id).toBe('round-2');
    expect(loop.currentRound?.crashPoint).toBe(300);
  });

  it('does not crash early if the crash timer fires before the crash time', () => {
    let clockLag = 0;
    const { loop, events } = createLoop([200], { now: () => Date.now() - clockLag });
    loop.start();
    jest.advanceTimersByTime(BETTING_MS);

    clockLag = 1;
    jest.advanceTimersByTime(crashTimeMs(200));
    expect(loop.currentRound?.phase).toBe('RUNNING');

    clockLag = 0;
    jest.advanceTimersByTime(1);
    expect(loop.currentRound?.phase).toBe('CRASHED');
    expect(ofType(events, 'crashed')).toHaveLength(1);
  });

  it('emits nothing after stop', () => {
    const { loop, events } = createLoop([200]);
    loop.start();
    jest.advanceTimersByTime(BETTING_MS + 5 * TICK_MS);
    const countBeforeStop = events.length;

    loop.stop();
    jest.advanceTimersByTime(60_000);

    expect(events).toHaveLength(countBeforeStop);
  });

  describe('preparing a round', () => {
    function deferred() {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>(done => (resolve = done));
      return { promise, resolve };
    }

    it('opens betting only after the round is prepared', async () => {
      const prepared = deferred();
      const prepareRound = jest.fn(() => prepared.promise);
      const { loop, events } = createLoop([200], { prepareRound });

      loop.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(events).toEqual([]);
      expect(loop.currentRound).toBeNull();
      expect(prepareRound).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'round-1', crashPoint: 200 }),
        BETTING_MS,
      );

      prepared.resolve();
      await jest.advanceTimersByTimeAsync(0);

      expect(events).toEqual([{ type: 'betting', roundId: 'round-1', endsAt: BETTING_MS }]);
      expect(loop.currentRound?.id).toBe('round-1');
    });

    it('keeps the planned betting end when preparing takes time', async () => {
      const { loop, events } = createLoop([200], {
        prepareRound: () => new Promise<void>(done => setTimeout(done, 300)),
      });

      loop.start();
      await jest.advanceTimersByTimeAsync(BETTING_MS);

      expect(ofType(events, 'betting')).toEqual([
        { type: 'betting', roundId: 'round-1', endsAt: BETTING_MS },
      ]);
      expect(ofType(events, 'started')).toEqual([
        { type: 'started', roundId: 'round-1', startedAt: BETTING_MS },
      ]);
    });

    it('reports the failure and tries a new round after the pause', async () => {
      const onError = jest.fn();
      let attempts = 0;
      const { loop, events } = createLoop([200, 300], {
        onError,
        prepareRound: () =>
          ++attempts === 1 ? Promise.reject(new Error('database down')) : Promise.resolve(),
      });

      loop.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(events).toEqual([]);

      await jest.advanceTimersByTimeAsync(PAUSE_MS);

      expect(events).toEqual([
        { type: 'betting', roundId: 'round-2', endsAt: PAUSE_MS + BETTING_MS },
      ]);
    });

    it('plans the next round only after waiting for the previous one', async () => {
      const { loop, events } = createLoop([200], {
        beforeNextRound: () => new Promise<void>(done => setTimeout(done, 20_000)),
        prepareRound: () => Promise.resolve(),
      });

      loop.start();
      await jest.advanceTimersByTimeAsync(20_000);

      expect(events).toEqual([
        { type: 'betting', roundId: 'round-1', endsAt: 20_000 + BETTING_MS },
      ]);
    });

    it('does not open betting when stopped while preparing', async () => {
      const prepared = deferred();
      const { loop, events } = createLoop([200], { prepareRound: () => prepared.promise });
      loop.start();

      loop.stop();
      prepared.resolve();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(events).toEqual([]);
    });
  });

  it('starts the round at its planned betting end even if the timer fires late', () => {
    let clockLead = 0;
    const { loop, events } = createLoop([200], { now: () => Date.now() + clockLead });
    loop.start();
    jest.advanceTimersByTime(BETTING_MS - 1);

    clockLead = 50;
    jest.advanceTimersByTime(1);

    expect(ofType(events, 'started')).toEqual([
      { type: 'started', roundId: 'round-1', startedAt: BETTING_MS },
    ]);
  });

  describe('resuming a stored round', () => {
    const NOW = 100_000;

    beforeEach(() => {
      jest.setSystemTime(NOW);
    });

    it('continues betting when the stored round is still open', () => {
      const prepareRound = jest.fn(() => Promise.resolve());
      const { loop, events } = createLoop([], { prepareRound });

      loop.start({ id: 'stored', crashPoint: 200, bettingEndsAt: NOW + 4_000 });

      expect(events).toEqual([{ type: 'betting', roundId: 'stored', endsAt: NOW + 4_000 }]);
      expect(prepareRound).not.toHaveBeenCalled();

      jest.advanceTimersByTime(4_000);

      expect(ofType(events, 'started')).toEqual([
        { type: 'started', roundId: 'stored', startedAt: NOW + 4_000 },
      ]);
    });

    it('continues the flight from where it is when the stored round is running', () => {
      const { loop, events } = createLoop([]);

      loop.start({ id: 'stored', crashPoint: 500, bettingEndsAt: NOW - 3_000 });

      expect(events).toEqual([{ type: 'started', roundId: 'stored', startedAt: NOW - 3_000 }]);
      expect(loop.currentRound?.multiplier(NOW)).toBe(multiplierAt(3_000));

      jest.advanceTimersByTime(TICK_MS);
      expect(events.at(-1)).toEqual({
        type: 'tick',
        roundId: 'stored',
        multiplier: multiplierAt(3_000 + TICK_MS),
      });
    });

    it('crashes the continued round at its original crash time', () => {
      const { loop, events } = createLoop([300]);
      loop.start({ id: 'stored', crashPoint: 500, bettingEndsAt: NOW - 3_000 });

      jest.advanceTimersByTime(crashTimeMs(500) - 3_000);

      expect(ofType(events, 'crashed')).toEqual([
        {
          type: 'crashed',
          roundId: 'stored',
          crashPoint: 500,
          crashedAt: NOW - 3_000 + crashTimeMs(500),
        },
      ]);
    });

    it('opens a new round when the stored round should already have crashed', () => {
      const { loop, events } = createLoop([300]);

      loop.start({ id: 'stored', crashPoint: 200, bettingEndsAt: NOW - 60_000 });

      expect(events).toEqual([{ type: 'betting', roundId: 'round-1', endsAt: NOW + BETTING_MS }]);
    });

    it('opens a new round when the stored round ends exactly now', () => {
      const { loop, events } = createLoop([300]);

      loop.start({ id: 'stored', crashPoint: 200, bettingEndsAt: NOW - crashTimeMs(200) });

      expect(events[0]).toMatchObject({ type: 'betting', roundId: 'round-1' });
    });
  });
});
