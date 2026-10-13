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
- Names: `crash_` prefix for our metrics, base units (`_seconds`), as Prometheus recommends.
- In Phase 5 Prometheus scrapes each instance directly, not through the load balancer, or the series of different instances would mix.

### Metrics

| Metric                     | Type      | Meaning                                                                                                                                                                                 |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node defaults              | various   | `collectDefaultMetrics`: CPU, memory, GC, handles, and event loop lag (`nodejs_eventloop_lag_p50/p90/p99_seconds` from `monitorEventLoopDelay`, 10 ms precision, reset on every scrape) |
| `crash_tick_delay_seconds` | histogram | how much later than planned each tick fired during `RUNNING`                                                                                                                            |

### Tick delay

- The game loop fires ticks with `setInterval`, and Node schedules the next run from the moment the callback ran. The gap between two consecutive ticks minus the tick period is therefore how late that tick was.
- `GameLoopService` measures it in its event handler: `onEvent` is called synchronously from the timer callback, so the handler's clock reading is the firing time. The game loop itself (a learning zone) is not changed; the service passes the tick period to it explicitly instead of relying on the loop's default.
- Each round restarts the measurement at its `started` event, so its first tick is measured from the moment the tick timer was armed. Ticks only fire while the round runs, so betting and the pause never count.
- Buckets: 1, 2.5, 5, 10, 25, 50, 100, 250, 500 ms, 1 s.
- Ticks are display-only (ADR-0002), so a late tick costs smoothness, not money. Event loop lag shows how busy the process is; tick delay shows how much of it reaches the game.

## Alternatives

- **`@willsoto/nestjs-prometheus`:** less wiring, but a global registry and decorators around what is a few lines of code.
- **OpenTelemetry metrics with a Prometheus exporter:** vendor-neutral and ready for traces, but more moving parts than a learning project needs now.
- **Own event loop lag metric:** the Node defaults already expose percentiles from the same `monitorEventLoopDelay`.
- **Tick delay measured inside the game loop:** exact, but changes learning-zone code for an observation the service can make from the outside.

## Consequences

- `/metrics` is public on the app port. Fine locally; a deployment would restrict it.
- Percentiles from a histogram are interpolated within a bucket; the buckets bound their precision.
- Prometheus and Grafana (compose, provisioning, dashboards) and the remaining server metrics are decided in the next steps and recorded here.
