# Development state

**Current phase:** 1 — Game core
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
- ADR-0002 game core design accepted (random crash point, not provably fair, 1% edge, k = 0.000107, 15 s / 100 ms / 5 s)

## In progress

- Game loop (`src/game/game-loop.ts`)

## Next

- Phase 2: WebSocket protocol + money

## Open questions

- None
