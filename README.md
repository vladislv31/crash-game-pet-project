# Crash Game

A multiplayer crash game (iGaming) over WebSockets, built to learn and experiment with scaling, observability and money safety. Players bet during a 15 s betting phase, watch the multiplier grow and cash out before the round crashes. The server is authoritative: the client never decides the multiplier, the crash point or a payout.

Progress lives in [docs/state.md](docs/state.md), the roadmap in [docs/plan.md](docs/plan.md), decisions in [docs/adr](docs/adr).

## How the game works

Rounds run one after another, driven by the server's game loop ([ADR-0002](docs/adr/0002-game-core-design.md)):

1. **Betting, 15 s.** Before it opens, the server draws the crash point (1% house edge, capped at 10 000x) and stores it with the round. Players place one bet each, optionally with an auto-cashout target.
2. **Running.** The multiplier grows as `e^(0.000107 · t)` (2x at about 6.5 s). Every 100 ms the server broadcasts a **tick** with the current multiplier. Ticks are display-only: the client draws the curve itself and ticks correct its drift.
3. **Crashed.** At the precomputed moment the multiplier reaches the crash point and the round crashes. Bets not cashed out lose.
4. **Pause, 5 s.** Then the next round opens betting; on opening, a settlement sweep settles every bet still open from earlier rounds.

A cashout is valid if the multiplier at the moment the server **received** it is below the crash point; ticks never decide money. Money moves in PostgreSQL transactions, so a bet is debited once and a cashout pays once even under retries ([ADR-0004](docs/adr/0004-wallet-and-bet-settlement.md)).

## Stack

NestJS game server with raw `ws`, PostgreSQL (TypeORM), Redis, a React + Vite client, pino logs, Prometheus metrics and Grafana dashboards. See [ADR-0001](docs/adr/0001-tech-stack.md).

| Path                 | What                                                           |
| -------------------- | -------------------------------------------------------------- |
| `apps/game-server`   | game loop, bets and cashouts, WebSocket gateway, logs, metrics |
| `apps/web`           | player UI                                                      |
| `packages/contracts` | WebSocket message types shared by server and client            |
| `ops/`               | Prometheus config, Grafana provisioning and dashboards         |
| `docs/`              | plan, state, ADRs, experiment write-ups                        |

## Running locally

Requires Node 24.9+ (`.nvmrc`) and Docker.

```bash
npm install
```

```bash
docker compose up -d
```

```bash
npm run start:dev -w game-server
```

```bash
npm run dev -w web
```

The game server listens on port 3000 and applies migrations on start; the client runs on http://localhost:5173.

Before calling a change done, run the whole gate (formatting, lint, type checks, unit tests and integration tests; needs `docker compose up -d`). It stops at the first failure:

```bash
npm run verify
```

Single steps:

```bash
npm test
```

```bash
npm run test:e2e -w game-server
```

```bash
npm run lint && npm run format:check && npm run typecheck
```

## Observability

### Logs

One JSON line per unit of work (a WebSocket message, an HTTP request, a connection, a round, a settlement sweep), on stdout ([ADR-0005](docs/adr/0005-structured-logging.md)). `start:dev` pretty-prints them one line per event.

To keep the raw JSON of a run, start the server from `apps/game-server` with a copy to a file:

```bash
mkdir -p logs && npx nest start --watch | tee logs/dev.jsonl | npx pino-pretty --singleLine --timestampKey timestamp --messageKey event --ignore service,serviceVersion,commitHash,region,instanceId
```

Everything that happened to one player (find the id with `select id from users where username = '…'`):

```bash
jq -c 'select(.userId == "USER_ID")' apps/game-server/logs/dev.jsonl
```

Outcomes of cashout requests (`accepted`, `replayed`, error codes):

```bash
jq -r 'select(.event == "ws.message" and .type == "cashout") | .outcome' apps/game-server/logs/dev.jsonl | sort | uniq -c
```

### Money reconciliation

The server checks the money invariants every minute ([ADR-0007](docs/adr/0007-reconciliation.md)): balances against the ledger, every bet against its ledger entries, payouts against amount × multiplier, the max win and the crash point. Each run is one `reconciliation` log event (`error` when anything is off) and the metrics behind the **Reconciliation** panels. To get a verdict right away, for example after an experiment:

```bash
npm run reconcile -w game-server
```

It prints the result readably in a terminal (JSON when piped or redirected, for `jq`) and exits with code 1 when the money does not add up.

### Metrics and dashboards

The server exposes Prometheus metrics at http://localhost:3000/metrics ([ADR-0006](docs/adr/0006-metrics.md)). Prometheus and Grafana run in the `observability` compose profile:

```bash
docker compose --profile observability up -d
```

- Prometheus: http://localhost:9090 (`/targets` shows whether the game server is scraped)
- Grafana: http://localhost:3001, dashboard **Game server**

