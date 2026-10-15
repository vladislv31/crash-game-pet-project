import type { BetView, ClientMessage, ServerMessage } from '@crash/contracts';

import { Bot, BotRecorder, msToReach } from './bot';
import { PRESETS, Scenario } from './scenario';

const BETTING_MS = 15_000;

/** Timers on a fake clock: `advance` runs every action that falls due, in time order. */
class FakeClock {
  time = 1_000_000;
  /** How late every timer fires, as on a busy event loop. */
  lateByMs = 0;
  private actions: { at: number; action: () => void; cancelled: boolean }[] = [];

  now = (): number => this.time;

  schedule = (at: number, action: () => void): (() => void) => {
    const entry = { at, action, cancelled: false };
    this.actions.push(entry);
    return () => (entry.cancelled = true);
  };

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = this.actions
        .filter(entry => !entry.cancelled && entry.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) {
        break;
      }
      this.actions.splice(this.actions.indexOf(due), 1);
      this.time = Math.max(this.time, due.at + this.lateByMs);
      due.action();
    }
    this.time = end;
  }
}

class FakeRecorder implements BotRecorder {
  readonly requests: { type: string; result: string; latencyMs: number }[] = [];
  readonly ticks: number[] = [];

  request(type: 'bet' | 'cashout', result: string, latencyMs: number): void {
    this.requests.push({ type, result, latencyMs });
  }

  tick(jitterMs: number): void {
    this.ticks.push(jitterMs);
  }
}

function setup(changes: Partial<Scenario> = {}, randoms: number[] = []) {
  const scenario: Scenario = {
    ...PRESETS.steady!,
    betProbability: 1,
    betAmount: { min: 100, max: 100 },
    autoCashoutShare: 0,
    target: { min: 200, max: 200 },
    ...changes,
  };
  const clock = new FakeClock();
  const sent: ClientMessage[] = [];
  const recorder = new FakeRecorder();
  let ids = 0;
  const queue = [...randoms];
  const bot = new Bot({
    scenario,
    random: () => queue.shift() ?? 0,
    now: clock.now,
    schedule: clock.schedule,
    send: message => sent.push(message),
    newRequestId: () => `r${++ids}`,
    recorder,
  });

  function receive(message: ServerMessage) {
    bot.handle(message);
  }

  function openBetting(roundId = 'round-1') {
    receive({ type: 'round:betting', roundId, endsAt: clock.time + BETTING_MS });
  }

  function lastSent<T extends ClientMessage['type']>(type: T) {
    return sent
      .filter((message): message is Extract<ClientMessage, { type: T }> => message.type === type)
      .at(-1);
  }

  return { bot, clock, sent, recorder, receive, openBetting, lastSent };
}

function betView(changes: Partial<BetView> = {}): BetView {
  return {
    id: 'bet-1',
    roundId: 'round-1',
    username: 'bot',
    amount: '100',
    autoCashout: null,
    status: 'ACTIVE',
    cashoutMultiplier: null,
    payout: null,
    ...changes,
  };
}

describe('msToReach', () => {
  it.each([
    [100, 0],
    [200, 6_479],
    [1_000_000, 86_078],
  ])('reaches %p after %p ms, like the server curve', (target, ms) => {
    expect(msToReach(target)).toBe(ms);
  });
});

