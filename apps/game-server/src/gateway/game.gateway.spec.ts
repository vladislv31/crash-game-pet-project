import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';

import type { ServerMessage } from '@crash/contracts';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';

import { BettingService } from '../betting/betting.service';
import { GameEvent } from '../game/game-loop';
import { crashTimeMs } from '../game/multiplier';
import { Round } from '../game/round';
import { InMemoryStore } from '../testing/in-memory-store';
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
    this.readyState = WebSocket.CLOSED;
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
  const betting = new BettingService(store, game);
  const gateway = new GameGateway(auth, betting, game);
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

  return { store, round, game, gateway, betting, emitGameEvent, connect };
}

describe('GameGateway', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
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
  });
});
