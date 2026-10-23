# Performance test plan

How much one game server instance holds, where its bottlenecks are and what breaks first. This plan sets the questions, the pass criteria and the order of the runs. Each step records its results below, and larger experiments get their own write-up in this folder.

## Questions

1. **Capacity:** how many players one instance serves while the SLOs hold.
2. **Bottleneck:** which resource runs out first: event loop CPU, the database pool, PostgreSQL, the network, or the generator itself.
3. **Failure mode:** what happens past the limit: latency grows, requests fail, or money breaks. Does the server recover once the load drops?
4. **Degradation over time:** memory, table growth, reconciliation and settlement sweep duration over an hour or more.

## SLOs

Capacity is the highest load at which all of these hold over the steady-state part of a run.

| What                    | Threshold         | Source                                              |
| ----------------------- | ----------------- | --------------------------------------------------- |
| Bet and cashout p99     | < 200 ms          | generator latency, measured from the planned moment |
| Failed share (5xx-like) | 0                 | Outcomes per second / Failed share panels           |
| Tick jitter p99         | < 50 ms           | generator tick jitter                               |
| Money                   | reconciliation OK | `npm run reconcile -w game-server` after the run    |

## Environment

Everything runs on one laptop, so absolute numbers hold for this machine only; which resource fails first is still a valid finding. Re-check this section before a series of runs and note any change in the results.

| Item              | Value                                                  |
| ----------------- | ------------------------------------------------------ |
| Machine           | Apple M2 Pro, 10 cores, 16 GB RAM, macOS 26.6.2        |
| Docker Desktop    | 27.3.1, VM with 10 CPUs and 8 GB RAM                   |
| Node              | 24.21.0                                                |
| PostgreSQL        | 17 (alpine image), default configuration               |
| Redis             | 7 (alpine image), AOF on                               |
| Prometheus        | v3.5.0, 5 s scrape                                     |
| Grafana           | 12.1.1                                                 |
| App database pool | 10 connections (pg default), 1 s wait for a connection |
| Commit            | recorded per run                                       |

Consequences for the results:

- The Docker VM may use all 10 cores, so PostgreSQL, the game server, the generator and the observability stack compete for the same CPUs.
- Half of the RAM goes to the Docker VM; the game server, the generator and the browser share the other 8 GB with macOS.
- One generator holds about 16 000 connections (ephemeral ports, ADR-0008).

## Workload model

The game creates two independent kinds of load, so they are tested separately before they are mixed:

- **Fan-out:** a tick 10 times per second to every open socket, plus the round events. Driven by the number of connections; costs CPU and memory even when nobody bets.
- **Money:** bets bunch up in the first half of the 15 s betting phase, manual cashouts around popular targets, settlement sweeps at the start of each round. Driven by bets per round and their peak rate; costs database time.

## Run protocol

Every run follows the same steps:

