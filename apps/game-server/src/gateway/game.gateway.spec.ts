import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';

import type { ServerMessage } from '@crash/contracts';
import { WebSocket } from 'ws';

import { BettingService } from '../betting/betting.service';
import { GameEvent } from '../game/game-loop';
import { crashTimeMs } from '../game/multiplier';
import { Round } from '../game/round';
import { InMemoryStore } from '../testing/in-memory-store';
import { createTestLogger } from '../testing/test-logger';
import { AuthService } from '../users/auth.service';
import { GameGateway, GatewayGame } from './game.gateway';

const STARTED_AT = 1_000_000;

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: ServerMessage[] = [];
  closeCode: number | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  close(code: number): void {
    this.closeCode = code;
    this.disconnect(code);
  }

  /** The connection ends, as `ws` reports it with the close code. */
  disconnect(code: number): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code);
  }

  receive(message: unknown): void {
    this.emit(
      'message',
      Buffer.from(typeof message === 'string' ? message : JSON.stringify(message)),
    );
  }

  last(): ServerMessage | undefined {
    return this.sent.at(-1);
  }
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function setup(crashPoint = 500) {
  const store = new InMemoryStore(() => STARTED_AT - 1_000);
  const auth = new AuthService(store);
  const listeners: ((event: GameEvent) => void)[] = [];
  const round = new Round('round-1', crashPoint);
  void store.create({ id: round.id, crashPoint, bettingEndsAt: STARTED_AT });
  const game: GatewayGame = {
    currentRound: round,
    subscribe: listener => listeners.push(listener),
    stop: jest.fn(() => Promise.resolve()),
    currentRoundView: () => ({
      id: round.id,
      phase: round.phase,
      bettingEndsAt: STARTED_AT,
      startedAt: round.phase === 'BETTING' ? null : STARTED_AT,
    }),
  };
  const { logger, events: logged } = createTestLogger();
  const betting = new BettingService(store, game, logger);
  const gateway = new GameGateway(auth, betting, game, logger);
  betting.onModuleInit();
  gateway.onModuleInit();

  function emitGameEvent(event: GameEvent) {
    listeners.forEach(listener => listener(event));
  }

  async function connect(username = 'alice'): Promise<FakeSocket> {
    const { token } = await auth.login(username);
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      {
        url: `/ws?token=${token}`,
      } as IncomingMessage,
    );
    await flush();

    return socket;
  }

  function userIdOf(username: string): string {
    const user = [...store.users.values()].find(candidate => candidate.username === username);
    if (!user) {
      throw new Error(`No user ${username} in test setup`);
    }
    return user.id;
  }

  return {
    store,
    round,
    game,
    gateway,
    auth,
    betting,
    logged,
    emitGameEvent,
    connect,
    userIdOf,
  };
}

