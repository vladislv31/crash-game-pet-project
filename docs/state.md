# Development state

**Current phase:** 3 — Observability (logging implemented, metrics next)
**Last updated:** 2026-10-13

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
  - Next: Prometheus + Grafana in docker-compose with provisioning, then the remaining metrics (request latency, broadcast, saturation, reliability)

## Backlog (before experiments)

- WebSocket hardening: `maxPayload`, per-socket message rate limit, ignore messages before auth, ping/pong to drop dead connections
- Rate limit `POST /auth/login` (every new username creates a user)
- Partial index on `bets` for `status = 'ACTIVE'` (settlement sweep scans the table)
- Reconciliation check: `users.balance` equals the sum of `ledger_entries` per user
- End-to-end WebSocket test through the real app (login → bet → cashout)
- CI: lint, unit tests, integration tests with PostgreSQL

## Open questions

- Max win per bet: 100 000 was chosen by Claude (ADR-0004), confirm or change
- Deploys: on SIGTERM, finish the running round and stop in the pause, so a deploy never voids a round? Needs a grace period of about 100 s
