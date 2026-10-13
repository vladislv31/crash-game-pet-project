# 0004. Wallet and bet settlement

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Bets move money: a bet debits the balance, a cashout credits it. Experiment 4 sends duplicate cashouts and expects exactly one payout, and later phases run several instances. Money correctness must therefore come from the database, not from in-memory state.

## Decision

### Limits

| Rule                | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Starting balance    | 5 000                                                      |
| Bet amount          | 100 – 1 000, up to 2 decimal places                        |
| Bets per player     | one per round                                              |
| Auto-cashout target | 1.01x – 10 000x (`101` – `1 000 000` hundredths), optional |
| Max win per bet     | 100 000 (chosen by Claude; confirm or change)              |

### Storage (PostgreSQL)

- `users.balance` `numeric(40,18)` plus an append-only `ledger_entries` table (`INITIAL`, `BET`, `WIN`). Both change in the same transaction.
- `bets`: `ACTIVE → CASHED_OUT | LOST`, with `cashout_multiplier` and `payout`.
- `rounds`: crash point and phase timestamps, written when the round is created, before bets reach the database.
- Money math in JS uses `decimal.js`, never `number`.

### Placing a bet

One transaction:

1. Debit with a conditional update: `UPDATE users SET balance = balance - :amount WHERE id = :id AND balance >= :amount`. No row → `insufficient_funds`.
2. Insert the bet and a `BET` ledger entry.

Unique constraints:

- `(user_id, idempotency_key)`: a retried `bet` with the same `requestId` returns the original bet and never debits twice.
- `(user_id, round_id)`: one bet per round → `already_bet`.

Betting must be open when the message is received.

### Cashout (exactly once)

- The multiplier comes from the round at receipt time (ADR-0002).
- One transaction: `UPDATE bets SET status = 'CASHED_OUT' … WHERE id = :id AND status = 'ACTIVE'`. Only if that changed a row: credit the balance and insert a `WIN` entry. Zero rows → `already_settled`.
- The database decides the winner of concurrent cashouts, so this holds across instances.

### Auto-cashout and max win

- Effective target = `min(autoCashout, floor(maxWin / amount · 100))`.
- The game loop pays every active bet whose target is reached on each tick, always at the **target**, not the tick value.
- At the crash, tracked bets with a target below the crash point are paid at once: their target fell between the last tick and the crash.
- A manual cashout above the effective target pays the target.

### Settling a round

- Losing bets are **not** closed at the crash: a cashout received just before the crash may still be in its transaction.
- When the next round opens betting (5 s after the crash), each remaining `ACTIVE` bet of the previous round is settled: target below the crash point → cashed out at the target (covers bets committed too late to be tracked), otherwise `LOST`.

## Alternatives

- **Balance as a sum of the ledger:** no balance column to keep in sync, but every bet needs an aggregate. Rejected for now.
- **Mark losers at the crash:** simpler, but races with in-flight cashouts and can take a valid win away.
- **Redis locks for exactly-once:** extra moving part; the conditional update already guarantees it.

## Consequences

- Correctness relies on SQL conditional updates and unique constraints, so the core money paths need integration tests against a real PostgreSQL.
- Active bets for auto-cashout are tracked in memory per instance. Phase 5 (several instances) must revisit this.
- Players see losing bets settled about 5 s after the crash.