describe('Bot', () => {
  describe('betting', () => {
    it('plans its bet within the first half of the betting phase', () => {
      const { openBetting, clock, sent } = setup({}, [0, 0.99]);

      openBetting();
      clock.advance(BETTING_MS / 2 - 200);
      expect(sent).toEqual([]);

      clock.advance(200);
      expect(sent).toHaveLength(1);
    });

    it('sends a bet with an amount drawn from the range', () => {
      const { openBetting, clock, lastSent } = setup({ betAmount: { min: 100, max: 300 } }, [
        0, // takes part
        0, // bet moment
        0.5, // amount
        0.9, // manual
        0, // target
      ]);

      openBetting();
      clock.advance(0);

      expect(lastSent('bet')).toEqual({ type: 'bet', requestId: 'r1', amount: '200' });
    });

    it.each([
      [0, '100'],
      [0.999, '300'],
    ])('keeps the amount within the range at random %p', (random, amount) => {
      const { openBetting, clock, lastSent } = setup({ betAmount: { min: 100, max: 300 } }, [
        0,
        0,
        random,
      ]);

      openBetting();
      clock.advance(0);

      expect(lastSent('bet')?.amount).toBe(amount);
    });

    it('skips the round when the dice say so', () => {
      const { openBetting, clock, sent } = setup({ betProbability: 0.3 }, [0.5]);

      openBetting();
      clock.advance(BETTING_MS);

      expect(sent).toEqual([]);
    });

    it('bets with an auto-cashout target when the dice pick auto', () => {
      const { openBetting, clock, lastSent } = setup(
        { autoCashoutShare: 0.5, target: { min: 120, max: 220 } },
        [0, 0, 0, 0.1, 0.5],
      );

      openBetting();
      clock.advance(0);

      expect(lastSent('bet')).toEqual({
        type: 'bet',
        requestId: 'r1',
        amount: '100',
        autoCashout: 170,
      });
    });

    it('does not bet in a round it joined after betting closed', () => {
      const { receive, clock, sent } = setup();

      receive({
        type: 'snapshot',
        serverTime: clock.time,
        username: 'bot',
        balance: '5000',
        round: {
          id: 'round-1',
          phase: 'RUNNING',
          bettingEndsAt: clock.time - 1,
          startedAt: clock.time - 1,
        },
        bet: null,
      });
      clock.advance(BETTING_MS);

      expect(sent).toEqual([]);
    });

    it('does not bet when it joins at the very end of betting', () => {
      const { receive, clock, sent } = setup();

      receive({
        type: 'snapshot',
        serverTime: clock.time,
        username: 'bot',
        balance: '5000',
        round: { id: 'round-1', phase: 'BETTING', bettingEndsAt: clock.time, startedAt: null },
        bet: null,
      });
      clock.advance(BETTING_MS);

      expect(sent).toEqual([]);
    });

    it('bets in the round it joined while betting is still open', () => {
      const { receive, clock, sent } = setup();

      receive({
        type: 'snapshot',
        serverTime: clock.time,
        username: 'bot',
        balance: '5000',
        round: {
          id: 'round-1',
          phase: 'BETTING',
          bettingEndsAt: clock.time + 4_000,
          startedAt: null,
        },
        bet: null,
      });
      clock.advance(2_000);

      expect(sent).toHaveLength(1);
    });
  });

  describe('request latency', () => {
    it('measures a bet from the moment it was planned, not when it was answered', () => {
      const { openBetting, clock, receive, recorder } = setup({}, [0]);
      openBetting();
      clock.advance(0);

      clock.advance(35);
      receive({ type: 'bet:accepted', requestId: 'r1', bet: betView(), balance: '4900' });

      expect(recorder.requests).toEqual([{ type: 'bet', result: 'accepted', latencyMs: 35 }]);
    });

    it('counts the time a planned request waited before it could be sent', () => {
      const { openBetting, clock, receive, recorder } = setup({}, [0, 0.5]);
      clock.lateByMs = 50;
      openBetting();

      clock.advance(BETTING_MS / 4 + 50);
      receive({ type: 'bet:accepted', requestId: 'r1', bet: betView(), balance: '4900' });

      expect(recorder.requests[0]?.latencyMs).toBe(50);
    });

    it('records an error answer by its code', () => {
      const { openBetting, clock, receive, recorder } = setup({}, [0]);
      openBetting();
      clock.advance(10);

      receive({ type: 'error', requestId: 'r1', code: 'insufficient_funds' });

      expect(recorder.requests).toEqual([
        { type: 'bet', result: 'insufficient_funds', latencyMs: 10 },
      ]);
    });

    it('ignores answers to requests it did not send', () => {
      const { receive, recorder } = setup();

      receive({ type: 'error', requestId: 'unknown', code: 'invalid_message' });

      expect(recorder.requests).toEqual([]);
    });

    it('records requests left unanswered by a dropped connection', () => {
      const { openBetting, clock, bot, recorder } = setup({}, [0]);
      openBetting();
      clock.advance(20);

      bot.disconnected();

      expect(recorder.requests).toEqual([{ type: 'bet', result: 'no_response', latencyMs: 20 }]);
    });
  });

  describe('manual cashout', () => {
    function betAccepted(target = 200) {
      const context = setup({ target: { min: target, max: target } }, [0, 0, 0, 0.9, 0]);
      context.openBetting();
      context.clock.advance(0);
      context.receive({ type: 'bet:accepted', requestId: 'r1', bet: betView(), balance: '4900' });
      return context;
    }

    it('cashes out when its own clock says the curve reached the target', () => {
      const { clock, receive, sent } = betAccepted(200);
      clock.advance(BETTING_MS);
      receive({ type: 'round:started', roundId: 'round-1', startedAt: clock.time });

      clock.advance(msToReach(200) - 1);
      expect(sent.filter(message => message.type === 'cashout')).toEqual([]);

      clock.advance(1);
      expect(sent.filter(message => message.type === 'cashout')).toEqual([
        { type: 'cashout', requestId: 'r2' },
      ]);
    });

    it('measures the cashout from its planned moment', () => {
      const { clock, receive, recorder } = betAccepted(200);
      receive({ type: 'round:started', roundId: 'round-1', startedAt: clock.time });
      clock.advance(msToReach(200) + 12);

      receive({
        type: 'cashout:accepted',
        requestId: 'r2',
        bet: betView({ status: 'CASHED_OUT', cashoutMultiplier: 200, payout: '200' }),
        balance: '5100',
      });

      expect(recorder.requests.at(-1)).toEqual({
        type: 'cashout',
        result: 'accepted',
        latencyMs: 12,
      });
    });

    it('does not cash out once the round has crashed', () => {
      const { clock, receive, sent } = betAccepted(500);
      receive({ type: 'round:started', roundId: 'round-1', startedAt: clock.time });
      clock.advance(1_000);
      receive({
        type: 'round:crashed',
        roundId: 'round-1',
        crashPoint: 110,
        crashedAt: clock.time,
      });

      clock.advance(msToReach(500));

      expect(sent.filter(message => message.type === 'cashout')).toEqual([]);
    });

    it('does not plan a cashout for a bet that was rejected', () => {
      const context = setup({}, [0, 0, 0, 0.9, 0]);
      context.openBetting();
      context.clock.advance(0);
      context.receive({ type: 'error', requestId: 'r1', code: 'betting_closed' });
      context.receive({ type: 'round:started', roundId: 'round-1', startedAt: context.clock.time });

      context.clock.advance(msToReach(200));

      expect(context.sent.filter(message => message.type === 'cashout')).toEqual([]);
    });

    it('leaves an auto-cashout bet to the server', () => {
      const context = setup({ autoCashoutShare: 1 }, [0, 0, 0, 0, 0]);
      context.openBetting();
      context.clock.advance(0);
      context.receive({
        type: 'bet:accepted',
        requestId: 'r1',
        bet: betView({ autoCashout: 200 }),
        balance: '4900',
      });
      context.receive({ type: 'round:started', roundId: 'round-1', startedAt: context.clock.time });

      context.clock.advance(msToReach(200));

      expect(context.sent.filter(message => message.type === 'cashout')).toEqual([]);
    });
  });

  describe('duplicate cashouts', () => {
    it('sends identical copies of one cashout at once and measures every answer', () => {
      const context = setup({ duplicateCashouts: 3 }, [0, 0, 0, 0.9, 0]);
      context.openBetting();
      context.clock.advance(0);
      context.receive({ type: 'bet:accepted', requestId: 'r1', bet: betView(), balance: '4900' });
      context.receive({ type: 'round:started', roundId: 'round-1', startedAt: context.clock.time });
      context.clock.advance(msToReach(200));

      const accepted = {
        type: 'cashout:accepted' as const,
        requestId: 'r2',
        bet: betView({ status: 'CASHED_OUT', cashoutMultiplier: 200, payout: '200' }),
        balance: '5100',
      };
      context.receive(accepted);
      context.receive(accepted);
      context.receive(accepted);
      context.receive(accepted);

      expect(context.sent.filter(message => message.type === 'cashout')).toEqual([
        { type: 'cashout', requestId: 'r2' },
        { type: 'cashout', requestId: 'r2' },
        { type: 'cashout', requestId: 'r2' },
      ]);
      expect(context.recorder.requests.filter(request => request.type === 'cashout')).toHaveLength(
        3,
      );
    });
  });

  describe('ticks', () => {
    it('records how far each tick strayed from the 100 ms period', () => {
      const { receive, clock, recorder } = setup();
      receive({ type: 'round:started', roundId: 'round-1', startedAt: clock.time });

      receive({ type: 'round:tick', roundId: 'round-1', multiplier: 101 });
      clock.advance(130);
      receive({ type: 'round:tick', roundId: 'round-1', multiplier: 102 });
      clock.advance(90);
      receive({ type: 'round:tick', roundId: 'round-1', multiplier: 103 });

      expect(recorder.ticks).toEqual([30, -10]);
    });

    it('does not count the time a reconnect took as tick jitter', () => {
      const { bot, receive, clock, recorder } = setup();
      receive({ type: 'round:tick', roundId: 'round-1', multiplier: 101 });

      bot.disconnected();
      clock.advance(2_000);
      receive({ type: 'round:tick', roundId: 'round-1', multiplier: 150 });

      expect(recorder.ticks).toEqual([]);
    });

    it('starts over in each round', () => {
      const { receive, clock, recorder } = setup();
      receive({ type: 'round:tick', roundId: 'round-1', multiplier: 101 });
      receive({
        type: 'round:crashed',
        roundId: 'round-1',
        crashPoint: 102,
        crashedAt: clock.time,
      });
      clock.advance(20_000);
      receive({ type: 'round:started', roundId: 'round-2', startedAt: clock.time });

      receive({ type: 'round:tick', roundId: 'round-2', multiplier: 101 });

      expect(recorder.ticks).toEqual([]);
    });
  });
});
