# 0005. Structured logging with wide events

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The server logs with Nest's default text `ConsoleLogger`. Successful bets and cashouts leave no trace; only background failures are logged, and every game event is logged, including ten ticks per second. Text lines cannot be filtered by user or outcome, carry no version or instance, and raw database errors can leak query parameters (a token from `findByToken`).

Metrics (ADR-0006) answer "how many and how fast". The experiments also need to answer "what happened to this request or round":

- experiment 1: which requests are slow when p99 grows (type, phase, retry or not);
- experiment 3: which requests were in flight when an instance stopped, how long draining took, how the next instance recovered;
- experiment 4: which of the concurrent cashouts paid and which got the original result back;
- Phase 5: events from several instances must be told apart and joined.

The global instructions require one structured JSON wide event per request, with a fixed set of fields.

## Decision

### Logger

- **pino**, one instance provided by a global `LoggingModule` (`APP_LOGGER`) and injected where needed. `main.ts` creates the app with `bufferLogs` and hands Nest a small `LoggerService` adapter over the same instance, so Nest's own logs are JSON too.
- Output: **stdout only**, written synchronously, so `kill -9` in experiment 3 does not lose buffered lines. Where logs go is the environment's job: a terminal, a file for an experiment (`> logs/run.jsonl`), container logs in Phase 5.
- Development: `start:dev` pipes through `pino-pretty` (a dev dependency, not a pino transport, so no worker thread in the app): one line per event, the event name first.
- Two levels: `info` and `error`. Nest's `warn` maps to `info`, `error` and `fatal` to `error`. Its `log` messages (modules loaded, routes mapped) are dropped along with `debug` and `verbose`: the `startup` event already says the app is up.

### Common fields

Every event: `timestamp` (UTC ISO-8601), `level`, `event` (event name), `service` (`game-server`), `serviceVersion` (package.json version, as npm passes it in `npm_package_version`; `unknown` when started without npm), `commitHash` (`COMMIT_HASH`, default `unknown`), `region` (`REGION`, default `local`), `instanceId` (random per process, so restarts and Phase 5 instances are told apart). Field names are camelCase.

### Wide events

Each unit of work builds one event and emits it once at its end, including on failure; a failure logs it at `error` level with the first error attached. `durationMs` is rounded to hundredths of a millisecond; points in time (`bettingEndsAt`, `startedAt`, `crashedAt`) are UTC ISO-8601 strings, like `timestamp`. Multipliers stay in hundredths, as in the protocol and the database. The layer that owns timing and emission (gateway, HTTP middleware, loop, sweep) creates the event; handlers only add business fields, mostly taken from their results.

