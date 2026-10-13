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
- Not done yet: the initial migration (needs a running PostgreSQL), integration tests not run yet

## Next

- Owner: `docker compose up -d` → generate the initial migration (twice, second must be empty) → `npm run test:e2e -w game-server` → run server + web
- Phase 3: observability

## Open questions

- Max win per bet: 100 000 was chosen by Claude (ADR-0004), confirm or change
