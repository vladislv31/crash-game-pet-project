# 0003. WebSocket protocol and auth

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Players need live round updates and a way to bet and cash out. The protocol must be simple to load-test, and the first version should be deliberately unoptimized, so later experiments can measure what optimizations bring.

## Decision

### Transport

- `@nestjs/websockets` gateway with `@nestjs/platform-ws` (raw `ws`, no Socket.IO), path `/ws`, same port as HTTP.
- The gateway reads raw `message` events itself instead of `@SubscribeMessage`, so the server timestamps each message at receipt (ADR-0002: cashout validity uses server receipt time).

### Fake auth

- `POST /auth/login { username }` → `{ token, username, balance }`. Username: 3–20 chars, `[a-zA-Z0-9_]`. Invalid → HTTP 422 `{ errors: { username: 'invalid' } }`.
- First login creates the user with the starting balance and a random token (32 bytes, hex). Later logins return the same token. No passwords.
- WebSocket: `ws://host/ws?token=…`. An unknown token closes the socket with code `4401`. The server sends `snapshot` once the token is verified; the client waits for it before sending anything.

### Messages

JSON objects with a `type` field. Types live in `packages/contracts` (type-only `index.d.ts`, so every app imports it without a build step and without crossing `rootDir`).

Client → server: `bet { requestId, amount, autoCashout? }`, `cashout { requestId }`.

Server → one client:

- `snapshot`: current round, own bet in it, balance
- `bet:accepted`, `cashout:accepted` (with the same `requestId`)
- `error { requestId?, code, errors? }`; validation errors use `code: 'validation_failed'` and `errors: { field: 'errorKey' }`, the same shape as HTTP 422

Server → all clients, **one message per event, no batching** (baseline for experiment 1):

- `round:betting`, `round:started`, `round:tick`, `round:crashed`
- `bet:placed`, `bet:cashed_out` (other players' activity)

The crash point is sent only in `round:crashed`.

### Units

- Multipliers and crash points: integers in hundredths (`198` = 1.98x).
- Money: decimal strings (`"100.5"`).

### Client rendering

The client computes the curve locally from `startedAt` with the same formula; ticks correct drift.

## Alternatives

- **Nest message format** `{ event, data }` with `@SubscribeMessage`: less code, but the receipt timestamp is taken later, after Nest's routing.
- **Socket.IO**: rooms, acks and reconnects built in, but extra protocol overhead hides what the experiments should measure.
- **Batched broadcasts**: fewer frames under load. Postponed on purpose to measure the difference later.

## Consequences

- Broadcast cost grows as `events × clients`. Expected to be the first bottleneck in experiment 1.
- Token in the query string can end up in proxy logs. Acceptable for fake auth.
