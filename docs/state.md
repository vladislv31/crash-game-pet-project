# Development state

**Current phase:** 1 — Game core
**Last updated:** 2026-10-12

## Done

- Project initialized: CLAUDE.md, plan, ADR folder
- ADR-0001 stack accepted (NestJS, Jest, fake auth)
- docker-compose: Postgres 17, Redis 7 (AOF), healthchecks
- Monorepo (npm workspaces), Node 24 (`.nvmrc`), TypeScript 6 (shared `tsconfig.base.json`)
- ESLint 10 + typescript-eslint (type-checked) and Prettier, configured once at the root
- `apps/game-server`: NestJS app with `GET /health`, unit + e2e tests

## In progress

- Nothing

## Next

- Phase 1: round state machine, provably fair crash point, multiplier curve + tick loop

## Open questions

- None
