import { EventEmitter } from 'node:events';

import type { ClientMessage, ServerMessage } from '@crash/contracts';

import { BotConnection, BotSocket, ConnectionRecorder, RECONNECT_DELAY_MS } from './bot-connection';

const OPEN = 1;
const CLOSED = 3;

class FakeSocket extends EventEmitter implements BotSocket {
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  closedWith: number | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(code?: number): void {
    this.closedWith = code ?? null;
    this.serverClose(code ?? 1005);
  }

  open(): void {
    this.readyState = OPEN;
    this.emit('open');
  }

  receive(message: ServerMessage): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  serverClose(code: number): void {
    this.readyState = CLOSED;
    this.emit('close', code);
  }
}

class FakeRecorder implements ConnectionRecorder {
  readonly events: string[] = [];
  connected(durationMs: number): void {
    this.events.push(`connected ${durationMs}`);
  }
  connectionFailed(stage: string): void {
    this.events.push(`failed ${stage}`);
  }
  disconnected(code: number): void {
    this.events.push(`disconnected ${code}`);
  }
}

function snapshot(phase: 'BETTING' | 'RUNNING' = 'RUNNING'): ServerMessage {
  return {
    type: 'snapshot',
    serverTime: 0,
    username: 'bot_abc_1',
    balance: '5000',
    round: { id: 'round-1', phase, bettingEndsAt: 10_000, startedAt: null },
    bet: null,
  };
}

function setup(login: (username: string) => Promise<string> = () => Promise.resolve('token-1')) {
  jest.useFakeTimers({ now: 0 });
  const sockets: FakeSocket[] = [];
  const tokens: string[] = [];
  const handled: ServerMessage[] = [];
  let disconnects = 0;
  const recorder = new FakeRecorder();
  const loginSpy = jest.fn(login);
  const connection = new BotConnection({
    username: 'bot_abc_1',
    login: loginSpy,
    openSocket: token => {
      tokens.push(token);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    createBot: () => ({
      handle: message => handled.push(message),
      disconnected: () => (disconnects += 1),
    }),
    recorder,
    now: () => Date.now(),
  });

  return {
    connection,
    sockets,
    tokens,
    handled,
    recorder,
    loginSpy,
    disconnects: () => disconnects,
    socket: () => sockets.at(-1)!,
  };
}

async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

describe('BotConnection', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('logs in with its username and connects with the token', async () => {
    const { connection, loginSpy, tokens } = setup();

    await connection.start();

    expect(loginSpy).toHaveBeenCalledWith('bot_abc_1');
    expect(tokens).toEqual(['token-1']);
  });

  it('counts as connected from the first snapshot, and records how long it took', async () => {
    const { connection, socket, recorder } = setup();
    await connection.start();
    socket().open();
    expect(connection.connected).toBe(false);

    jest.advanceTimersByTime(40);
    socket().receive(snapshot());

    expect(connection.connected).toBe(true);
    expect(recorder.events).toEqual(['connected 40']);
  });

  it('passes every server message to its bot', async () => {
    const { connection, socket, handled } = setup();
    await connection.start();
    socket().open();

    socket().receive(snapshot());
    socket().receive({ type: 'round:tick', roundId: 'round-1', multiplier: 150 });

    expect(handled.map(message => message.type)).toEqual(['snapshot', 'round:tick']);
  });

  it('sends what its bot sends while the socket is open', async () => {
    const sent: ClientMessage[] = [];
    jest.useFakeTimers({ now: 0 });
    const socket = new FakeSocket();
    let botSend: (message: ClientMessage) => void = () => undefined;
    const connection = new BotConnection({
      username: 'bot_abc_1',
      login: () => Promise.resolve('token-1'),
      openSocket: () => socket,
      createBot: send => {
        botSend = send;
        return { handle: () => undefined, disconnected: () => undefined };
      },
      recorder: new FakeRecorder(),
      now: () => Date.now(),
    });
    await connection.start();

    botSend({ type: 'cashout', requestId: 'early' });
    socket.open();
    botSend({ type: 'cashout', requestId: 'r1' });
    sent.push(...socket.sent);

    expect(sent).toEqual([{ type: 'cashout', requestId: 'r1' }]);
  });

  it('reconnects with the same token after a restart close, without logging in again', async () => {
    const { connection, socket, tokens, loginSpy, recorder, disconnects } = setup();
    await connection.start();
    socket().open();
    socket().receive(snapshot());

    socket().serverClose(1012);
    expect(connection.connected).toBe(false);
    expect(disconnects()).toBe(1);

    await jest.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(tokens).toEqual(['token-1', 'token-1']);
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(recorder.events).toContain('disconnected 1012');
  });

  it('keeps retrying while the server is down', async () => {
    const { connection, sockets, recorder } = setup();
    await connection.start();
    sockets[0]!.serverClose(1006);

    await jest.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    sockets[1]!.serverClose(1006);
    await jest.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(sockets).toHaveLength(3);
    expect(recorder.events).toEqual(['failed socket', 'failed socket']);
  });

  it('gives up after the server rejects its token', async () => {
    const { connection, socket, sockets } = setup();
    await connection.start();
    socket().open();

    socket().serverClose(4401);
    await jest.advanceTimersByTimeAsync(10 * RECONNECT_DELAY_MS);

    expect(sockets).toHaveLength(1);
  });

  it('records a failed login and never opens a socket', async () => {
    const { connection, sockets, recorder } = setup(() => Promise.reject(new Error('refused')));

    await connection.start();

    expect(sockets).toEqual([]);
    expect(recorder.events).toEqual(['failed login']);
    expect(connection.connected).toBe(false);
  });

  it('closes on stop and does not reconnect', async () => {
    const { connection, socket, sockets, recorder } = setup();
    await connection.start();
    socket().open();
    socket().receive(snapshot());

    connection.stop();
    await jest.advanceTimersByTimeAsync(10 * RECONNECT_DELAY_MS);

    expect(socket().closedWith).toBe(1000);
    expect(sockets).toHaveLength(1);
    expect(connection.connected).toBe(false);
    expect(recorder.events).toEqual(['connected 0']);
  });

  it('does not connect when stopped while logging in', async () => {
    let finishLogin: (token: string) => void = () => undefined;
    const { connection, sockets } = setup(
      () => new Promise<string>(resolve => (finishLogin = resolve)),
    );
    const starting = connection.start();

    connection.stop();
    finishLogin('token-1');
    await starting;
    await flush();

    expect(sockets).toEqual([]);
  });
});
