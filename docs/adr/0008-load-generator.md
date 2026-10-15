# 0008. Load generator and test dashboard

- **Status:** Accepted
- **Date:** 2026-10-14

## Context

Phase 6 experiments need many players at once: thousands of connections for experiment 1, concurrent duplicate cashouts for experiment 4, steady play while an instance is killed for experiment 3. Server metrics (ADR-0006) explain why latency grows; only a client can measure the latency a player actually sees. The load must be started, tuned and stopped without editing code, and its results must sit next to the server metrics.

## Decision

### Shape

- A separate Node process, `apps/load-generator`, plain TypeScript without NestJS: the generator's own overhead distorts what it measures, so it stays small. Bots are WebSocket clients on `ws` speaking the protocol from `@crash/contracts`.
- It runs on the host next to the game server (`GAME_SERVER_URL`, default `http://localhost:3000`) and listens on port 3100 (`PORT`).
- Control over HTTP: list presets, start a run with a scenario, stop it, read its status; live numbers as Server-Sent Events, once a second. Invalid scenarios get HTTP 422 with `{ errors: { field: 'errorKey' } }`.
- One run at a time. Starting while a run is active is rejected (HTTP 409).
- The test dashboard is a page of `apps/web` (`/lab`, ADR-0001: one app for the player UI and the dashboard): a scenario form with presets, start and stop, live numbers. Vite proxies `/generator` to the generator. Charts stay in Grafana, not duplicated in the page.
- The generator exposes `GET /metrics` (prom-client, own registry, Node defaults). Prometheus scrapes it as a second job; the Game server dashboard gets a **Players** section, so the player view and the server view share one time axis.
- Logs follow ADR-0005: one JSON logger, one wide event per run (`load_run`: scenario, bots started, requests and errors by type, outcome, duration).

### Scenario

| Field                      | Meaning                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bots`                     | number of bots, 1–20 000                                                                                         |
| `rampPerSecond`            | bots connecting per second                                                                                       |
| `durationSeconds`          | stop on its own after this long; `null` runs until stopped                                                       |
| `betProbability`           | chance a bot bets in a round, 0–1                                                                                |
| `betAmount` `{ min, max }` | whole amounts within the bet limits (100–1 000)                                                                  |
| `autoCashoutShare`         | share of bets placed with an auto-cashout target, 0–1; the rest cash out manually                                |
| `target` `{ min, max }`    | cash-out multiplier in hundredths, drawn per bet, for both auto and manual cash-outs                             |
| `duplicateCashouts`        | identical cashout requests (same `requestId`) a manual bot sends at once; 1 is normal play, more is experiment 4 |

Presets in the repo: `steady` (100 bots), `ramp` (1 000 bots at 10/s), `spike` (2 000 bots at 500/s), `duplicate-cashouts` (50 bots, manual only, 10 copies per cashout).

### Bots

- Each bot logs in through `POST /auth/login` with a name unique to the run, `bot_<run id>_<n>` (the run id is 6 random characters), so every run starts with fresh players at the starting balance and old runs never drain their balance.
- In each round a bot decides whether to bet; the bet is planned at a random moment in the first half of the betting phase.
- A manual cash-out is planned on the bot's own clock: from the moment it received `round:started`, plus the time the curve takes to reach its target (the same formula as the server, ADR-0002). Ticks are not needed to decide it, as for the web client.
- A bot reconnects with the same token after a close with code 1012 or a dropped connection; after 4401 it stops.

### What a run measures

- **Request latency** for bets and cash-outs, by type and result, **from the planned moment**, not from the moment the bot got around to sending. When the generator or the server falls behind, the time a request waited to be sent counts, so overload is not hidden (coordinated omission).
- **Tick jitter**: the gap between consecutive `round:tick` messages minus the 100 ms period. Absolute tick delay is not measured: the generator's and the server's clocks are not synchronized.
- Connections open, connect time, disconnects and reconnects, errors by code.
- **The generator's own event loop lag.** When it rises, the generator is the bottleneck and the run's latencies are not trustworthy.

Metric names start with `loadgen_`. After a money run, `npm run reconcile -w game-server` (ADR-0007) gives the verdict.

## Alternatives

- **Bots in the browser:** no install, but a tab cannot hold thousands of sockets, and the page's own rendering would distort latency.
- **NestJS for the generator:** consistent with the server, but a framework the generator does not need adds overhead to every measurement.
- **k6 as the main tool:** efficient (Go runtime) and Grafana-friendly, but the bot behaviour (planned manual cash-outs, duplicate cash-outs) and the control from our UI are simpler in TypeScript with the shared contract. k6 stays as a second opinion for Phase 6.
- **Charts in the test dashboard:** Grafana already has them next to the server metrics; the page shows live numbers only.
- **Measuring from the actual send time:** simpler, but under overload it reports how fast requests were answered once sent, not how long players waited.

## Consequences

- One generator process is limited by its own CPU and, on macOS, by about 16 000 ephemeral ports per destination address (49152–65535), plus `ulimit -n`. Experiment 1 beyond that needs several source addresses or several generators.
- Every run creates new users in the database. Fine for a test database; a cleanup can come later.
- The bot's decision logic is pure and unit-tested; the socket and HTTP layers are thin adapters around it.
