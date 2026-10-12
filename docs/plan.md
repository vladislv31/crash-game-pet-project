# Plan

## Phase 0 — Setup

- Monorepo, TypeScript, lint/format, test runner
- docker-compose: Postgres, Redis
- Confirm stack (ADR-0001)

## Phase 1 — Game core (learning zone)

- Round state machine: `BETTING → RUNNING → CRASHED → BETTING`
- Provably fair crash point (server seed hash published before the round, seed revealed after)
- Multiplier curve + server tick loop

## Phase 2 — WebSocket protocol + money

- Typed message contracts (shared package)
- Wallet/balance, place bet, cashout, auto-cashout
- Idempotency keys; exactly-once payout
- Minimal player UI (multiplier, bet, cashout, live bets)

## Phase 3 — Observability

- Prometheus metrics: connections, tick lag, bet/cashout latency (p50/p95/p99), errors
- Grafana dashboards (provisioned from repo)
- Structured logs

## Phase 4 — Test dashboard

- Bot/session generator (N virtual players, configurable bet/cashout behavior)
- Start/stop stress scenarios from the UI, live stats

## Phase 5 — Horizontal scaling

- Multiple game-server instances behind a load balancer
- Redis pub/sub for broadcast; single round leader (lock/election)
- Round recovery after instance/leader death

## Phase 6 — Experiments (write-up per experiment in `docs/experiments/`)

1. Max connections before p99 grows
2. Multi-instance + LB + Redis pub/sub
3. Kill an instance mid-round → no lost bets/payouts
4. Concurrent duplicate cashouts → paid exactly once
