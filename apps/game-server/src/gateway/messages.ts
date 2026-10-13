import type { BetView, ServerMessage } from '@crash/contracts';
import type { RawData } from 'ws';

import { Bet } from '../betting/bet';
import { GameEvent } from '../game/game-loop';

const MAX_REQUEST_ID_LENGTH = 64;

export type ParsedClientMessage =
  | { type: 'bet'; requestId: string; amount: unknown; autoCashout: unknown }
  | { type: 'cashout'; requestId: string };

export type ParseResult =
  { ok: true; message: ParsedClientMessage } | { ok: false; requestId?: string };

export function parseClientMessage(data: RawData): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawToString(data));
  } catch {
    return { ok: false };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false };
  }

  const message = parsed as Record<string, unknown>;
  const { requestId } = message;
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    requestId.length > MAX_REQUEST_ID_LENGTH
  ) {
    return { ok: false };
  }

  switch (message.type) {
    case 'bet':
      return {
        ok: true,
        message: {
          type: 'bet',
          requestId,
          amount: message.amount,
          autoCashout: message.autoCashout,
        },
      };
    case 'cashout':
      return { ok: true, message: { type: 'cashout', requestId } };
    default:
      return { ok: false, requestId };
  }
}

export function toBetView(bet: Bet): BetView {
  return {
    id: bet.id,
    roundId: bet.roundId,
    username: bet.username,
    amount: bet.amount,
    autoCashout: bet.autoCashout,
    status: bet.status,
    cashoutMultiplier: bet.cashoutMultiplier,
    payout: bet.payout,
  };
}

/** Maps internal game events to public messages; only `round:crashed` reveals the crash point. */
export function toRoundMessage(event: GameEvent): ServerMessage {
  switch (event.type) {
    case 'betting':
      return { type: 'round:betting', roundId: event.roundId, endsAt: event.endsAt };
    case 'started':
      return { type: 'round:started', roundId: event.roundId, startedAt: event.startedAt };
    case 'tick':
      return { type: 'round:tick', roundId: event.roundId, multiplier: event.multiplier };
    case 'crashed':
      return {
        type: 'round:crashed',
        roundId: event.roundId,
        crashPoint: event.crashPoint,
        crashedAt: event.crashedAt,
      };
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString('utf8');
  }

  return data.toString('utf8');
}
