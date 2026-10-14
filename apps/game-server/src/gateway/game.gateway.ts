import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';

import type { RoundView, ServerMessage } from '@crash/contracts';
import { BeforeApplicationShutdown, Inject, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { RawData, WebSocket } from 'ws';

import { BettingError } from '../betting/betting.errors';
import { BettingEvent, BettingService, GameSource } from '../betting/betting.service';
import { GameLoopService } from '../game/game-loop.service';
import { APP_LOGGER } from '../logging/logger';
import type { AppLogger } from '../logging/logger';
import { WideEvent } from '../logging/wide-event';
import { AuthService } from '../users/auth.service';
import { User } from '../users/user';
import { GatewayMetrics, RequestType, secondsSince } from './gateway.metrics';
import { ParsedClientMessage, parseClientMessage, toBetView, toRoundMessage } from './messages';

const UNAUTHORIZED_CLOSE_CODE = 4401;
// Standard WebSocket code "service restart": clients reconnect, e.g. to another instance.
const RESTART_CLOSE_CODE = 1012;

export interface GatewayGame extends GameSource {
  currentRoundView(): RoundView | null;
  stop(): Promise<void>;
}

interface Session {
  user: User | null;
  connectionId: string;
  messagesReceived: number;
  /** The connection log (ADR-0005), emitted when the socket closes. */
  log: WideEvent;
}

type ErrorMessage = Extract<ServerMessage, { type: 'error' }>;

/** How a client message was answered: the labels of its request duration. */
interface RequestResult {
  type: RequestType;
  /** `accepted`, `replayed` or the error code sent; the `outcome` of the ws.message log. */
  result: string;
}

/** WebSocket protocol from ADR-0003. Broadcasts one message per event, without batching. */
@WebSocketGateway({ path: '/ws' })
export class GameGateway
  implements
    OnGatewayConnection<WebSocket>,
    OnGatewayDisconnect<WebSocket>,
    OnModuleInit,
    BeforeApplicationShutdown
{
  private readonly sessions = new Map<WebSocket, Session>();
  private shuttingDown = false;

  constructor(
    private readonly auth: AuthService,
    private readonly betting: BettingService,
    @Inject(GameLoopService) private readonly game: GatewayGame,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    private readonly metrics: GatewayMetrics,
  ) {
    this.metrics.trackSockets(() => [...this.sessions.keys()]);
  }

  onModuleInit(): void {
    this.game.subscribe(event => this.broadcast(toRoundMessage(event)));
    this.betting.subscribe(event => this.handleBettingEvent(event));
  }

  /**
   * Runs before the database closes: stop taking requests, let the ones in progress finish,
   * then ask clients to reconnect. The next instance continues the round from the database.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.metrics.draining.set(1);
    const log = new WideEvent(this.logger, 'shutdown', {
      moneyOpsInFlight: this.betting.inFlightCount,
    });
    try {
      // The loop goes first, so no tick or settlement starts new money operations while draining.
      await this.game.stop();
      await this.betting.drain();

      const clients = [...this.sessions.keys()];
      for (const client of clients) {
        client.close(RESTART_CLOSE_CODE, 'restarting');
      }
      this.sessions.clear();
      log.set({ socketsClosed: clients.length });
    } catch (error) {
      log.fail(error);
      throw error;
    } finally {
      log.emit();
    }
  }

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    const connectionId = randomUUID();
    const session: Session = {
      user: null,
      connectionId,
      messagesReceived: 0,
      log: new WideEvent(this.logger, 'ws.connection', { connectionId, authOutcome: 'pending' }),
    };
    client.on('close', (code: number) => {
      session.log.set({ closeCode: code, messagesReceived: session.messagesReceived });
      session.log.emit();
    });

    if (this.shuttingDown) {
      session.log.set({ authOutcome: 'shutting_down' });
      client.close(RESTART_CLOSE_CODE, 'restarting');
      return;
    }

    this.sessions.set(client, session);
    client.on('message', (data: RawData) => {
      // Taken before any async work: the receipt time decides the cashout multiplier.
      const receivedAt = Date.now();
      const startedAt = performance.now();
      session.messagesReceived += 1;
      const round = this.game.currentRound;
      const log = new WideEvent(
        this.logger,
        'ws.message',
        {
          requestId: randomUUID(),
          connectionId,
          ...(session.user ? { userId: session.user.id } : {}),
          ...(round ? { roundId: round.id, roundPhase: round.phase } : {}),
        },
        startedAt,
      );
      void this.handleMessage(client, session, data, receivedAt, startedAt, log);
    });

    void this.authenticate(client, session, tokenFrom(request));
  }

  handleDisconnect(client: WebSocket): void {
    this.sessions.delete(client);
  }

  private async authenticate(
    client: WebSocket,
    session: Session,
    token: string | null,
  ): Promise<void> {
    try {
      const user = token ? await this.auth.authenticate(token) : null;
      if (!user) {
        session.log.set({ authOutcome: 'unauthorized' });
        this.sessions.delete(client);
        client.close(UNAUTHORIZED_CLOSE_CODE, 'unauthorized');
        return;
      }

      const round = this.game.currentRoundView();
      const bet = round ? await this.betting.findUserBet(user.id, round.id) : null;
      session.user = user;
      session.log.set({ authOutcome: 'ok', userId: user.id });
      this.send(client, {
        type: 'snapshot',
        serverTime: Date.now(),
        username: user.username,
        balance: user.balance,
        round,
        bet: bet ? toBetView(bet) : null,
      });
    } catch (error) {
      session.log.set({ authOutcome: 'error' });
      session.log.fail(error);
      this.sessions.delete(client);
      client.close(UNAUTHORIZED_CLOSE_CODE, 'unauthorized');
    }
  }

  private async handleMessage(
    client: WebSocket,
    session: Session,
    data: RawData,
    receivedAt: number,
    startedAt: number,
    log: WideEvent,
  ): Promise<void> {
    try {
      const { type, result } = await this.respond(client, session, data, receivedAt, log);
      this.metrics.requestDuration.observe({ type, result }, secondsSince(startedAt));
    } finally {
      log.emit();
    }
  }

  private async respond(
    client: WebSocket,
    session: Session,
    data: RawData,
    receivedAt: number,
    log: WideEvent,
  ): Promise<RequestResult> {
    const parsed = parseClientMessage(data);
    if (!parsed.ok) {
      if (parsed.requestId) {
        log.set({ clientRequestId: parsed.requestId });
      }
      return this.sendError(client, log, 'invalid', {
        type: 'error',
        code: 'invalid_message',
        ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
      });
    }

    const { message } = parsed;
    log.set({ type: message.type, clientRequestId: message.requestId });
    if (this.shuttingDown) {
      return this.sendError(client, log, message.type, {
        type: 'error',
        requestId: message.requestId,
        code: 'unavailable',
      });
    }

    if (!session.user) {
      return this.sendError(client, log, message.type, {
        type: 'error',
        requestId: message.requestId,
        code: 'unauthorized',
      });
    }

    try {
      const { response, outcome } = await this.execute(session.user, message, receivedAt, log);
      log.set({ outcome });
      this.send(client, response);
      return { type: message.type, result: outcome };
    } catch (error) {
      if (error instanceof BettingError) {
        return this.sendError(client, log, message.type, {
          type: 'error',
          requestId: message.requestId,
          code: error.code,
          ...(error.errors ? { errors: error.errors } : {}),
        });
      }

      log.fail(error);
      return this.sendError(client, log, message.type, {
        type: 'error',
        requestId: message.requestId,
        code: 'internal_error',
      });
    }
  }

  private async execute(
    user: User,
    message: ParsedClientMessage,
    receivedAt: number,
    log: WideEvent,
  ): Promise<{ response: ServerMessage; outcome: 'accepted' | 'replayed' }> {
    if (message.type === 'cashout') {
      const { bet, balance, replayed } = await this.betting.cashOut(user, receivedAt);
      log.set({
        betId: bet.id,
        amount: bet.amount,
        multiplier: bet.cashoutMultiplier,
        payout: bet.payout,
      });
      return {
        response: {
          type: 'cashout:accepted',
          requestId: message.requestId,
          bet: toBetView(bet),
          balance,
        },
        outcome: replayed ? 'replayed' : 'accepted',
      };
    }

    const { bet, balance, replayed } = await this.betting.placeBet(user, message);
    log.set({ betId: bet.id, amount: bet.amount, autoCashout: bet.autoCashout });
    return {
      response: {
        type: 'bet:accepted',
        requestId: message.requestId,
        bet: toBetView(bet),
        balance,
      },
      outcome: replayed ? 'replayed' : 'accepted',
    };
  }

  private sendError(
    client: WebSocket,
    log: WideEvent,
    type: RequestType,
    message: ErrorMessage,
  ): RequestResult {
    log.set({ outcome: message.code });
    this.send(client, message);
    return { type, result: message.code };
  }

  private handleBettingEvent(event: BettingEvent): void {
    const bet = toBetView(event.bet);
    switch (event.type) {
      case 'bet_placed':
        this.broadcast({ type: 'bet:placed', bet });
        return;
      case 'cashed_out':
        this.broadcast({ type: 'bet:cashed_out', bet });
        this.sendBalance(event.bet.userId, event.balance);
        return;
      case 'refunded':
        this.broadcast({ type: 'bet:refunded', bet });
        this.sendBalance(event.bet.userId, event.balance);
        return;
    }
  }

  private sendBalance(userId: string, balance: string): void {
    for (const [client, session] of this.sessions) {
      if (session.user?.id === userId) {
        this.send(client, { type: 'balance', balance });
      }
    }
  }

  private broadcast(message: ServerMessage): void {
    const startedAt = performance.now();
    const data = JSON.stringify(message);
    for (const [client, session] of this.sessions) {
      if (session.user && client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
    this.metrics.broadcastDuration.observe({ type: message.type }, secondsSince(startedAt));
  }

  private send(client: WebSocket, message: ServerMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
}

function tokenFrom(request: IncomingMessage): string | null {
  return new URL(request.url ?? '', 'http://localhost').searchParams.get('token');
}
