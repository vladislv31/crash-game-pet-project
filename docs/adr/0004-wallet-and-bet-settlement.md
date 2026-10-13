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
- `rounds`: crash point and phase timestamps. The row is written **before betting opens**; betting waits for the write, and a failed write skips to a new round after the pause.
- Money math in JS uses `decimal.js`, never `number`.

### Placing a bet

One transaction:

1. Insert the bet. The unique constraints decide first, so a concurrent retry gets the original bet instead of failing the balance check against the already debited balance.
2. Debit with a conditional update: `UPDATE users SET balance = balance - :amount WHERE id = :id AND balance >= :amount`. No row → roll back → `insufficient_funds`. Then insert a `BET` ledger entry.
3. Last statement before commit: `SELECT clock_timestamp() < betting_ends_at FROM rounds WHERE id = :roundId`. False or no round → roll back → `betting_closed`.

Unique constraints:

- `(user_id, idempotency_key)`: a retried `bet` with the same `requestId` returns the original bet and never debits twice.
- `(user_id, round_id)`: one bet per round → `already_bet`.

A bet takes part in a round only if it is **both** received while betting is open **and** committed before the round starts, with or without auto-cashout. A bet whose write would land after the start is not created at all: the rollback undoes the debit, so there is nothing to refund. Without this rule a slow commit could put a bet into a round the player could no longer act in, and it would be settled as lost.

### Cashout (exactly once)

- The multiplier comes from the round at receipt time (ADR-0002).
- A player's cashout is **one** transaction: find and lock (`FOR UPDATE`) their bet in the round, then pay it. One bounded transaction always ends before settlement starts.
- One transaction: `UPDATE bets SET status = 'CASHED_OUT' … WHERE id = :id AND status = 'ACTIVE'`. Only if that changed a row: credit the balance and insert a `WIN` entry.
- Zero rows: if the bet is `CASHED_OUT` (a repeated or concurrent cashout, or an auto-cashout that came first), the original result is returned; otherwise `already_settled`.
- The database decides the winner of concurrent cashouts, so this holds across instances.

### Auto-cashout and max win

- Effective target = `min(autoCashout, floor(maxWin / amount · 100))`.
- The game loop pays every active bet whose target is reached on each tick, always at the **target**, not the tick value.
- At the crash, tracked bets with a target below the crash point are paid at once: their target fell between the last tick and the crash.
- A manual cashout above the effective target pays the target.

### Settling a round

- Losing bets are **not** closed at the crash: a cashout received just before the crash may still be in its transaction.
- App transactions are bounded: at most 1 s waiting for a pooled connection, at most 3 s per transaction (PostgreSQL `transaction_timeout`). Together they stay below the 5 s pause, so an in-flight cashout commits or fails before settlement starts. Migrations run on a separate connection without these limits, before the app starts.
- Every time a round opens betting, a **settlement sweep** settles every `ACTIVE` bet of every other round, using what is stored in `rounds`:
  - crashed (`crashed_at` set): target below the crash point → cashed out at the target, otherwise `LOST`;
  - interrupted (no `crashed_at`: the server was down when the round should have crashed): **voided**, status `VOID`, the amount is returned with a `REFUND` ledger entry. This follows the usual "malfunction voids all pays and plays" rule: players could not cash out while the server was down.
- The sweep reads the database, not memory, so it also settles bets left by a crash or restart of the instance. A bet that fails to settle is logged and retried by the next sweep. Settling and refunding are idempotent through `WHERE status = 'ACTIVE'`.
- A round continued after a restart (ADR-0002) reloads its bets from the database when it starts, so their auto-cashouts still fire.

### Shutdown

- On shutdown the server stops taking requests, stops the game loop (so no tick or settlement starts new work), waits for money operations in progress (including ones that started meanwhile) and for pending round writes, and only then closes the database connection. Nothing is cut off mid-transaction; anything not started is retried by the client (ADR-0003) or settled by the next instance.

## Alternatives

- **Balance as a sum of the ledger:** no balance column to keep in sync, but every bet needs an aggregate. Rejected for now.
- **Settle interrupted rounds by their crash point** (or pay auto-cashouts and refund the rest): players without auto-cashout could not act while the server was down, so it is unfair to them; the mixed variant always costs the house. Rejected in favour of a full refund.
- **Mark losers at the crash:** simpler, but races with in-flight cashouts and can take a valid win away.
- **Redis locks for exactly-once:** extra moving part; the conditional update already guarantees it.

## Consequences

- Correctness relies on SQL conditional updates and unique constraints, so the core money paths need integration tests against a real PostgreSQL.
- Active bets for auto-cashout are tracked in memory per instance. Phase 5 (several instances) must revisit this.
- Players see losing bets settled about 5 s after the crash.
- The late-bet check compares the database clock with `betting_ends_at`, which the game server computed from its own clock. Fine on one host; several hosts need synchronized clocks (NTP).
- The sweep scans `ACTIVE` bets on every round opening; the existing `(round_id, status)` index does not serve a status-only filter. Acceptable now, revisit before load experiments (e.g. a partial index on `status = 'ACTIVE'`).
