# Development state

**Current phase:** 4 — Load generator and test dashboard (implemented, first runs done)
**Last updated:** 2026-10-26

## Done

- Project initialized: CLAUDE.md, plan, ADR folder
- ADR-0001 stack accepted (NestJS, Jest, fake auth)
- docker-compose: Postgres 17, Redis 7 (AOF), healthchecks
- Monorepo (npm workspaces), Node 24 (`.nvmrc`), TypeScript 6 (shared `tsconfig.base.json`)
- ESLint 10 + typescript-eslint (type-checked) and Prettier, configured once at the root
- `apps/game-server`: NestJS app with `GET /health`, unit + e2e tests
- Crash point generator (`src/game/crash-point.ts`): 1% edge, 10 000x cap, hundredths as `number`
- Multiplier curve (`src/game/multiplier.ts`): `multiplierAt`, `crashTimeMs` (first whole ms reaching the crash point)
- Round state machine (`src/game/round.ts`): BETTING → RUNNING → CRASHED (terminal), time passed in, no money
- Game loop (`src/game/game-loop.ts`): timers, events via `onEvent`, guards against early crash timer and late ticks
- `GameModule`: loop starts with the app, stops on shutdown, events logged via the default Nest logger
- ADR-0002 game core design accepted (random crash point, not provably fair, 1% edge, k = 0.000107, 15 s / 100 ms / 5 s)

## In progress

- Phase 2, implemented by Claude on request, awaiting owner review and first manual run:
  - ADR-0003 (protocol, fake auth) and ADR-0004 (wallet, settlement)
  - `packages/contracts`: type-only message contract
  - game-server: users/auth, betting (bets, cashouts, auto-cashout, max win, settlement), PostgreSQL stores, WebSocket gateway, round persistence
  - `apps/web`: React + Vite client
- Review fixes and fault tolerance (by Claude, on request), awaiting owner review; integration tests pass (28/28):
  - round stored before betting opens; deterministic timeline; a restart continues the last round or voids it
  - settlement sweep: crashed rounds settled, interrupted rounds refunded (`VOID` + `REFUND`)
  - app transaction timeouts; late bets are not created
  - idempotent bet and cashout retries; client resends the unanswered request after reconnecting
  - graceful shutdown: stop the loop, drain requests and writes before the database closes
- Second review fixes (by Claude, on request), awaiting owner review; integration tests pass: crash write retried until stored, cashout as one transaction, bet inserted before debit, migrations on a separate connection without timeouts, client retries only bets of the same round, shutdown stops the loop before draining

## Next

- Owner: `npm run test:e2e -w game-server` (initial migration is generated and applied) → review → run server + web
- Phase 3: observability
  - ADR-0005 structured logging accepted; implemented by Claude on request (TDD), awaiting owner review:
    - `src/logging`: pino logger (`APP_LOGGER`), `WideEvent`, Nest logger adapter, `http.request` middleware
    - wide events: `ws.message`, `ws.connection`, `http.request`, `round`, `auto_cashout`, `settlement`, `startup`, `shutdown`; per-tick logs removed
    - `BettingService` returns `replayed` and exposes `inFlightCount`; `AuthService.login` returns the user
    - errors keep only name, message, code and stack, so query parameters (tokens) never reach the logs
    - `start:dev` pipes through `pino-pretty`, one line per event; routine Nest messages dropped; durations rounded, round times in ISO
    - unit tests 301/301, integration tests 30/30
  - ADR-0006 metrics accepted for the first step; implemented by Claude on request (TDD), awaiting owner review:
    - prom-client with its own registry (`MetricsModule`), `GET /metrics`
    - Node default metrics, including event loop lag p50/p90/p99
    - `crash_tick_delay_seconds`: how late each tick fired, measured in `GameLoopService` (game loop unchanged)
    - unit tests 313/313, integration tests 31/31
  - Prometheus + Grafana in docker-compose (profile `observability`), provisioned from `ops/`, dashboard `Game server`: written by Claude, checked by the owner
  - README: how to run and observe, game overview, dashboard panels; load simulations recorded by the owner (idle baseline, CPU block, huge array, a million small objects)
  - Remaining server metrics (ADR-0006), implemented by subagents on request (TDD) and reviewed by a separate agent; review fixes applied: request duration and results, connections, broadcast duration, buffered bytes, draining, money operations in flight, auto-cashout and settlement results, unsettled bets, round write failures, database pool; dashboard extended to 19 panels
    - unit tests 363/363 (game-server), integration tests 31/31
  - ADR-0007 money reconciliation, implemented by Claude on request (TDD), awaiting owner review: eight invariants checked in one read-only snapshot on a dedicated connection, every minute in the server and on demand (`npm run reconcile`); a `reconciliation` log event and metrics, two dashboard panels; no tables
    - `npm run reconcile` prints readable output in a terminal, JSON in a pipe; exit code kept
    - unit tests 392/392 (game-server), integration tests 52/52
  - `npm run verify`: one command for format, lint, typecheck (every workspace), unit and integration tests
    - its first run found a real mismatch in the dev database: user `vlados` (created before the ledger existed) has no `INITIAL` entry, so the balance is 5000 above the ledger