1. **Hypothesis with a number**, written before the run, for example "the pool saturates near N bets per second" (Little's law: concurrency = throughput × latency).
2. **Environment recorded:** commit, scenario, configuration changes.
3. **Warm-up:** the first 1–2 rounds are not counted.
4. **Steady state:** at least 5 minutes per load level (about 10 rounds).
5. **Validity check:** generator event loop lag and CPU stay low; if not, the run is discarded.
6. **Repeat** each decisive run 2–3 times.
7. **Reconcile:** `npm run reconcile -w game-server`.
8. **Record:** hypothesis, observation, conclusion, in the results below.

Reading the dashboards: RED (rate, errors, duration) for what players see, USE (utilization, saturation, errors) for each resource. The bottleneck is the resource whose saturation rises first: money operations in flight and pool `waiting` rising while event loop lag stays flat points at the database; the reverse points at CPU or broadcast.

## Pre-run checklist

- [ ] `docker compose --profile observability up -d`, all containers healthy
- [ ] Game server built and started without watch mode or pretty printing: `npm run build -w game-server`, then `npm run start:prod -w game-server` with logs redirected to a file
- [ ] Load generator built and started the same way: `npm run build -w load-generator`, then `npm run start:prod -w load-generator` with logs redirected to a file
- [ ] Prometheus `/targets`: game server and generator up
- [ ] No other heavy processes running (builds, tests, video calls)
- [ ] Dashboard time range covers the run; annotations visible

## Steps

| #   | Step                            | Load                                                                        | Question                                                                                        |
| --- | ------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0   | Preparation                     | none                                                                        | SLOs, environment, pre-run checklist: can the numbers be trusted?                               |
| 1   | Smoke and generator calibration | a few bots, then rising connections                                         | Does the measurement chain work end to end? How many bots does the generator hold while honest? |
| 2   | Baseline                        | `steady` (100 bots), 10 min                                                 | What does normal look like on every panel?                                                      |
| 3   | Fan-out                         | connection steps (1k, 2k, 4k, 8k, …), `betProbability = 0`                  | Where does broadcasting ticks break tick jitter and the event loop? (experiment 1)              |
| 4   | Money throughput                | fixed ~500 connections, rising bet rate; then the pool size as one variable | Where is the pool ceiling, and does the pool or PostgreSQL give in first?                       |
| 5   | Breakpoint                      | realistic mix, ramped until an SLO breaks                                   | Capacity as "N players at P bets per round"; how it fails; is money safe?                       |
| 6   | Spike                           | `spike` preset                                                              | Login storm (every bot creates a user) plus bet storm: behaviour and recovery                   |
| 7   | Soak                            | ~70% of capacity for 1–2 h                                                  | Memory, `bets` growth, reconciliation and settlement sweep duration                             |
| 8   | Report                          | none                                                                        | Capacity, bottlenecks ranked, what to fix first and why                                         |

Every fix found in steps 4–7 goes through its own cycle: hypothesis, change (TDD, an ADR when architectural), and the same run again for a before/after comparison.

## Results

### Step 0. Preparation

Done 2026-10-15: SLOs accepted, environment recorded, pre-run checklist written.

### Step 1. Smoke and generator calibration

Done 2026-10-22 at commit `dd4f6aa`: game server and generator both built and started without ts-node or pretty printing, database recreated empty.

**Smoke: 5 bots, 80% bet chance, 3 minutes.**

| What                | Observed                                     |
| ------------------- | -------------------------------------------- |
| Rounds              | 7                                            |
| Bets                | 34                                           |
| Bet and cashout p99 | < 50 ms, the same on the server and the bots |
| Tick jitter p99     | a few ms                                     |
| Outcomes            | all success                                  |
| Top query by time   | bets insert, then rounds insert, then ledger |
| Reconciliation      | OK: 6 users, 34 bets, 0 mismatches           |

- A round takes ~26–29 s: 15 s of betting, 5 s of pause and a flight of ln(crash point) / k, a median of ~6.4 s (crash at ~1.98x) and a mean of ~9.3 s. Three minutes hold 6–7 rounds.
- The bets insert costs more than the ledger insert (0.56 ms against 0.33 ms on average): `bets` has four indexes, two of them unique, and a primary key passed in from outside; `ledger_entries` has two and a sequential key. At this load the difference is near noise; step 4 checks it.
- Query counts add up to the money: 6 users + 34 bets + 8 manual cash-outs = 48 ledger inserts.
- `pg_stat_statements` keeps totals since the database started (here ~30 minutes of the server: 61 rounds, 31 reconciliations); reset it right before each run so the totals belong to that run.
- Conclusion: the chain works end to end. This is the floor: p99 under 50 ms, jitter a few ms, the database idle.

**Calibration: connections only (`betProbability = 0`), two runs.** Generator CPU is read on rounds whose flight lasts at least the 20 s `rate()` window, so the betting phase does not dilute it. Generator lag on the graph includes a ~10 ms floor from the 10 ms sampling resolution; the honesty limit is 20 ms above it (0.03 on the graph).

Run 1 (2026-10-22), 500 → 1000 → 2000 bots:

| Bots | Generator CPU | Generator lag p99 (graph) | Server                                                          |
| ---- | ------------- | ------------------------- | --------------------------------------------------------------- |
| 500  | 0.158         | floor (~0.01)             | within SLO                                                      |
| 1000 | 0.27–0.29     | up to 0.019               | within SLO                                                      |
| 2000 | 0.33          | up to 0.019               | event loop lag above 50 ms, tick delay at times ~50 ms, CPU 0.3 |

Run 2 (2026-10-23), up to 6000 bots, with the SLO row on the dashboard:

| Bots | Generator CPU | Generator lag p99 (graph) | Server                                                                                               |
| ---- | ------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| 4000 | up to ~0.4    | ~0.02 (honest)            | within SLO                                                                                           |
| 6000 | up to ~0.4    | up to ~0.04 (not honest)  | 99.9% of ticks within 50 ms (objective 99%), event loop lag up to ~50 ms on the graph, CPU up to 0.5 |

- From 500 and 1000, generator CPU fits a constant part plus a cost per message: ~0.036 + ~24 µs per message, which would put 2000 at 0.52 and the 0.7 limit near 2700 bots. At 2000 it measured 0.33.
- The server sent 10 ticks per second and every bot received every tick (bot ticks / server ticks ≈ 1), so at 2000 the generator did handle 20 000 messages per second: the cost per message falls with load (~5 µs for the added messages). Not established why: more messages per event loop pass, or macOS moving the process from efficiency to performance cores, which would make "share of a core" a different unit at low and high load. A per-message cost holds only at the load it was measured at.
- The generator's lag follows the size of a tick burst, not average CPU: in run 2 its lag crossed the limit at 6000 while CPU stayed near 0.4.
- The runs disagree on the server: run 1 saw lag above 50 ms at 2000, run 2 kept the tick objective at 6000. Not established why; candidates are other load on the laptop during run 1 and macOS placing the processes on different core types. Run 1 judged the server by eye, run 2 by the share of ticks within 50 ms.
- Conclusion (run 2): one generator is honest up to ~4000 bots on this machine, its limit lies between 4000 and 6000. The server still meets the tick objective at 6000, so the generator gives in first. Above ~4000 bots, player-side numbers (tick jitter, player latency) are not trustworthy; server-side metrics and the SLO row still are.
- Step 3 hint: server event loop lag tracks the broadcast loop, which sends to every socket in one synchronous pass; ~40 ms at 6000 sockets is ~6–7 µs per send.
- Not recorded: Broadcast duration p99, reconciliation after the calibration runs, a third run in a quiet machine to settle the disagreement.