describe('GameGateway', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('connection', () => {
    it.each([['/ws?token=unknown'], ['/ws']])('closes %s with 4401', async url => {
      const { gateway } = setup();
      const socket = new FakeSocket();

      gateway.handleConnection(socket as unknown as WebSocket, { url } as IncomingMessage);
      await flush();

      expect(socket.closeCode).toBe(4401);
      expect(socket.sent).toEqual([]);
    });

    it('sends a snapshot once the token is verified', async () => {
      const { connect } = setup();

      const socket = await connect('alice');

      expect(socket.sent).toEqual([
        {
          type: 'snapshot',
          serverTime: expect.any(Number),
          username: 'alice',
          balance: '5000',
          round: { id: 'round-1', phase: 'BETTING', bettingEndsAt: STARTED_AT, startedAt: null },
          bet: null,
        },
      ]);
    });

    it('includes the player bet in the current round after a reconnect', async () => {
      const { connect } = setup();
      const first = await connect('alice');
      first.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();

      const second = await connect('alice');

      expect(second.sent[0]).toMatchObject({
        type: 'snapshot',
        balance: '4900',
        bet: { amount: '100', status: 'ACTIVE', username: 'alice' },
      });
    });

    it('rejects messages sent before the snapshot', async () => {
      const { gateway, store } = setup();
      await store.findOrCreate('alice', '5000', 'token-alice');
      const socket = new FakeSocket();
      gateway.handleConnection(
        socket as unknown as WebSocket,
        {
          url: '/ws?token=token-alice',
        } as IncomingMessage,
      );

      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();

      expect(socket.sent[0]).toEqual({ type: 'error', requestId: 'r1', code: 'unauthorized' });
    });
  });

  describe('messages', () => {
    it.each([
      ['not json', undefined],
      [{ type: 'dance', requestId: 'r1' }, 'r1'],
      [{ type: 'bet' }, undefined],
      [{ type: 'bet', requestId: '' }, undefined],
      [{ type: 'bet', requestId: 'r'.repeat(65) }, undefined],
      [[1, 2], undefined],
    ])('answers %p with invalid_message', async (message, requestId) => {
      const { connect } = setup();
      const socket = await connect();

      socket.receive(message);
      await flush();

      expect(socket.last()).toEqual({
        type: 'error',
        code: 'invalid_message',
        ...(requestId ? { requestId } : {}),
      });
    });

    it('accepts a bet and returns the new balance', async () => {
      const { connect } = setup();
      const socket = await connect();

      socket.receive({ type: 'bet', requestId: 'r1', amount: '100', autoCashout: 200 });
      await flush();

      expect(socket.sent).toContainEqual({
        type: 'bet:accepted',
        requestId: 'r1',
        balance: '4900',
        bet: expect.objectContaining({ amount: '100', autoCashout: 200, username: 'alice' }),
      });
    });

    it('never exposes the internal user id', async () => {
      const { connect } = setup();
      const socket = await connect();

      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();

      expect(JSON.stringify(socket.sent)).not.toContain('userId');
    });

    it('returns validation errors per field', async () => {
      const { connect } = setup();
      const socket = await connect();

      socket.receive({ type: 'bet', requestId: 'r1', amount: '5000' });
      await flush();

      expect(socket.last()).toEqual({
        type: 'error',
        requestId: 'r1',
        code: 'validation_failed',
        errors: { amount: 'too_high' },
      });
    });

    it('cashes out at the multiplier when the message arrived', async () => {
      const { connect, round } = setup(500);
      const socket = await connect();
      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();
      round.start(STARTED_AT);

      jest.spyOn(Date, 'now').mockReturnValue(STARTED_AT + crashTimeMs(150));
      socket.receive({ type: 'cashout', requestId: 'r2' });
      await flush();

      expect(socket.sent).toContainEqual({
        type: 'cashout:accepted',
        requestId: 'r2',
        balance: '5050',
        bet: expect.objectContaining({
          status: 'CASHED_OUT',
          cashoutMultiplier: 150,
          payout: '150',
        }),
      });
    });

    it('reports a business error with its code', async () => {
      const { connect } = setup();
      const socket = await connect();

      socket.receive({ type: 'cashout', requestId: 'r1' });
      await flush();

      expect(socket.last()).toEqual({ type: 'error', requestId: 'r1', code: 'cashout_closed' });
    });
  });

  describe('message log', () => {
    it('logs an accepted bet with its business fields', async () => {
      const { connect, logged, userIdOf } = setup();
      const socket = await connect('alice');

      socket.receive({ type: 'bet', requestId: 'r1', amount: '100', autoCashout: 200 });
      await flush();

      const bet = socket.sent.find(message => message.type === 'bet:accepted');
      expect(logged('ws.message')).toEqual([
        expect.objectContaining({
          level: 'info',
          requestId: expect.any(String),
          clientRequestId: 'r1',
          connectionId: expect.any(String),
          userId: userIdOf('alice'),
          type: 'bet',
          roundId: 'round-1',
          roundPhase: 'BETTING',
          betId: bet?.type === 'bet:accepted' ? bet.bet.id : 'missing',
          amount: '100',
          autoCashout: 200,
          outcome: 'accepted',
          durationMs: expect.any(Number),
        }),
      ]);
    });

    it('logs a retried bet as replayed, under a new request id', async () => {
      const { connect, logged } = setup();
      const socket = await connect();

      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();
      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();

      const [first, retry] = logged('ws.message');
      expect([first?.outcome, retry?.outcome]).toEqual(['accepted', 'replayed']);
      expect(retry?.clientRequestId).toBe('r1');
      expect(retry?.requestId).not.toBe(first?.requestId);
    });

    it('logs a cashout with its multiplier and payout, in the phase it arrived', async () => {
      const { connect, round, logged } = setup(500);
      const socket = await connect();
      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();
      round.start(STARTED_AT);

      jest.spyOn(Date, 'now').mockReturnValue(STARTED_AT + crashTimeMs(150));
      socket.receive({ type: 'cashout', requestId: 'r2' });
      await flush();

      expect(logged('ws.message')[1]).toMatchObject({
        type: 'cashout',
        clientRequestId: 'r2',
        roundPhase: 'RUNNING',
        betId: expect.any(String),
        multiplier: 150,
        payout: '150',
        outcome: 'accepted',
      });
    });

    it('logs a repeated cashout as replayed', async () => {
      const { connect, round, logged } = setup(500);
      const socket = await connect();
      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();
      round.start(STARTED_AT);
      jest.spyOn(Date, 'now').mockReturnValue(STARTED_AT + crashTimeMs(150));

      socket.receive({ type: 'cashout', requestId: 'r2' });
      await flush();
      socket.receive({ type: 'cashout', requestId: 'r2' });
      await flush();

      expect(logged('ws.message').map(event => event.outcome)).toEqual([
        'accepted',
        'accepted',
        'replayed',
      ]);
    });

    it('logs a business error with its code as the outcome', async () => {
      const { connect, logged } = setup();
      const socket = await connect();

      socket.receive({ type: 'cashout', requestId: 'r1' });
      await flush();

      expect(logged('ws.message')).toEqual([
        expect.objectContaining({ level: 'info', type: 'cashout', outcome: 'cashout_closed' }),
      ]);
    });

    it('logs an invalid message', async () => {
      const { connect, logged } = setup();
      const socket = await connect();

      socket.receive({ type: 'dance', requestId: 'r1' });
      await flush();

      expect(logged('ws.message')).toEqual([
        expect.objectContaining({ clientRequestId: 'r1', outcome: 'invalid_message' }),
      ]);
    });

    it('logs a message sent before the snapshot', async () => {
      const { gateway, store, logged } = setup();
      await store.findOrCreate('alice', '5000', 'token-alice');
      const socket = new FakeSocket();
      gateway.handleConnection(
        socket as unknown as WebSocket,
        {
          url: '/ws?token=token-alice',
        } as IncomingMessage,
      );

      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();

      expect(logged('ws.message')[0]).toMatchObject({ outcome: 'unauthorized' });
      expect(logged('ws.message')[0]).not.toHaveProperty('userId');
    });

    it('logs an unexpected failure at error level', async () => {
      const { connect, betting, logged } = setup();
      const socket = await connect();
      jest.spyOn(betting, 'placeBet').mockRejectedValueOnce(new Error('boom'));

      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();

      expect(logged('ws.message')).toEqual([
        expect.objectContaining({
          level: 'error',
          outcome: 'internal_error',
          err: expect.objectContaining({ message: 'boom' }),
        }),
      ]);
    });

    it('never logs the token', async () => {
      const { connect, logged, store } = setup();
      const socket = await connect('alice');
      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();
      socket.disconnect(1000);

      const [user] = store.users.values();
      expect(JSON.stringify(logged())).not.toContain(user!.token);
    });
  });

  describe('connection log', () => {
    it('logs a closed connection with what happened on it', async () => {
      const { connect, logged, userIdOf } = setup();
      const socket = await connect('alice');
      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      socket.receive({ type: 'cashout', requestId: 'r2' });
      await flush();

      socket.disconnect(1001);

      expect(logged('ws.connection')).toEqual([
        expect.objectContaining({
          level: 'info',
          connectionId: logged('ws.message')[0]?.connectionId,
          userId: userIdOf('alice'),
          authOutcome: 'ok',
          closeCode: 1001,
          messagesReceived: 2,
          durationMs: expect.any(Number),
        }),
      ]);
    });

    it('gives every connection its own id', async () => {
      const { connect, logged } = setup();
      const first = await connect('alice');
      const second = await connect('bob');

      first.disconnect(1000);
      second.disconnect(1000);

      const [a, b] = logged('ws.connection');
      expect(a?.connectionId).not.toBe(b?.connectionId);
    });

    it('logs a connection rejected for an unknown token', async () => {
      const { gateway, logged } = setup();
      const socket = new FakeSocket();

      gateway.handleConnection(
        socket as unknown as WebSocket,
        {
          url: '/ws?token=unknown',
        } as IncomingMessage,
      );
      await flush();

      expect(logged('ws.connection')).toEqual([
        expect.objectContaining({ level: 'info', authOutcome: 'unauthorized', closeCode: 4401 }),
      ]);
      expect(logged('ws.connection')[0]).not.toHaveProperty('userId');
    });

    it('logs a failed authentication at error level', async () => {
      const { gateway, auth, logged } = setup();
      jest.spyOn(auth, 'authenticate').mockRejectedValueOnce(new Error('database down'));
      const socket = new FakeSocket();

      gateway.handleConnection(
        socket as unknown as WebSocket,
        {
          url: '/ws?token=any',
        } as IncomingMessage,
      );
      await flush();

      expect(logged('ws.connection')).toEqual([
        expect.objectContaining({
          level: 'error',
          authOutcome: 'error',
          closeCode: 4401,
          err: expect.objectContaining({ message: 'database down' }),
        }),
      ]);
    });

    it('logs a connection refused while shutting down', async () => {
      const { gateway, logged } = setup();
      await gateway.beforeApplicationShutdown();
      const socket = new FakeSocket();

      gateway.handleConnection(
        socket as unknown as WebSocket,
        {
          url: '/ws?token=any',
        } as IncomingMessage,
      );

      expect(logged('ws.connection')).toEqual([
        expect.objectContaining({ authOutcome: 'shutting_down', closeCode: 1012 }),
      ]);
    });
  });

  describe('broadcasts', () => {
    it('sends round events to every connected player', async () => {
      const { connect, emitGameEvent } = setup();
      const alice = await connect('alice');
      const bob = await connect('bob');

      emitGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 123 });

      const tick = { type: 'round:tick', roundId: 'round-1', multiplier: 123 };
      expect(alice.last()).toEqual(tick);
      expect(bob.last()).toEqual(tick);
    });

    it.each<[GameEvent, ServerMessage]>([
      [
        { type: 'betting', roundId: 'r', endsAt: 1 },
        { type: 'round:betting', roundId: 'r', endsAt: 1 },
      ],
      [
        { type: 'started', roundId: 'r', startedAt: 2 },
        { type: 'round:started', roundId: 'r', startedAt: 2 },
      ],
      [
        { type: 'crashed', roundId: 'r', crashPoint: 186, crashedAt: 3 },
        { type: 'round:crashed', roundId: 'r', crashPoint: 186, crashedAt: 3 },
      ],
    ])('maps %p to the public message', async (event, message) => {
      const { connect, emitGameEvent } = setup();
      const socket = await connect();

      emitGameEvent(event);

      expect(socket.last()).toEqual(message);
    });

    it('skips sockets that are not authenticated or already closing', async () => {
      const { connect, gateway, emitGameEvent } = setup();
      const closing = await connect('alice');
      closing.readyState = WebSocket.CLOSING;
      const pending = new FakeSocket();
      gateway.handleConnection(
        pending as unknown as WebSocket,
        {
          url: '/ws?token=never-checked-yet',
        } as IncomingMessage,
      );

      emitGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 123 });

      expect(closing.last()?.type).toBe('snapshot');
      expect(pending.sent).toEqual([]);
    });

    it('announces other players bets', async () => {
      const { connect } = setup();
      const alice = await connect('alice');
      const bob = await connect('bob');

      bob.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();

      expect(alice.last()).toEqual({
        type: 'bet:placed',
        bet: expect.objectContaining({ username: 'bob', amount: '100' }),
      });
    });

    it('sends the new balance only to the owner of an auto-cashout', async () => {
      const { connect, round, emitGameEvent } = setup(500);
      const alice = await connect('alice');
      const bob = await connect('bob');
      alice.receive({ type: 'bet', requestId: 'r1', amount: '100', autoCashout: 150 });
      await flush();
      round.start(STARTED_AT);

      emitGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 150 });
      await flush();

      expect(alice.sent).toContainEqual({ type: 'balance', balance: '5050' });
      expect(bob.sent).not.toContainEqual(expect.objectContaining({ type: 'balance' }));
      expect(bob.last()).toEqual({
        type: 'bet:cashed_out',
        bet: expect.objectContaining({ username: 'alice', cashoutMultiplier: 150 }),
      });
    });

    it('stops sending to a disconnected player', async () => {
      const { connect, gateway, emitGameEvent } = setup();
      const socket = await connect();
      gateway.handleDisconnect(socket as unknown as WebSocket);

      emitGameEvent({ type: 'tick', roundId: 'round-1', multiplier: 123 });

      expect(socket.last()?.type).toBe('snapshot');
    });
  });

  describe('refunds', () => {
    it('announces a refunded bet and sends the new balance to its owner only', async () => {
      const { connect, store, betting } = setup();
      const alice = await connect('alice');
      const bob = await connect('bob');
      alice.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();
      await store.create({ id: 'round-2', crashPoint: 200, bettingEndsAt: STARTED_AT });

      await betting.handleGameEvent({ type: 'betting', roundId: 'round-2', endsAt: STARTED_AT });

      expect(alice.sent).toContainEqual({ type: 'balance', balance: '5000' });
      expect(bob.last()).toEqual({
        type: 'bet:refunded',
        bet: expect.objectContaining({ username: 'alice', status: 'VOID' }),
      });
      expect(bob.sent).not.toContainEqual(expect.objectContaining({ type: 'balance' }));
    });
  });

  describe('shutdown', () => {
    it('stops the game loop before waiting for money operations', async () => {
      const { gateway, game, betting } = setup();
      const order: string[] = [];
      game.stop = () => {
        order.push('stop game');
        return Promise.resolve();
      };
      jest.spyOn(betting, 'drain').mockImplementation(() => {
        order.push('drain bets');
        return Promise.resolve();
      });

      await gateway.beforeApplicationShutdown();

      expect(order).toEqual(['stop game', 'drain bets']);
    });

    it('answers new requests with unavailable while shutting down', async () => {
      const { connect, gateway } = setup();
      const socket = await connect();
      const shuttingDown = gateway.beforeApplicationShutdown();

      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await shuttingDown;

      expect(socket.sent).toContainEqual({ type: 'error', requestId: 'r1', code: 'unavailable' });
    });

    it('waits for requests already in progress before closing sockets for a reconnect', async () => {
      const { connect, gateway, store } = setup();
      const socket = await connect();
      let finishWrite = () => undefined as void;
      const realPlaceBet = store.placeBet.bind(store);
      jest
        .spyOn(store, 'placeBet')
        .mockImplementationOnce(
          input => new Promise(resolve => (finishWrite = () => resolve(realPlaceBet(input)))),
        );
      socket.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();

      let closed = false;
      const shuttingDown = gateway.beforeApplicationShutdown().then(() => (closed = true));
      await flush();
      expect(closed).toBe(false);
      expect(socket.closeCode).toBeNull();

      finishWrite();
      await shuttingDown;

      expect(socket.sent).toContainEqual(expect.objectContaining({ type: 'bet:accepted' }));
      expect(socket.closeCode).toBe(1012);
    });

    it('logs the shutdown with the operations it waited for and the sockets it closed', async () => {
      const { connect, gateway, store, logged } = setup();
      const alice = await connect('alice');
      await connect('bob');
      let finishWrite = () => undefined as void;
      const realPlaceBet = store.placeBet.bind(store);
      jest
        .spyOn(store, 'placeBet')
        .mockImplementationOnce(
          input => new Promise(resolve => (finishWrite = () => resolve(realPlaceBet(input)))),
        );
      alice.receive({ type: 'bet', requestId: 'r1', amount: '100' });
      await flush();

      const shuttingDown = gateway.beforeApplicationShutdown();
      finishWrite();
      await shuttingDown;

      expect(logged('shutdown')).toEqual([
        expect.objectContaining({
          level: 'info',
          moneyOpsInFlight: 1,
          socketsClosed: 2,
          durationMs: expect.any(Number),
        }),
      ]);
    });

    it('logs a failed shutdown at error level', async () => {
      const { gateway, game, logged } = setup();
      game.stop = () => Promise.reject(new Error('stuck'));

      await expect(gateway.beforeApplicationShutdown()).rejects.toThrow('stuck');

      expect(logged('shutdown')).toEqual([
        expect.objectContaining({
          level: 'error',
          err: expect.objectContaining({ message: 'stuck' }),
        }),
      ]);
    });
  });
});
