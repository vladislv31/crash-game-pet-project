# 0002. Game core design

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The game core decides when a round crashes, how the multiplier grows and how long each phase lasts. It must be provably fair (players can verify the crash point was not changed after bets were placed) and simple enough to build first, before WebSockets, money and scaling.

## Decision

### Provably fair: random seed per round with commit–reveal

- Before betting opens, the server generates `serverSeed` = 32 random bytes (`crypto.randomBytes`) and persists it.
- `BETTING` start: the server publishes `seedHash = sha256(serverSeed)`.
- After `CRASHED`: the server reveals `serverSeed`. Anyone can check `sha256(serverSeed) === seedHash` and recompute the crash point.

### Crash point

- `h` = first 52 bits (13 hex chars) of `HMAC-SHA256(key = serverSeed, message = roundId)`, `e = 2^52`.
- `crashPoint = max(1.00, floor(99 · e / (e − h)) / 100)`.
- This gives a **1% house edge**: `P(crash ≥ x) ≈ 0.99 / x`, and about 1% of rounds crash instantly at 1.00x.
- No max multiplier cap.

### Multiplier curve

- `m(t) = e^(k · t)`, where `t` is milliseconds since `RUNNING` started and `k = 0.000107` (≈ `ln 2 / 6500`, so 2x at about 6.5 s).
- Inverse: `crashTimeMs = ln(crashPoint) / k`. The server ends the round at this exact time, independent of ticks.
- Displayed and paid multipliers are floored to 2 decimals.

### Round timings

| Phase                 | Duration                  |
| --------------------- | ------------------------- |
| `BETTING`             | 15 s                      |
| `RUNNING`             | until `crashTimeMs`       |
| `CRASHED` (pause)     | 5 s                       |
| Tick broadcast period | 100 ms (during `RUNNING`) |

### Rules

- A cashout is valid only if the server receives it at `t < crashTimeMs`. The multiplier comes from the server clock at receipt time, never from the client.
- Ticks are display-only. They do not decide the crash moment or cashout validity.

## Alternatives

- **Hash chain (Bustabit-style):** precompute a chain of seeds and play it in reverse, so the operator commits to all future rounds at once. Stronger, but more setup (chain generation, storage, a published terminating hash). Postponed.
- **Crash time from ticks** (check `m ≥ crashPoint` on each tick): simpler, but the crash moment depends on tick timing and drifts under load.

## Consequences

- The core is a set of pure functions (crash point, curve, inverse curve) plus a state machine. All of them can be unit-tested without I/O.
- `serverSeed` is persisted before the round starts, so a restarted instance can finish the round with the same crash point (needed for experiment 3).
- Players must trust each round's commit individually. Moving to a hash chain later changes only seed generation; the crash point formula stays the same.
