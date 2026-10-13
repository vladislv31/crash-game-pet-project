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
- ADR-0002 game core design accepted (random seed + commit–reveal, 1% edge, k = 0.000107, 15 s / 100 ms / 5 s)

## In progress

- Nothing

## Next

- Phase 1 (per ADR-0002), in order: crash point generator → multiplier curve + inverse → round state machine → game loop

## Open questions

- None
