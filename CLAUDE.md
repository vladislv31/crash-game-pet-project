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

## Commands

- Node 24.9+ required (`.nvmrc`): Jest loads ESM-only NestJS 12 via `--experimental-vm-modules`, already set in the test scripts
- `npm test`, `npm run lint`, `npm run format:check` from the root run all workspaces
- `npm run test:e2e -w game-server`, `npm run start:dev -w game-server`
- `docker compose up -d` starts Postgres and Redis

## Rules

- An architectural choice (library, storage, protocol, topology) requires an ADR before code.
- The server is authoritative: the client never decides the multiplier, the crash point or a payout.
- Money is stored as `decimal(40,18)` / string in transport, never JS `number`.
