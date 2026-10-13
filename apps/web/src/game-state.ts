import type { BetView, ClientMessage, RoundPhase, ServerMessage } from '@crash/contracts';

const HISTORY_SIZE = 20;

export interface RoundState {
  id: string;
  phase: RoundPhase;
  bettingEndsAt: number;
  startedAt: number | null;
  /** Last multiplier from the server, in hundredths. */
  multiplier: number;
  crashPoint: number | null;
}

export interface GameState {
  status: 'connecting' | 'connected' | 'disconnected';
  username: string | null;
  balance: string | null;
  /** Server time minus local time, in ms. */
  clockOffset: number;
  round: RoundState | null;
  myBet: BetView | null;
  /** Bets of the current round, in arrival order. */
  bets: BetView[];
  /** Recent crash points, newest first. */
  history: number[];
  lastError: string | null;
  /** The last request without an answer yet; retried with the same requestId after a reconnect. */
  pending: ClientMessage | null;
  /** Increases with every snapshot, i.e. every (re)connect. */
  snapshots: number;
}

export type GameAction =
  | { type: 'socket_open' }
  | { type: 'socket_closed' }
  | { type: 'request'; message: ClientMessage }
  | { type: 'message'; message: ServerMessage; localTime: number };

export const INITIAL_STATE: GameState = {
  status: 'connecting',
  username: null,
  balance: null,
  clockOffset: 0,
  round: null,
  myBet: null,
  bets: [],
  history: [],
  lastError: null,
  pending: null,
  snapshots: 0,
};

export function reduce(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'socket_open':
      return { ...state, status: 'connecting' };
    case 'socket_closed':
      return { ...state, status: 'disconnected' };
    case 'request':
      return { ...state, pending: action.message };
    case 'message':
      return applyMessage(state, action.message, action.localTime);
  }
}

function applyMessage(state: GameState, message: ServerMessage, localTime: number): GameState {
  switch (message.type) {
    case 'snapshot': {
      const synced: GameState = {
        ...state,
        status: 'connected',
        username: message.username,
        balance: message.balance,
        clockOffset: message.serverTime - localTime,
        round: message.round ? { ...message.round, multiplier: 100, crashPoint: null } : null,
        myBet: message.bet,
        bets: message.bet ? [message.bet] : [],
        snapshots: state.snapshots + 1,
      };
      return { ...synced, pending: stillNeeded(state.pending, synced) };
    }
    case 'round:betting':
      return {
        ...state,
        round: {
          id: message.roundId,
          phase: 'BETTING',
          bettingEndsAt: message.endsAt,
          startedAt: null,
          multiplier: 100,
          crashPoint: null,
        },
        myBet: null,
        bets: [],
      };
    case 'round:started':
      return updateRound(state, message.roundId, {
        phase: 'RUNNING',
        startedAt: message.startedAt,
      });
    case 'round:tick':
      return updateRound(state, message.roundId, { multiplier: message.multiplier });
    case 'round:crashed':
      return {
        ...updateRound(state, message.roundId, {
          phase: 'CRASHED',
          crashPoint: message.crashPoint,
          multiplier: message.crashPoint,
        }),
        history: [message.crashPoint, ...state.history].slice(0, HISTORY_SIZE),
      };
    case 'bet:placed':
    case 'bet:cashed_out':
    case 'bet:refunded':
      return withBet(state, message.bet);
    case 'bet:accepted':
    case 'cashout:accepted':
      return {
        ...withBet(state, message.bet),
        balance: message.balance,
        lastError: null,
        pending: answered(state.pending, message.requestId) ? null : state.pending,
      };
    case 'balance':
      return { ...state, balance: message.balance };
    case 'error': {
      // "unavailable" means the server is restarting: keep the request to retry after reconnecting.
      const forget = message.code !== 'unavailable' && answered(state.pending, message.requestId);
      return {
        ...state,
        lastError: describeError(message.code, message.errors),
        pending: forget ? null : state.pending,
      };
    }
  }
}

function answered(pending: ClientMessage | null, requestId: string | undefined): boolean {
  return pending !== null && pending.requestId === requestId;
}

/** Whether a request that got no answer before the connection dropped still makes sense to retry. */
function stillNeeded(pending: ClientMessage | null, synced: GameState): ClientMessage | null {
  if (!pending) {
    return null;
  }

  const phase = synced.round?.phase;
  if (pending.type === 'bet') {
    return phase === 'BETTING' && !synced.myBet ? pending : null;
  }

  return phase === 'RUNNING' && synced.myBet?.status === 'ACTIVE' ? pending : null;
}

function updateRound(state: GameState, roundId: string, changes: Partial<RoundState>): GameState {
  if (state.round?.id !== roundId) {
    return state;
  }

  return { ...state, round: { ...state.round, ...changes } };
}

function withBet(state: GameState, bet: BetView): GameState {
  const known = state.bets.some(existing => existing.id === bet.id);
  const bets = known
    ? state.bets.map(existing => (existing.id === bet.id ? bet : existing))
    : [...state.bets, bet];

  return {
    ...state,
    bets,
    myBet: bet.username === state.username ? bet : state.myBet,
  };
}

function describeError(code: string, errors?: Record<string, string>): string {
  if (!errors) {
    return code;
  }

  const fields = Object.entries(errors).map(([field, error]) => `${field} ${error}`);

  return `${code}: ${fields.join(', ')}`;
}
