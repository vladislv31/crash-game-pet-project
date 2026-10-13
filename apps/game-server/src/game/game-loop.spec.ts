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
});
