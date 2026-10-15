# 0006. Metrics

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Phase 6 experiments measure how far one server goes before players feel lag, how several instances behave, what a killed instance costs and whether duplicate cashouts pay once. Logs (ADR-0005) say what happened to one request; metrics must show the trend over time: latency percentiles, saturation, lag.

The player-facing p99 is measured by the load generator in Phase 4 (it sees the whole round trip). Server metrics explain why it grows. They are added in steps; this ADR records the decisions made so far and grows with them.

## Decision

### Library and endpoint

- **prom-client** directly, no Nest wrapper (`@willsoto/nestjs-prometheus`): the wrapper saves a few lines and hides the registry we want in tests.
- `GET /metrics` on the app port, in the Prometheus text format. Not logged (ADR-0005).
- One `Registry` per app, owned by a global `MetricsModule` and injected; no global default registry, so each test gets a fresh one.
- Names: `crash_` prefix for our metrics, base units (`_seconds`, `_bytes`), `_total` for counters, as Prometheus recommends.
- Each area declares its metrics in its own injectable class next to its code (`GatewayMetrics`, `BettingMetrics`, `RoundMetrics`, `DatabaseMetrics`), registered on the shared registry. Services record values through it; values that already live in memory (open sockets, operations in flight, pool state) are read at scrape time through a `collect` callback instead of being updated on every change.
- Labels have bounded values only (message types, error codes, outcomes), never ids.
- In Phase 5 Prometheus scrapes each instance directly, not through the load balancer, or the series of different instances would mix.

### Metrics

| Metric                                                    | Type      | Meaning                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node defaults                                             | various   | `collectDefaultMetrics`: CPU, memory, GC, handles, and event loop lag (`nodejs_eventloop_lag_p50/p90/p99_seconds` from `monitorEventLoopDelay`, 10 ms precision, reset on every scrape)                                                                                          |
| `crash_tick_delay_seconds`                                | histogram | how much later than planned each tick fired during `RUNNING`                                                                                                                                                                                                                     |
| `crash_ws_connections`                                    | gauge     | open sockets tracked by the gateway (authenticated or waiting for the token check)                                                                                                                                                                                               |
| `crash_ws_request_duration_seconds{type, result}`         | histogram | from receipt of a client message to the response; `type`: `bet`, `cashout`, `invalid`; `result`: `accepted`, `replayed` or the error code sent (as `outcome` in ADR-0005). Its `_count` counts requests and errors by code                                                       |
| `crash_broadcast_duration_seconds{type}`                  | histogram | synchronous time to serialize one broadcast and hand it to every open socket, by server message type                                                                                                                                                                             |
| `crash_ws_buffered_bytes` / `crash_ws_buffered_bytes_max` | gauge     | sum and maximum of `bufferedAmount` over open sockets at scrape time: data queued for slow clients                                                                                                                                                                               |
| `crash_draining`                                          | gauge     | 1 while the server shuts down and drains, otherwise 0                                                                                                                                                                                                                            |
| `crash_money_ops_in_flight`                               | gauge     | bets, cashouts, auto-cashouts and settlements started and not finished                                                                                                                                                                                                           |
| `crash_auto_cashouts_total{trigger, result}`              | counter   | bets due for auto-cashout by `trigger` (`tick`, `crash`) and `result` (`paid`, `skipped`: already settled, `failed`)                                                                                                                                                             |
| `crash_settlement_bets_total{result}`                     | counter   | bets handled by settlement sweeps: `won`, `lost`, `refunded`, `skipped`, `failed`                                                                                                                                                                                                |
| `crash_settlement_sweeps_total{outcome}`                  | counter   | settlement sweeps: `ok`, `failed` (the unsettled bets could not be read)                                                                                                                                                                                                         |
| `crash_unsettled_bets`                                    | gauge     | `ACTIVE` bets of earlier rounds that the last successful sweep could not settle; above 0 means bets are stuck until a sweep settles them. Bets found and settled are not counted: losing bets always wait for the next sweep, so the found count is above 0 whenever people play |
| `crash_round_write_failures_total{operation}`             | counter   | failed round writes: `create`, `mark_started`, `mark_crashed` (every failed attempt of the retried crash write)                                                                                                                                                                  |
| `crash_db_pool_connections{state}`                        | gauge     | the app's PostgreSQL pool at scrape time: `total`, `idle`, `waiting` (requests queued for a connection)                                                                                                                                                                          |

