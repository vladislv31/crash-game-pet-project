# Development state

**Current phase:** 2 — WebSocket protocol + money (implemented, awaiting owner review)
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
- Review fixes and fault tolerance (by Claude, on request), awaiting owner review; integration tests for them not run yet:
  - round stored before betting opens; deterministic timeline; a restart continues the last round or voids it
  - settlement sweep: crashed rounds settled, interrupted rounds refunded (`VOID` + `REFUND`)
  - app transaction timeouts; late bets are not created
  - idempotent bet and cashout retries; client resends the unanswered request after reconnecting
  - graceful shutdown: drain requests and writes before the database closes

## Next

- Owner: `npm run test:e2e -w game-server` (initial migration is generated and applied) → review → run server + web
- Phase 3: observability

## Backlog (before experiments)

- WebSocket hardening: `maxPayload`, per-socket message rate limit, ignore messages before auth, ping/pong to drop dead connections
- Rate limit `POST /auth/login` (every new username creates a user)
- Do not log raw errors that carry query parameters (token in `findByToken` failures)
- Partial index on `bets` for `status = 'ACTIVE'` (settlement sweep scans the table)
- Reconciliation check: `users.balance` equals the sum of `ledger_entries` per user
- End-to-end WebSocket test through the real app (login → bet → cashout)
- Structured JSON wide-event logs per request (global CLAUDE.md), with Phase 3
- CI: lint, unit tests, integration tests with PostgreSQL

## Open questions

- Max win per bet: 100 000 was chosen by Claude (ADR-0004), confirm or change
- Deploys: on SIGTERM, finish the running round and stop in the pause, so a deploy never voids a round? Needs a grace period of about 100 s
