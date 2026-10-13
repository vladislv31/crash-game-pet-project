import { randomUUID } from 'node:crypto';

import { pino } from 'pino';
import type { DestinationStream, Logger } from 'pino';

export type AppLogger = Logger;

export const APP_LOGGER = Symbol('APP_LOGGER');

/** JSON logger from ADR-0005: one line per event, with the fields that identify the service instance. */
export function createLogger(env: NodeJS.ProcessEnv, destination: DestinationStream): AppLogger {
  return pino(
    {
      base: {
        service: 'game-server',
        serviceVersion: env.npm_package_version ?? 'unknown',
        commitHash: env.COMMIT_HASH ?? 'unknown',
        region: env.REGION ?? 'local',
        instanceId: randomUUID(),
      },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: label => ({ level: label }) },
      serializers: { err: serializeError },
      redact: { paths: ['token', '*.token'], remove: true },
    },
    destination,
  );
}

/** Synchronous stdout, so lines are not lost when the process is killed (experiment 3). */
export function stdoutDestination(): DestinationStream {
  return pino.destination({ dest: 1, sync: true });
}

/** Database errors carry the query and its parameters (tokens included), so only these fields are kept. */
function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const { code } = error as { code?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    stack: error.stack,
  };
}
