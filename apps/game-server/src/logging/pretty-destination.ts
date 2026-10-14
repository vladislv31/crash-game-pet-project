import type { WriteStream } from 'node:tty';

import type { DestinationStream } from 'pino';
import { PinoPretty } from 'pino-pretty';

/**
 * Human-readable output for a terminal: the event name first, one field per line, without the
 * service fields that repeat on every line. Pipes and files keep getting JSON (ADR-0005).
 */
export function prettyDestination(
  destination: NodeJS.WritableStream = process.stdout,
): DestinationStream {
  return PinoPretty({
    destination,
    sync: true,
    // pino-pretty would decide by process.stdout; only a terminal it writes to should get colours.
    colorize: (destination as Partial<WriteStream>).isTTY === true,
    timestampKey: 'timestamp',
    // As a stream, pino-pretty takes the message key from the logger, so the event name is formatted in.
    messageFormat: '{event}',
    translateTime: 'SYS:HH:MM:ss.l',
    ignore: 'event,service,serviceVersion,commitHash,region,instanceId',
  });
}
