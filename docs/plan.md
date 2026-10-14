# Plan

## Phase 0 — Setup

- Monorepo, TypeScript, lint/format, test runner
- docker-compose: Postgres, Redis
- Confirm stack (ADR-0001)

## Phase 1 — Game core (learning zone)

- Round state machine: `BETTING → RUNNING → CRASHED → BETTING`
- Random crash point with 1% house edge (not provably fair), see ADR-0002
- Multiplier curve + server tick loop

## Phase 2 — WebSocket protocol + money

- Typed message contracts (shared package)
- Wallet/balance, place bet, cashout, auto-cashout
- Idempotency keys; exactly-once payout
- Max win per bet: auto-cashout when `bet × multiplier` reaches the limit
- Minimal player UI (multiplier, bet, cashout, live bets)

## Phase 3 — Observability

- Prometheus metrics: connections, tick lag, bet/cashout latency (p50/p95/p99), errors
- Grafana dashboards (provisioned from repo)
- Structured logs

## Phase 4 — Test dashboard

- Bot/session generator (N virtual players, configurable bet/cashout behavior)
- Start/stop stress scenarios from the UI, live stats

## Phase 5 — Horizontal scaling

- Multiple game-server instances behind a load balancer; rolling deploys (clients reconnect on close code 1012)
- Redis pub/sub for broadcast
- Single round leader: a lease in PostgreSQL with a fencing token (epoch), checked by every round write, so a stale leader cannot create or change rounds; money needs no lock (conditional updates already guarantee exactly-once)
- Leader handover continues the current round from the database (restart recovery for one instance is done in Phase 2)
- Revisit per-instance in-memory auto-cashout tracking
- Player investigation in Grafana: given a `userId` and a time range, see everything that happened to that player (requests, connections, bets, payouts) to understand a reported problem
  - Logs in Grafana: Loki + Alloy reading container stdout (ADR-0005), a dashboard filtered by `userId` and time
  - Gap to close: `auto_cashout` and `settlement` events are aggregates without `userId`, so a player's auto-cashouts, losses and refunds are only in the database. Either log them per bet or add a PostgreSQL datasource panel over `bets` and `ledger_entries`

## Phase 6 — Experiments (write-up per experiment in `docs/experiments/`)

1. Max connections before p99 grows
2. Multi-instance + LB + Redis pub/sub
3. Kill an instance mid-round → no lost bets/payouts
4. Concurrent duplicate cashouts → paid exactly once
5. Wallet concurrency in PostgreSQL (goal: learn MVCC and locking): run the bet and cashout paths under each isolation level (Read Committed, Repeatable Read, Serializable) and each locking strategy (conditional `UPDATE … WHERE status = 'ACTIVE'` only, `SELECT … FOR UPDATE`, `FOR NO KEY UPDATE`, `SKIP LOCKED` / `NOWAIT`, optimistic version column, advisory locks); find where isolation breaks (lost updates, double payouts, write skew, serialization failures that need retries) and where throughput or latency suffers (lock waits, contention on one hot user or bet, deadlocks)
