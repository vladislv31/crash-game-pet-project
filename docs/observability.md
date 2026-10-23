# Observability

How to read the logs, check the money and read the Grafana dashboard. A short version is in the [README](../README.md#observability).

## Logs

One JSON line per unit of work (a WebSocket message, an HTTP request, a connection, a round, a settlement sweep), on stdout ([ADR-0005](adr/0005-structured-logging.md)). `start:dev` pretty-prints them one line per event.

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

## Money reconciliation

The server checks the money invariants every minute ([ADR-0007](adr/0007-reconciliation.md)): balances against the ledger, every bet against its ledger entries, payouts against amount × multiplier, the max win and the crash point. Each run is one `reconciliation` log event (`error` when anything is off) and the metrics behind the **Reconciliation** panels. To get a verdict right away, for example after an experiment:

```bash
npm run reconcile -w game-server
```

It prints the result readably in a terminal (JSON when piped or redirected, for `jq`) and exits with code 1 when the money does not add up.

## Metrics

The server exposes Prometheus metrics at http://localhost:3000/metrics ([ADR-0006](adr/0006-metrics.md)). Prometheus and Grafana run in the `observability` compose profile:

```bash
docker compose --profile observability up -d
```

- Prometheus: http://localhost:9090 (`/targets` shows whether the game server is scraped)
- Grafana: http://localhost:3001, dashboard **Game server**

## Service level objectives

What the server promises, measured on the server alone, so they hold in production where no load generator runs. Each one is a share of good events, not a percentile: a share is exact when the threshold is a bucket boundary, while a percentile is interpolated inside a bucket. In production they would be read over 30 days, and the rest up to 100% is the error budget. The **Service level objectives** row at the top of the dashboard shows them as single numbers over the selected time range (`$__range`), so selecting a load run shows that run.

| Objective                 | Target                                                     | Measured by                                                                          |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Bets succeed              | ≥ 99.9% answered without `internal_error` or `unavailable` | `crash_ws_request_duration_seconds_count`, `type="bet"`; rejections count as answers |
| Cash-outs succeed         | ≥ 99.9%                                                    | the same, `type="cashout"`                                                           |
| Bets within 200 ms        | ≥ 99.9%                                                    | `crash_ws_request_duration_seconds_bucket{le="0.2"}` over `_count`, `type="bet"`     |
| Cash-outs within 200 ms   | ≥ 99.9%                                                    | the same, `type="cashout"`                                                           |
| Ticks within 50 ms        | ≥ 99% fire at most 50 ms late                              | `crash_tick_delay_seconds_bucket{le="0.05"}` over `_count`                           |
| Money mismatches          | 0                                                          | `crash_reconciliation_mismatches`, the highest value in the range                    |
| Since last reconciliation | ≤ 5 minutes (it runs every minute)                         | `crash_reconciliation_last_success_timestamp_seconds`                                |
| Stuck bets                | 0                                                          | `crash_unsettled_bets`, the highest value in the range                               |

Bets and cash-outs are kept apart: thousands of good bets would hide a few failed cash-outs, and a cash-out is the player's win. Server latency leaves out the network and the client, so players see a little more; the load runs check the player side with their own SLOs ([performance test plan](experiments/performance-test-plan.md)).

## Dashboard panels

| Panel                                                 | What it shows                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tick delay                                            | How much later than planned each tick fired, p50/p95/p99. Ticks come from a 100 ms `setInterval`; when the event loop is busy, the timer fires late. This is the lag players see as a jerky multiplier. Empty between rounds: ticks only fire while a round runs.           |
| Ticks per second                                      | Average tick rate over the rate window (at least 20 s, four 5 s scrapes). Ticks run at exactly 10/s during a flight, but the window also covers betting and the pause, so a 2x round (about 6.5 s of flight) shows about 3/s. Only flights longer than the window reach 10. |
| Event loop lag                                        | p50/p90/p99/max of `monitorEventLoopDelay`, reset on every scrape (each point covers 5 s). It records the interval between firings of its own 10 ms timer, so an idle process reads about 10 ms plus OS timer slack: the real lag is the value minus about 10 ms.           |
| CPU                                                   | Share of one core used by the process.                                                                                                                                                                                                                                      |
| Memory                                                | Resident set size, V8 heap used and total.                                                                                                                                                                                                                                  |
| GC time                                               | Share of time spent in garbage collection, by kind (minor, major, incremental).                                                                                                                                                                                             |
| Requests per second                                   | Bet and cash-out messages answered per second, by type and in total, over 10 s. Prometheus scrapes every 5 s, so a single request shows as 0.1.                                                                                                                             |
| Outcomes per second / Failed share                    | success (`accepted`, `replayed`), rejected (a business answer such as `betting_closed`, like HTTP 4xx) and failed (`internal_error`, `unavailable`, like HTTP 5xx). The failed share should stay at 0.                                                                      |
| Request duration                                      | p50/p99 time from receipt of a bet or cashout message to the response, by type. Starts when the handler runs, so time waiting behind a busy event loop is not in it.                                                                                                        |
| Requests by result                                    | Requests per window by type and result, as counts: one request shows as 1.                                                                                                                                                                                                  |
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

Thousands of bots playing at once, started from a page ([ADR-0008](adr/0008-load-generator.md)). With the game server and the web client running:

```bash
npm start -w load-generator
```

For measured runs, build it and start it without ts-node and pretty printing, like the game server: `npm run build -w load-generator`, then `npm run start:prod -w load-generator`.

Open http://localhost:5173/lab, pick a preset (`steady`, `ramp`, `spike`, `steps`, `duplicate-cashouts`) or edit the scenario, and press Start. The page shows bots connected, requests and errors per second and player latency over the last 10 seconds; the charts are in the **Players** section of the Grafana dashboard, next to the server metrics.

- **Steps** set the load over time as `bots x seconds`: `500x300, 1000x300, 2000x300, 4000x300` holds each level for five minutes (the `steps` preset, for experiment 1); a last step without seconds runs until stopped. Between steps bots join or leave at the ramp rate.
- Every run and every step is marked on the Grafana dashboard (annotation layers **Load runs** and **Load steps**), so each chart shows which run and step it is looking at. The generator writes them through the Grafana API (`GRAFANA_URL`, default http://localhost:3001); if Grafana is down, the run goes on.
- Every bot logs in as a new player (`bot_<run>_<n>`), so runs never drain each other's balances.
- Player latency counts from the moment a bot planned a request, so a busy server or a busy generator shows up instead of being hidden.
- **Generator health** on the dashboard shows the generator's own event loop lag and CPU: when they climb, the generator is the bottleneck and the latency numbers of that run are not trustworthy.
- One generator holds up to about 16 000 connections on macOS (ephemeral ports per destination).
- After a run that moved money, `npm run reconcile -w game-server` checks that it adds up.