| `event`         | When                                                 | Fields beyond the common ones                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws.message`    | every client message                                 | `requestId`, `clientRequestId`, `connectionId`, `userId`, `type`, `roundId`, `roundPhase` (at receipt), `betId`, `amount`, `autoCashout` / `multiplier`, `payout`, `outcome`, `durationMs` (from receipt to response) |
| `http.request`  | every HTTP request except `/metrics` and `/health`   | `requestId`, `method`, `route` (path without query), `statusCode`, `userId` (after login), `outcome`, `durationMs`                                                                                                    |
| `ws.connection` | socket closed                                        | `connectionId`, `userId`, `authOutcome`, `closeCode`, `messagesReceived`, `durationMs` (connection lifetime)                                                                                                          |
| `round`         | the round's crash is stored, or the app stops first  | `roundId`, `crashPoint`, `bettingEndsAt`, `startedAt`, `crashedAt`, `continuedAfterRestart`, `crashWriteRetries`, `outcome`, `durationMs`                                                                             |
| `auto_cashout`  | each auto-cashout pass (tick or crash) with bets due | `roundId`, `trigger` (`tick`/`crash`), `multiplier` (tick value or crash point), `due`, `paid`, `failed`, `durationMs`                                                                                                |
| `settlement`    | each settlement sweep                                | `roundId` (the round opening), `found`, `won`, `lost`, `refunded`, `skipped` (settled meanwhile by someone else), `failed`, `durationMs`                                                                              |
| `startup`       | app listening, or failing to                         | `migrationsApplied`, `port`, `outcome`, `durationMs` (from process start)                                                                                                                                             |
| `shutdown`      | the gateway's shutdown hook finished                 | `moneyOpsInFlight` (at start), `socketsClosed`, `durationMs` (stopping the loop and draining)                                                                                                                         |

Outcomes:

- `ws.message`: `accepted`, `replayed` (answered with an existing result: a retry, or a cashout after the auto-cashout paid) or the error code sent to the client (`validation_failed`, `cashout_closed`, `internal_error`, …). WebSocket has no status code; this field takes its place. Business fields are logged for accepted requests only.
- `http.request`: `ok`, `client_error`, `server_error` (logged at `error`), `aborted`.
- `ws.connection` `authOutcome`: `ok`, `unauthorized`, `error` (logged at `error`), `shutting_down`, `pending` (closed before the token was checked).
- `round`: `crashed`, `crash_not_stored` (the app stopped while the crash write was still retried; logged at `error`), `interrupted` (the app stopped before the crash).
- `startup`: `ok`, `failed`.

Ticks and phase changes are no longer logged; the `round` event replaces them. Whether the last round was continued after a restart is in its `continuedAfterRestart`. Individual auto-cashouts and settled bets are not logged one by one: a pass can pay hundreds of bets, and each bet is in the database.

### Request ids

- `requestId` is generated by the server for every unit of work. HTTP takes it from `x-request-id` when it is 1–128 characters of `[A-Za-z0-9_.-]` and returns it in the response header.
- The client's WebSocket `requestId` is the idempotency key and repeats on retries, so it is logged as `clientRequestId`; it joins a request with its retries.

### Errors and secrets

- Failures outside a unit of work stay separate `error` events with `event` naming the operation: `round.prepare_failed`, `round.store_failed`, `round.crash_write_failed` (each attempt, with `retryInMs`), `game.subscriber_failed`, `betting.game_event_failed`. Failed bets of a sweep or an auto-cashout pass are counted in its event instead.
- Errors are serialized explicitly as `name`, `message`, `code`, `stack`; everything else on them (TypeORM's `query` and `parameters`, which can hold a token) is dropped.
- pino `redact` removes `token` and `*.token`. Routes are logged, never raw URLs (`/ws?token=…`). Money amounts are logged as decimal strings; balances and request bodies are not.

## Alternatives

- **Nest `ConsoleLogger({ json: true })`:** no new dependency, but a fixed field schema, no redaction, and slower writes; logging every request would distort experiment 1.
- **`nestjs-pino`:** request logging through `pino-http` covers HTTP only, while most requests arrive over WebSocket. The wrapper would hide the part we need to build anyway.
- **Many narrow log lines per request:** lines of concurrent requests interleave and must be joined by id; wide events are queried like table rows.
- **Shipping logs to Loki now:** the app runs on the host in this phase, so a collector would need a log file or a push from the app. Postponed to Phase 5, when instances run in containers and Grafana Alloy can read their stdout without app changes.
- **Asynchronous writes:** cheaper under load, but lines buffered at `kill -9` are lost. Revisit if experiment 1 shows logging cost.

## Consequences

- Every bet and cashout writes one line. Under load this costs CPU; experiment 1 measures it, and logs can go to a file or `/dev/null` for a clean run.
- `BettingService` tells the gateway whether a request was answered with an existing result (`replayed`). The information already existed (`duplicate`, `already_paid`); it is only passed on. Metrics (ADR-0006) use the same flag.
- Logs are analysed with `jq` until Phase 5 adds Loki.
- Tests replace the destination with an in-memory stream and assert on emitted events.
