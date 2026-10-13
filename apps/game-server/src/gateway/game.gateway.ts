import { IncomingMessage } from 'node:http';

import type { RoundView, ServerMessage } from '@crash/contracts';
import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { RawData, WebSocket } from 'ws';

import { BettingError } from '../betting/betting.errors';
import { BettingEvent, BettingService, GameSource } from '../betting/betting.service';
import { GameLoopService } from '../game/game-loop.service';
import { AuthService } from '../users/auth.service';
import { User } from '../users/user';
import { ParsedClientMessage, parseClientMessage, toBetView, toRoundMessage } from './messages';

const UNAUTHORIZED_CLOSE_CODE = 4401;

export interface GatewayGame extends GameSource {
  currentRoundView(): RoundView | null;
}

interface Session {
  user: User | null;
}

/** WebSocket protocol from ADR-0003. Broadcasts one message per event, without batching. */
@WebSocketGateway({ path: '/ws' })
export class GameGateway
  implements OnGatewayConnection<WebSocket>, OnGatewayDisconnect<WebSocket>, OnModuleInit
{
  private readonly logger = new Logger(GameGateway.name);
  private readonly sessions = new Map<WebSocket, Session>();

  constructor(
    private readonly auth: AuthService,
    private readonly betting: BettingService,
    @Inject(GameLoopService) private readonly game: GatewayGame,
  ) {}

  onModuleInit(): void {
    this.game.subscribe(event => this.broadcast(toRoundMessage(event)));
    this.betting.subscribe(event => this.handleBettingEvent(event));
  }

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    const session: Session = { user: null };
    this.sessions.set(client, session);
    client.on('message', (data: RawData) => {
      // Taken before any async work: the receipt time decides the cashout multiplier.
      const receivedAt = Date.now();
      void this.handleMessage(client, session, data, receivedAt);
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
        this.sessions.delete(client);
        client.close(UNAUTHORIZED_CLOSE_CODE, 'unauthorized');
        return;
      }

      const round = this.game.currentRoundView();
      const bet = round ? await this.betting.findUserBet(user.id, round.id) : null;
      session.user = user;
      this.send(client, {
        type: 'snapshot',
        serverTime: Date.now(),
        username: user.username,
        balance: user.balance,
        round,
        bet: bet ? toBetView(bet) : null,
      });
    } catch (error) {
      this.logger.error({ message: 'Failed to authenticate socket', error });
      this.sessions.delete(client);
      client.close(UNAUTHORIZED_CLOSE_CODE, 'unauthorized');
    }
  }

  private async handleMessage(
    client: WebSocket,
    session: Session,
    data: RawData,
    receivedAt: number,
  ) {
    const parsed = parseClientMessage(data);
    if (!parsed.ok) {
      this.send(client, {
        type: 'error',
        code: 'invalid_message',
        ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
      });
      return;
    }

    const { message } = parsed;
    if (!session.user) {
      this.send(client, { type: 'error', requestId: message.requestId, code: 'unauthorized' });
      return;
    }

    try {
      this.send(client, await this.execute(session.user, message, receivedAt));
    } catch (error) {
      if (error instanceof BettingError) {
        this.send(client, {
          type: 'error',
          requestId: message.requestId,
          code: error.code,
          ...(error.errors ? { errors: error.errors } : {}),
        });
        return;
      }

      this.logger.error({ message: 'Failed to handle client message', type: message.type, error });
      this.send(client, { type: 'error', requestId: message.requestId, code: 'internal_error' });
    }
  }

  private async execute(
    user: User,
    message: ParsedClientMessage,
    receivedAt: number,
  ): Promise<ServerMessage> {
    if (message.type === 'cashout') {
      const { bet, balance } = await this.betting.cashOut(user, receivedAt);
      return {
        type: 'cashout:accepted',
        requestId: message.requestId,
        bet: toBetView(bet),
        balance,
      };
    }

    const { bet, balance } = await this.betting.placeBet(user, message);
    return { type: 'bet:accepted', requestId: message.requestId, bet: toBetView(bet), balance };
  }

  private handleBettingEvent(event: BettingEvent): void {
    if (event.type === 'bet_placed') {
      this.broadcast({ type: 'bet:placed', bet: toBetView(event.bet) });
      return;
    }

    this.broadcast({ type: 'bet:cashed_out', bet: toBetView(event.bet) });
    for (const [client, session] of this.sessions) {
      if (session.user?.id === event.bet.userId) {
        this.send(client, { type: 'balance', balance: event.balance });
      }
    }
  }

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const [client, session] of this.sessions) {
      if (session.user && client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
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
