import { randomUUID } from 'node:crypto';

import { pino } from 'pino';
import type { DestinationStream, Logger } from 'pino';

/** Same event format as the game server (ADR-0005), so both are read with the same tools. */
export function createLogger(env: NodeJS.ProcessEnv, destination: DestinationStream): Logger {
  return pino(
    {
      base: {
        service: 'load-generator',
        serviceVersion: env.npm_package_version ?? 'unknown',
        commitHash: env.COMMIT_HASH ?? 'unknown',
        region: env.REGION ?? 'local',
        instanceId: randomUUID(),
      },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: label => ({ level: label }) },
      serializers: { err: serializeError },
    },
    destination,
  );
}

export function stdoutDestination(): DestinationStream {
  return pino.destination({ dest: 1, sync: true });
}

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