- Phase 4 — load generator and test dashboard (ADR-0008), implemented by Claude on request (TDD), awaiting owner review and a first live run:
  - `apps/load-generator`: plain Node, bots on `ws`; scenario validation and presets; pure bot logic (planned bets and manual cash-outs on the bot's clock, duplicate cash-outs, latency from the planned moment, tick jitter); connection with reconnects; one run at a time with ramp-up and duration; control API with server-sent events; `loadgen_*` metrics and a `load_run` log event
  - generator API types in `@crash/contracts`
  - `apps/web`: test dashboard at `/lab` (presets, scenario form with 422 errors per field, start/stop, live numbers); Vite proxies `/generator`
  - Prometheus scrapes the generator; dashboard section Players, server panels filtered to the game server
  - scenarios as steps (`bots x seconds`, ramping up and down between them; preset `steps` for experiment 1); every run and step marked as a Grafana annotation
  - dashboard: request rate and outcomes (success, rejected, failed) and failed share
  - first live run by the owner: the `spike` preset failed bets with `internal_error` because the 10-connection database pool timed out after 1 s; money stayed safe (failed bets roll back). Next: a configurable pool size to measure where the pool stops being the limit

- Performance testing ([plan](experiments/performance-test-plan.md)), run by the owner step by step: SLOs, environment and run protocol recorded (step 0, 2026-10-15); generator runs built without ts-node; step 1 done 2026-10-23: the chain works, one generator is honest up to ~4000 bots, the server meets the tick objective at 6000 (an earlier run disagreed, a quiet repeat is pending); server SLOs on the dashboard; step 2 done 2026-10-25: baseline recorded (~3.3 requests/s, p99 ~50 ms, CPU 3–6%), reconciliation is the largest database consumer at this load; slow consumer check 2026-10-26: frozen bots exhaust the laptop's kernel network memory and get reset (code 1006) before the server queues anything. Next: step 3, fan-out

## Backlog (before experiments)

- WebSocket hardening: `maxPayload`, per-socket message rate limit, ignore messages before auth, ping/pong to drop dead connections
- Slow consumer protection (ADR first: which messages may be dropped and when a client is disconnected): the broadcast sends to every socket without checking `bufferedAmount`, so a client that stops reading makes the server queue its ticks in memory. Skip ticks to a socket whose `bufferedAmount` is above a soft limit (only the latest multiplier matters), never drop bet and cash-out answers, balances or `round:crashed`, close the socket above a hard limit or after staying above the soft one for a while (the client reconnects and gets a snapshot); metrics for skipped ticks and slow-consumer disconnects
- Rate limit `POST /auth/login` (every new username creates a user)
- Partial index on `bets` for `status = 'ACTIVE'`: the settlement sweep (`findUnsettledBets`) reads all of `ix_bets_round_status` every round, about 30 ms at 1M bets and growing with history
- End-to-end WebSocket test through the real app (login → bet → cashout)
- CI: lint, unit tests, integration tests with PostgreSQL
- Migrations without `lock_timeout`: they run at startup on a connection with no timeouts, so an `ALTER TABLE` that waits for `ACCESS EXCLUSIVE` behind a long transaction (a reconciliation snapshot, `npm run reconcile`, another instance during a rolling deploy in Phase 5) queues every later query on that table behind it and stalls bets. Set `lock_timeout` for migrations and retry; use `CREATE INDEX CONCURRENTLY` for indexes on large tables (it cannot run inside a transaction, so that migration needs `transaction = false`)

## Open questions

- Max win per bet: 100 000 was chosen by Claude (ADR-0004), confirm or change
- Deploys: on SIGTERM, finish the running round and stop in the pause, so a deploy never voids a round? Needs a grace period of about 100 s