| Panel                                                 | What it shows                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tick delay                                            | How much later than planned each tick fired, p50/p95/p99. Ticks come from a 100 ms `setInterval`; when the event loop is busy, the timer fires late. This is the lag players see as a jerky multiplier. Empty between rounds: ticks only fire while a round runs.           |
| Ticks per second                                      | Average tick rate over the rate window (at least 20 s, four 5 s scrapes). Ticks run at exactly 10/s during a flight, but the window also covers betting and the pause, so a 2x round (about 6.5 s of flight) shows about 3/s. Only flights longer than the window reach 10. |
| Event loop lag                                        | p50/p90/p99/max of `monitorEventLoopDelay`, reset on every scrape (each point covers 5 s). It records the interval between firings of its own 10 ms timer, so an idle process reads about 10 ms plus OS timer slack: the real lag is the value minus about 10 ms.           |
| CPU                                                   | Share of one core used by the process.                                                                                                                                                                                                                                      |
| Memory                                                | Resident set size, V8 heap used and total.                                                                                                                                                                                                                                  |
| GC time                                               | Share of time spent in garbage collection, by kind (minor, major, incremental).                                                                                                                                                                                             |
| Request duration                                      | p50/p99 time from receipt of a bet or cashout message to the response, by type. Starts when the handler runs, so time waiting behind a busy event loop is not in it.                                                                                                        |
| Requests by result                                    | Requests per second by type and result: `accepted`, `replayed` (answered with an existing result, e.g. a duplicate cashout) or the error code sent.                                                                                                                         |
| Connections                                           | Open sockets, including those waiting for the token check.                                                                                                                                                                                                                  |
| Broadcast duration p99                                | Synchronous CPU time to serialize one broadcast and hand it to every socket, by message type. Grows with the number of clients.                                                                                                                                             |
| Buffered bytes                                        | Data queued for slow clients: total and the largest single socket.                                                                                                                                                                                                          |
| Money operations in flight                            | Bets, cashouts, auto-cashouts and settlements waiting for the database. Rises when the database is the bottleneck while event loop lag stays flat.                                                                                                                          |
| Database pool                                         | Total, idle and waiting connections of the app's pool. Waiting above 0 means requests queue for a connection; they give up after 1 s.                                                                                                                                       |
| Unsettled bets                                        | Bets of earlier rounds the last settlement sweep could not settle. Above 0 means stuck bets.                                                                                                                                                                                |
| Auto-cashouts / Settled bets                          | Bets per window by result: auto-cashouts by trigger (`tick`, `crash`) and `paid`/`skipped`/`failed`; sweeps by `won`/`lost`/`refunded`/`skipped`/`failed`.                                                                                                                  |
| Round write failures / Failed settlement sweeps       | Failed round writes by operation and sweeps that could not read the open bets: database trouble in the game loop.                                                                                                                                                           |
| Draining                                              | 1 while the server shuts down and finishes requests in progress.                                                                                                                                                                                                            |
| Reconciliation mismatches / Since last reconciliation | Broken money invariants found by the last run, by type, and how long ago the last run completed. Above 0, or a growing time since the last run, needs investigation.                                                                                                        |

## Load lab

Thousands of bots playing at once, started from a page ([ADR-0008](docs/adr/0008-load-generator.md)). With the game server and the web client running:

```bash
npm start -w load-generator
```

Open http://localhost:5173/lab, pick a preset (`steady`, `ramp`, `spike`, `duplicate-cashouts`) or edit the scenario, and press Start. The page shows bots connected, requests and errors per second and player latency over the last 10 seconds; the charts are in the **Players** section of the Grafana dashboard, next to the server metrics.

- Every bot logs in as a new player (`bot_<run>_<n>`), so runs never drain each other's balances.
- Player latency counts from the moment a bot planned a request, so a busy server or a busy generator shows up instead of being hidden.
- **Generator health** on the dashboard shows the generator's own event loop lag and CPU: when they climb, the generator is the bottleneck and the latency numbers of that run are not trustworthy.
- One generator holds up to about 16 000 connections on macOS (ephemeral ports per destination).
- After a run that moved money, `npm run reconcile -w game-server` checks that it adds up.

## Load simulations

Manual load hardcoded into the server to see how the metrics react, before the load generator exists (Phase 4). Each simulation is switched on by an environment variable, so it never runs by accident, and recorded here as:

- **What:** the code added and where, and how to switch it on
- **Expected:** which panels should move and why
- **Observed:** what the dashboard showed (numbers, screenshots)
- **Conclusion:** what it teaches about the server

### Baseline: idle server

No players, the game loop running rounds, macOS laptop.

| Panel            | Value                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| Tick delay       | close to 0                                                                              |
| Ticks per second | 2–10, depending on how long rounds fly (see the panel description)                      |
| Event loop lag   | about 16 ms: the 10 ms measuring interval plus macOS timer slack, so the real lag is ~0 |
| CPU              | close to 0                                                                              |
| Memory           | stable, under 100 MiB                                                                   |
| GC time          | about 0.01%                                                                             |

### CPU: blocking the event loop

**What.** In `main.ts`, a busy loop that holds the event loop for 100 ms every second:

```ts
setInterval(() => {
  const now = performance.now();
  while (performance.now() - now < 100) {}
}, 1000);
```

**Expected.** Nothing else can run while the loop spins: timers, ticks and incoming messages wait for it. Event loop lag and tick delay should rise by up to the block length; CPU should rise by the busy share of time.

**Observed.**

| Panel          | Change                                 |
| -------------- | -------------------------------------- |
| Tick delay     | p99 up to about 100 ms                 |
| Event loop lag | p99 up to about 100 ms                 |
| CPU            | +12%                                   |
| Memory         | small fluctuations, as at the baseline |
| GC time        | unchanged                              |

**Conclusion.**

- The block covers 10% of the time, so it hits about one tick in ten. The median stays near 0 while p95/p99 jump to the block length: averages hide it, tail percentiles show it. Players whose tick lands in the block see the multiplier stall for up to 100 ms.
- The CPU cost is the busy share itself: 100 ms of every 1000 ms is 10% of a core whatever the loop body does (`performance.now()` only tells the loop when to stop), plus the baseline.
- The loop allocates nothing worth collecting, so GC time does not move; memory moves only with the usual noise.
- Any synchronous work on the main thread behaves the same way: a large `JSON.stringify`, a broadcast to thousands of sockets, a heavy calculation. This is why broadcast cost is the first suspect for experiment 1.

### GC: one huge short-lived array

**What.** In `main.ts`, a 10-million-element array allocated every second and dropped half a second later:

```ts
setInterval(async () => {
  const array = new Array(1e7).fill(0);
  await new Promise(resolve => setTimeout(resolve, 500));
}, 1000);
```

**Expected.** About 80 MB of garbage per second (10 million 8-byte elements) should keep the garbage collector busy, and its pauses should show up as event loop lag and tick delay.

**Observed.**

| Panel          | Change                     |
| -------------- | -------------------------- |
| Tick delay     | unchanged                  |
| Event loop lag | up to ~60 ms (idle ~20 ms) |
| Memory         | small sawtooth             |
| GC time        | up to ~1%                  |

Measured separately with `node --trace-gc`: `new Array(1e7).fill(0)` takes 15–21 ms of synchronous work; the array is then freed by one young-generation collection (scavenge) of 1–3 ms.

**Conclusion.**

- The lag comes from creating and filling the array on the main thread, not from collecting it: one array is one object, and freeing it is cheap.
- A ~20 ms block once a second rarely lands on a tick, so tick delay stays flat while the event loop lag peaks show it.
- Many bytes in few objects cost little to collect.

### GC: a million small objects kept alive

**What.** In `main.ts`, a million small objects created every second and kept for two seconds, so two or three batches are alive at once:

```ts
setInterval(async () => {
  const objects = Array.from({ length: 1e6 }, (_, i) => ({ i }));
  await new Promise(resolve => setTimeout(resolve, 2000));
  void objects.length;
}, 1000);
```

**Expected.** The collector has to trace and copy every surviving object, so its pauses should grow with the number of live objects.

**Observed.**

| Panel          | Change                                        |
| -------------- | --------------------------------------------- |
| Tick delay     | p99 ~80 ms                                    |
| Event loop lag | typical percentiles +10–20 ms, peaks 60–80 ms |
| GC time        | ~0.1% (idle ~0.01%, huge array ~1%)           |

Measured separately with `node --trace-gc`: creating the million objects takes 37–61 ms, interleaved with young-generation collections of 1–7 ms each (survivors are copied and promoted to the old generation), followed by a full mark-compact of ~12 ms.

**Conclusion.**

- Collection cost follows the number of live objects: surviving objects are copied out of the young generation and later traced by a full collection on the main thread. Together with the allocation itself this blocks for tens of milliseconds, long enough to delay ticks.
- Compared with the huge array: fewer bytes, far more objects, much more impact. For the game server this points at per-message garbage under load: one object per bet, per broadcast or per log line adds up.
- Open question: GC time rose tenfold over idle (~0.1%) but stayed below the huge array's ~1%, although `--trace-gc` shows longer pauses here. Running the server itself with `--trace-gc` would show which collections the panel counts.

## Experiments

Phase 6 experiments, each with a full write-up in [docs/experiments](docs/experiments) (setup, results, conclusions) and a summary here.

| #   | Experiment                                                              | Status                                | Result |
| --- | ----------------------------------------------------------------------- | ------------------------------------- | ------ |
| 1   | Max connections before p99 grows                                        | runnable with the load lab            |        |
| 2   | Several instances behind a load balancer, Redis pub/sub                 | needs horizontal scaling (Phase 5)    |        |
| 3   | Kill an instance mid-round: no lost bets or payouts                     | runnable on one instance              |        |
| 4   | Concurrent duplicate cashouts: paid exactly once                        | runnable: `duplicate-cashouts` preset |        |
| 5   | Wallet concurrency: isolation levels and row locks in PostgreSQL (MVCC) | runnable                              |        |
