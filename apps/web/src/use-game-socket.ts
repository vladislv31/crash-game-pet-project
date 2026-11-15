import type { ClientMessage, ServerMessage, TournamentRankRequestMessage } from '@crash/contracts';
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { GameState, INITIAL_STATE, reduce } from './game-state';

const UNAUTHORIZED_CLOSE_CODE = 4401;
const RECONNECT_DELAY_MS = 1_000;

/** Keeps one WebSocket open (reconnecting after drops) and folds server messages into game state. */
export function useGameSocket(
  token: string,
  onUnauthorized: () => void,
): { state: GameState; send: (message: ClientMessage) => void; requestRank: () => void } {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${protocol}://${window.location.host}/ws?token=${encodeURIComponent(token)}`,
      );
      socketRef.current = socket;

      socket.onopen = () => dispatch({ type: 'socket_open' });
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        dispatch({ type: 'message', message, localTime: Date.now() });
      };
      socket.onclose = event => {
        dispatch({ type: 'socket_closed' });
        if (disposed) {
          return;
        }
        if (event.code === UNAUTHORIZED_CLOSE_CODE) {
          onUnauthorized();
          return;
        }
        retryTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };
    }

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, [token, onUnauthorized]);

  const send = useCallback((message: ClientMessage) => {
    dispatch({ type: 'request', message });
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  // Not dispatched as a request: it is not retried, and must not replace a pending bet.
  const requestRank = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      const message: TournamentRankRequestMessage = {
        type: 'tournament:rank',
        requestId: crypto.randomUUID(),
      };
      socket.send(JSON.stringify(message));
    }
  }, []);

  // After every (re)connect, resend the bet that got no answer, with the same requestId:
  // the server either finds it already placed or places it now, never twice.
  const pendingRef = useRef(state.pending);
  pendingRef.current = state.pending;
  useEffect(() => {
    const pending = pendingRef.current;
    const socket = socketRef.current;
    if (pending && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(pending.message));
    }
  }, [state.snapshots]);

  // The snapshot does not carry the player's tournament place, so ask for it after every (re)connect.
  useEffect(() => {
    if (state.snapshots > 0) {
      requestRank();
    }
  }, [state.snapshots, requestRank]);

  return { state, send, requestRank };
}