Buckets: request duration 1, 2.5, 5, 10, 25, 50, 100, 250, 500 ms, 1, 2.5, 5 s (the app transaction limit is 3 s); broadcast duration 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250 ms.

What the gateway, betting and database metrics show:

- Requests follow RED (rate, errors, duration), all from `crash_ws_request_duration_seconds`: rate over a 10 s window, so a betting burst is not flattened; outcomes in three classes by `result`: **success** (`accepted`, `replayed`), **rejected** (a business answer such as `betting_closed` or `insufficient_funds`, like HTTP 4xx) and **failed** (`internal_error`, `unavailable`, like HTTP 5xx); the failed share should stay at 0.

- Request duration starts when the message handler runs, so time a message waits in the socket or behind a busy event loop is not in it; event loop lag and the client-side p99 (Phase 4) cover that.
- `ws.send()` only queues a frame, so broadcast duration is the CPU cost of a broadcast, not its delivery; buffered bytes show the delivery side.
- Operations in flight and waiting pool requests rise when the database is the bottleneck while event loop lag stays flat; the reverse means CPU or broadcast.

### Tick delay

- The game loop fires ticks with `setInterval`, and Node schedules the next run from the moment the callback ran. The gap between two consecutive ticks minus the tick period is therefore how late that tick was.
- `GameLoopService` measures it in its event handler: `onEvent` is called synchronously from the timer callback, so the handler's clock reading is the firing time. The game loop itself (a learning zone) is not changed; the service passes the tick period to it explicitly instead of relying on the loop's default.
- Each round restarts the measurement at its `started` event, so its first tick is measured from the moment the tick timer was armed. Ticks only fire while the round runs, so betting and the pause never count.
- Buckets: 1, 2.5, 5, 10, 25, 50, 100, 250, 500 ms, 1 s.
- Ticks are display-only (ADR-0002), so a late tick costs smoothness, not money. Event loop lag shows how busy the process is; tick delay shows how much of it reaches the game.

### Prometheus and Grafana

- Both run in `docker-compose.yml` under the `observability` profile (`docker compose --profile observability up -d`), so the default `docker compose up -d` used by integration tests still starts only Postgres and Redis. Images are pinned: `prom/prometheus:v3.5.0`, `grafana/grafana:12.1.1`.
- Prometheus scrapes `host.docker.internal:3000/metrics` every 5 s: the game server runs on the host in this phase, and the default 15 s is too coarse for experiments. Dashboards use `$__rate_interval`, which stays at least four scrape intervals wide. Its data lives in a named volume, so runs can be compared after a restart.
- Grafana is provisioned from the repo: `ops/grafana/provisioning` (Prometheus datasource with a fixed uid, dashboard provider) and `ops/grafana/dashboards/*.json`. It listens on port 3001 (3000 is the game server), with anonymous admin access, local only.
- Dashboards can be edited in the UI, but changes last only until the container is recreated; the JSON in the repo is the source of truth.
- Dashboard `Game server`, by section: game loop (tick delay, ticks per second); requests (request duration and results, connections, broadcast duration, buffered bytes); money and database (operations in flight, pool, unsettled bets, auto-cashouts, settled bets); reliability (round write failures, failed sweeps, draining); event loop lag; process (CPU, memory, GC). Queries group by `instance`, ready for Phase 5.

## Alternatives

- **`@willsoto/nestjs-prometheus`:** less wiring, but a global registry and decorators around what is a few lines of code.
- **OpenTelemetry metrics with a Prometheus exporter:** vendor-neutral and ready for traces, but more moving parts than a learning project needs now.
- **Own event loop lag metric:** the Node defaults already expose percentiles from the same `monitorEventLoopDelay`.
- **Tick delay measured inside the game loop:** exact, but changes learning-zone code for an observation the service can make from the outside.

## Consequences

- `/metrics` is public on the app port. Fine locally; a deployment would restrict it.
- Percentiles from a histogram are interpolated within a bucket; the buckets bound their precision.
- No money amounts in metrics: Prometheus stores float64, and money is never a `number` here. Wagered and paid totals stay in the database.
- Several instances each report their own operations in flight, pool and unsettled bets; every instance runs the sweep, so `crash_unsettled_bets` is read with `max()` across instances.
- The shutdown duration is not a metric: the process exits before the next scrape. It is in the `shutdown` log event (ADR-0005); `crash_draining` is visible while it lasts.
- With the app on the host, Prometheus depends on `host.docker.internal`; Phase 5 runs the instances in compose and scrapes them by service name.
