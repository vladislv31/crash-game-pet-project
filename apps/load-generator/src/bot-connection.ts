import type { ClientMessage, ServerMessage } from '@crash/contracts';

import type { ConnectionStage } from './metrics';

export const RECONNECT_DELAY_MS = 1_000;

const OPEN = 1;
const NORMAL_CLOSE_CODE = 1000;
const UNAUTHORIZED_CLOSE_CODE = 4401;

/** The part of a `ws` WebSocket a bot uses. */
export interface BotSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: Buffer | string) => void): this;
  on(event: 'close', listener: (code: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface ConnectionRecorder {
  connected(durationMs: number): void;
  connectionFailed(stage: ConnectionStage): void;
  disconnected(code: number): void;
}

export interface BotBrain {
  handle(message: ServerMessage): void;
  disconnected(): void;
}

export interface BotConnectionDeps {
  username: string;
  /** Logs in and returns the token. */
  login: (username: string) => Promise<string>;
  openSocket: (token: string) => BotSocket;
  createBot: (send: (message: ClientMessage) => void) => BotBrain;
  recorder: ConnectionRecorder;
  now: () => number;
}

/** Carries one bot's messages over a WebSocket and keeps it connected (ADR-0008). */
export class BotConnection {
  private readonly bot: BotBrain;
  private socket: BotSocket | null = null;
  private token: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private isConnected = false;

  constructor(private readonly deps: BotConnectionDeps) {
    this.bot = deps.createBot(message => this.send(message));
  }

  /** Connected from the first snapshot until the socket closes. */
  get connected(): boolean {
    return this.isConnected;
  }

  async start(): Promise<void> {
    try {
      this.token = await this.deps.login(this.deps.username);
    } catch {
      this.deps.recorder.connectionFailed('login');
      return;
    }
    if (!this.stopped) {
      this.connect();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(NORMAL_CLOSE_CODE);
  }

  private connect(): void {
    if (this.token === null) {
      return;
    }
    const startedAt = this.deps.now();
    const socket = this.deps.openSocket(this.token);
    this.socket = socket;
    let opened = false;
    let snapshotSeen = false;

    socket.on('open', () => (opened = true));
    // `ws` reports a failed connection as an error followed by a close; the close handles it.
    socket.on('error', () => undefined);
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type === 'snapshot' && !snapshotSeen) {
        snapshotSeen = true;
        this.isConnected = true;
        this.deps.recorder.connected(this.deps.now() - startedAt);
      }
      this.bot.handle(message);
    });
    socket.on('close', code => {
      this.isConnected = false;
      this.bot.disconnected();
      if (this.stopped || code === UNAUTHORIZED_CLOSE_CODE) {
        return;
      }
      if (opened) {
        this.deps.recorder.disconnected(code);
      } else {
        this.deps.recorder.connectionFailed('socket');
      }
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
