# 0002. Game core design

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The game core decides when a round crashes, how the multiplier grows and how long each phase lasts. This is a learning project with no real money, so players do not need to verify fairness. The core must be simple enough to build first, before WebSockets, money and scaling.

## Decision

### Crash point

- Not provably fair: no seeds, no published hashes.
- Before betting opens, the server draws `h` = a uniform random integer in `[0, 2^52)` from `node:crypto` (not `Math.random`), computes the crash point and persists it. `e = 2^52`.
- `crashPoint = min(10 000, max(1.00, floor(99 · e / (e − h)) / 100))`.
- This gives a **1% house edge**: `P(crash ≥ x) ≈ 0.99 / x`. About 1.98% of rounds end at 1.00x: the 1% house zone plus rounds whose value in `[1.00, 1.01)` floors to 1.00x.
- The crash point is an integer in hundredths (`198` = 1.98x, max `1 000 000`). The division runs in BigInt because `99 · 2^52` exceeds `Number.MAX_SAFE_INTEGER`; the capped result is returned as `number`.
- **Max multiplier cap: 10 000x.** It bounds the round length (`ln(10 000) / k` ≈ 86 s) and keeps the value small enough for `number`. About 0.0099% of rounds reach the cap.

### Multiplier curve

- `m(t) = e^(k · t)`, where `t` is milliseconds since `RUNNING` started and `k = 0.000107` (≈ `ln 2 / 6500`, so 2x at about 6.5 s).
- Inverse: `crashTimeMs = ln(crashPoint) / k`. The server ends the round at this exact time, independent of ticks.
- Displayed and paid multipliers are floored to 2 decimals.

### Round timings

| Phase                 | Duration                         |
| --------------------- | -------------------------------- |
| `BETTING`             | 15 s                             |
| `RUNNING`             | until `crashTimeMs` (max ≈ 86 s) |
| `CRASHED` (pause)     | 5 s                              |
| Tick broadcast period | 100 ms (during `RUNNING`)        |

### Rules

- A cashout is valid only if the server receives it at `t < crashTimeMs`. The multiplier comes from the server clock at receipt time, never from the client.
- Ticks are display-only. They do not decide the crash moment or cashout validity.

## Alternatives

- **Provably fair, per-round seed with commit–reveal:** publish `sha256(serverSeed)` before betting, reveal the seed after the crash, derive `h` from the seed (or `HMAC(serverSeed, roundId)`). Not needed without real money. Can be added later by changing only where `h` comes from.
- **Provably fair, hash chain (Bustabit-style):** commits to all future rounds at once. Strongest option, most setup. Not needed.
- **Crash time from ticks** (check `m ≥ crashPoint` on each tick): simpler, but the crash moment depends on tick timing and drifts under load.

## Consequences

- The cap limits the round, not the money. A max win per bet (auto-cashout when `bet × m` reaches the limit) belongs to the money flow and is planned for Phase 2.
- The core is a set of pure functions (crash point, curve, inverse curve) plus a state machine. All of them can be unit-tested without I/O.
- The crash point is persisted before the round starts, so a restarted instance can finish the round with the same crash point (needed for experiment 3).
- Players cannot verify fairness. Acceptable for a project without real money.
