import type { BetView, ServerMessage } from '@crash/contracts';

import { GameState, INITIAL_STATE, reduce } from './game-state';

const LOCAL_TIME = 1_000;

function bet(overrides: Partial<BetView> = {}): BetView {
  return {
    id: 'bet-1',
    roundId: 'round-1',
    username: 'alice',
    amount: '100',
    autoCashout: null,
    status: 'ACTIVE',
    cashoutMultiplier: null,
    payout: null,
    ...overrides,
  };
}

function receive(state: GameState, ...messages: ServerMessage[]): GameState {
  return messages.reduce(
    (current, message) => reduce(current, { type: 'message', message, localTime: LOCAL_TIME }),
    state,
  );
}

const SNAPSHOT: ServerMessage = {
  type: 'snapshot',
  serverTime: 1_250,
  username: 'alice',
  balance: '5000',
  round: { id: 'round-1', phase: 'BETTING', bettingEndsAt: 16_000, startedAt: null },
  bet: null,
};

function connected(): GameState {
  return receive(reduce(INITIAL_STATE, { type: 'socket_open' }), SNAPSHOT);
}

describe('reduce', () => {
  describe('connection', () => {
    it('starts connecting', () => {
      expect(INITIAL_STATE.status).toBe('connecting');
    });

    it('is connected after the snapshot', () => {
      const state = connected();

      expect(state).toMatchObject({
        status: 'connected',
        username: 'alice',
        balance: '5000',
        round: { id: 'round-1', phase: 'BETTING', bettingEndsAt: 16_000, multiplier: 100 },
      });
    });

    it('measures the clock offset to the server', () => {
      expect(connected().clockOffset).toBe(250);
    });

    it('restores the player bet from the snapshot', () => {
      const state = receive(INITIAL_STATE, { ...SNAPSHOT, type: 'snapshot', bet: bet() });

      expect(state.myBet).toEqual(bet());
      expect(state.bets).toEqual([bet()]);
    });

    it('marks the connection as lost', () => {
      expect(reduce(connected(), { type: 'socket_closed' }).status).toBe('disconnected');
    });
  });

  describe('round', () => {
    it('starts a new round with an empty bet list', () => {
      const state = receive(
        connected(),
        { type: 'bet:placed', bet: bet({ username: 'bob', id: 'bet-2' }) },
        { type: 'round:betting', roundId: 'round-2', endsAt: 40_000 },
      );

      expect(state.round).toEqual({
        id: 'round-2',
        phase: 'BETTING',
        bettingEndsAt: 40_000,
        startedAt: null,
        multiplier: 100,
        crashPoint: null,
      });
      expect(state.bets).toEqual([]);
      expect(state.myBet).toBeNull();
    });

    it('runs from the start time', () => {
      const state = receive(connected(), {
        type: 'round:started',
        roundId: 'round-1',
        startedAt: 16_000,
      });

      expect(state.round).toMatchObject({ phase: 'RUNNING', startedAt: 16_000 });
    });

    it('follows the ticks', () => {
      const state = receive(connected(), {
        type: 'round:tick',
        roundId: 'round-1',
        multiplier: 150,
      });

      expect(state.round?.multiplier).toBe(150);
    });

    it('ignores ticks of another round', () => {
      const state = receive(connected(), { type: 'round:tick', roundId: 'old', multiplier: 150 });

      expect(state.round?.multiplier).toBe(100);
    });

    it('shows the crash point and adds it to the history', () => {
      const state = receive(connected(), {
        type: 'round:crashed',
        roundId: 'round-1',
        crashPoint: 186,
        crashedAt: 20_000,
      });

      expect(state.round).toMatchObject({ phase: 'CRASHED', crashPoint: 186, multiplier: 186 });
      expect(state.history).toEqual([186]);
    });

    it('keeps the last 20 crash points, newest first', () => {
      let state = connected();
      for (let crashPoint = 101; crashPoint <= 125; crashPoint++) {
        state = receive(state, {
          type: 'round:crashed',
          roundId: 'round-1',
          crashPoint,
          crashedAt: 0,
        });
      }

      expect(state.history).toHaveLength(20);
      expect(state.history[0]).toBe(125);
    });
  });

  describe('bets', () => {
    it('stores the accepted bet and the new balance', () => {
      const state = receive(connected(), {
        type: 'bet:accepted',
        requestId: 'r1',
        bet: bet(),
        balance: '4900',
      });

      expect(state).toMatchObject({ myBet: bet(), balance: '4900', bets: [bet()] });
    });

    it('lists other players bets without taking them as mine', () => {
      const other = bet({ id: 'bet-2', username: 'bob' });

      const state = receive(connected(), { type: 'bet:placed', bet: other });

      expect(state.bets).toEqual([other]);
      expect(state.myBet).toBeNull();
    });

    it('does not list the same bet twice', () => {
      const state = receive(
        connected(),
        { type: 'bet:accepted', requestId: 'r1', bet: bet(), balance: '4900' },
        { type: 'bet:placed', bet: bet() },
      );

      expect(state.bets).toHaveLength(1);
    });

    it('updates a cashed-out bet in place', () => {
      const cashedOut = bet({ status: 'CASHED_OUT', cashoutMultiplier: 150, payout: '150' });

      const state = receive(
        connected(),
        { type: 'bet:accepted', requestId: 'r1', bet: bet(), balance: '4900' },
        { type: 'bet:cashed_out', bet: cashedOut },
      );

      expect(state.bets).toEqual([cashedOut]);
      expect(state.myBet).toEqual(cashedOut);
    });

    it('applies the balance after a cashout', () => {
      const state = receive(connected(), {
        type: 'cashout:accepted',
        requestId: 'r2',
        bet: bet({ status: 'CASHED_OUT' }),
        balance: '5050',
      });

      expect(state.balance).toBe('5050');
    });

    it('applies a balance update from an auto-cashout', () => {
      expect(receive(connected(), { type: 'balance', balance: '5050' }).balance).toBe('5050');
    });
  });

  describe('errors', () => {
    it('shows the error code with field errors', () => {
      const state = receive(connected(), {
        type: 'error',
        requestId: 'r1',
        code: 'validation_failed',
        errors: { amount: 'too_low' },
      });

      expect(state.lastError).toBe('validation_failed: amount too_low');
    });

    it('clears the error after the next accepted request', () => {
      const state = receive(
        connected(),
        { type: 'error', requestId: 'r1', code: 'betting_closed' },
        { type: 'bet:accepted', requestId: 'r2', bet: bet(), balance: '4900' },
      );

      expect(state.lastError).toBeNull();
    });
  });
});
