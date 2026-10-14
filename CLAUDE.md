# Crash Game — pet project

A multiplayer crash game (iGaming) over WebSockets. It comes with a test dashboard (stress tests, generated sessions) and Grafana metrics. Its main purpose is learning and experiments with scaling and money safety.

## Collaboration mode

- **The owner writes the code by default.** Claude helps with planning, ADRs, reviews and explanations.
- Claude writes code only when explicitly asked to for a specific task.
- **Learning zones**: the owner implements these personally. Claude may give hints, review the code and point out bugs, but must not write the solution unless asked directly:
  - Game core: round state machine, multiplier curve, crash point generation (provably fair)
  - Bet/cashout money flow: atomicity, idempotency
- When unsure whether a task is a learning zone, ask.

## Where things live

- `docs/plan.md`: phases and milestones
- `docs/state.md`: current progress. **Read it at session start and update it at session end.**
- `docs/adr/`: architecture decision records (`NNNN-title.md`, template in `0000-template.md`)
- `docs/experiments/`: experiment write-ups (setup, results, conclusions)
- `README.md`: how to run and observe the project; load simulations (what was hardcoded, expected, observed, conclusion) and a summary of each experiment

## Commands

- Node 24.9+ required (`.nvmrc`): Jest loads ESM-only NestJS 12 via `--experimental-vm-modules`, already set in the test scripts
- `npm test`, `npm run lint`, `npm run format:check`, `npm run typecheck` from the root run all workspaces
- `npm run verify`: the definition-of-done gate (format, lint, typecheck, unit tests, integration tests); needs `docker compose up -d`. Run it before calling a change done
- `docker compose up -d` starts Postgres and Redis; `docker compose --profile observability up -d` adds Prometheus (port 9090) and Grafana (port 3001, dashboards from `ops/grafana`)
- `npm run start:dev -w game-server` (port 3000, applies migrations on start), `npm run dev -w web` (port 5173, proxies `/auth` and `/ws` to 3000)
- `npm run test:e2e -w game-server`: integration tests against PostgreSQL (database `crash_test`, created automatically)
- `npm run reconcile -w game-server`: checks the money invariants once (ADR-0007), exit code 1 on any mismatch; the server also runs it every `RECONCILIATION_INTERVAL_MS` (default 60 s, 0 turns it off)
- Migrations: `npm run migration:generate -w game-server -- src/database/migrations/<name>`, then run the same command again: it must report no changes

## Rules

- An architectural choice (library, storage, protocol, topology) requires an ADR before code.
- The server is authoritative: the client never decides the multiplier, the crash point or a payout.
- Money is stored as `decimal(40,18)` / string in transport, never JS `number`.
