import { randomBytes, randomUUID } from 'node:crypto';

import type { LoginResponse } from '@crash/contracts';
import { WebSocket } from 'ws';

import { Bot, BotRecorder } from './bot';
import { BotConnection } from './bot-connection';
import { LiveStats } from './live-stats';
import { GrafanaAnnotator } from './grafana-annotator';
import { createLogger, stdoutDestination } from './logger';
import { GeneratorMetrics } from './metrics';
import { RunController } from './run-controller';
import { createApiServer } from './server';

const LIVE_WINDOW_MS = 10_000;

const gameServer = new URL(process.env.GAME_SERVER_URL ?? 'http://localhost:3000');
const port = Number(process.env.PORT ?? 3100);
const grafana = new URL(process.env.GRAFANA_URL ?? 'http://localhost:3001');
const logger = createLogger(process.env, stdoutDestination());
// Epoch milliseconds with sub-millisecond precision: comparable with the server's round times.
const now = () => performance.timeOrigin + performance.now();

const metrics = new GeneratorMetrics();
const live = new LiveStats(now, LIVE_WINDOW_MS);
const recorder: BotRecorder = {
  request: (type, result, latencyMs) => {
    metrics.request(type, result, latencyMs);
    live.request(type, result, latencyMs);
  },
  tick: jitterMs => metrics.tick(jitterMs),
};

async function login(username: string): Promise<string> {
  const response = await fetch(new URL('/auth/login', gameServer), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!response.ok) {
    throw new Error(`Login failed with ${response.status}`);
  }
  return ((await response.json()) as LoginResponse).token;
}

function openSocket(token: string): WebSocket {
  const url = new URL(`/ws?token=${encodeURIComponent(token)}`, gameServer);
  url.protocol = gameServer.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(url);
}

const runs = new RunController({
  createConnection: (username, botRecorder, scenario) =>
    new BotConnection({
      username,
      login,
      openSocket,
      createBot: send =>
        new Bot({
          scenario,
          random: Math.random,
          now,
          schedule: (at, action) => {
            const timer = setTimeout(action, Math.max(0, at - now()));
            return () => clearTimeout(timer);
          },
          send,
          newRequestId: randomUUID,
          recorder: botRecorder,
        }),
      recorder: metrics,
      now,
    }),
  recorder,
  newRunId: () => randomBytes(3).toString('hex'),
  now,
  logger,
  annotator: new GrafanaAnnotator({ url: grafana, fetch, now: Date.now, logger }),
});
metrics.trackBots(() => runs.botCounts());

const server = createApiServer(
  {
    runs,
    live,
    metrics: async () => ({
      contentType: metrics.registry.contentType,
      body: await metrics.registry.metrics(),
    }),
  },
  () => ({ run: runs.status(), live: live.summary() }),
  logger,
);
server.listen(port, () => {
  logger.info({ event: 'startup', port, gameServer: gameServer.origin, outcome: 'ok' });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    runs.stop();
    server.close();
    server.closeAllConnections();
  });
}
