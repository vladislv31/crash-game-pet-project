import { AppLogger, createLogger } from '../logging/logger';

export type LoggedEvent = Record<string, unknown>;

/** The real JSON logger writing to memory, so tests assert on the events as they would be logged. */
export function createTestLogger(): {
  logger: AppLogger;
  events: (name?: string) => LoggedEvent[];
} {
  const lines: string[] = [];
  const logger = createLogger({}, { write: (line: string) => void lines.push(line) });

  function events(name?: string): LoggedEvent[] {
    const all = lines.map(line => JSON.parse(line) as LoggedEvent);
    return name ? all.filter(event => event.event === name) : all;
  }

  return { logger, events };
}
