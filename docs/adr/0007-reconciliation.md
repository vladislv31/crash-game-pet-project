# 0007. Money reconciliation

- **Status:** Accepted
- **Date:** 2026-10-14

## Context

Money correctness rests on conditional updates and unique constraints (ADR-0004), and is tested. Nothing checks it on live data: a stuck bet shows up as an old `ACTIVE` row, but a double payout, a wrong amount or a balance that drifted from the ledger leave every bet settled and look normal. Experiments 3, 4 and 5 also need a clear verdict after each run: does the money add up.

## Decision

### Invariants

Checked over the whole database in one read-only `REPEATABLE READ` transaction, so balances, bets and ledger entries come from the same snapshot. Every money change commits the bet, the balance and the ledger entry together, so any committed state must satisfy all of them, including bets of the round in progress.

| Mismatch type               | Rule                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `balance`                   | a user's balance equals the sum of their ledger entries                                    |
| `bet_entry`                 | each bet has exactly one `BET` entry of minus its amount, for the bet's user               |
| `win_entry`                 | a `CASHED_OUT` bet has exactly one `WIN` entry equal to its payout; other bets have none   |
| `refund_entry`              | a `VOID` bet has exactly one `REFUND` entry equal to its amount; other bets have none      |
| `payout`                    | a `CASHED_OUT` bet's payout equals amount × multiplier / 100 (`payoutFor`, exact decimals) |
| `payout_above_max_win`      | no payout above the max win                                                                |
| `cashout_at_or_above_crash` | a cash-out multiplier is below its round's crash point                                     |
| `orphan_entry`              | every ledger entry with a bet id points at an existing bet of the same user                |

### Running it

- **In the server, periodically:** every `RECONCILIATION_INTERVAL_MS` (default 60 000; `0` turns it off). Runs never overlap: a tick that finds the previous run still going is skipped. Shutdown stops the timer and waits for a run in progress before the database closes.
- **From the command line:** `npm run reconcile -w game-server` runs the checks once, logs the result and exits with code 1 when anything is off, for a verdict right after an experiment.
- **Own connection:** the checks run on a dedicated single-connection pool without the app's 3 s transaction limit (ADR-0004), with a 60 s statement timeout instead. A long full scan neither takes a connection from bets and cashouts nor gets cut off.
- **Full scan every time.** Cheap at this project's scale. An incremental check (only what changed since a watermark) can follow if the scan gets slow under load.

### Results: a log event and metrics, no tables

- One `reconciliation` event per run (ADR-0005): `usersChecked`, `betsChecked`, `mismatches` (total), `mismatchesByType`, up to 20 `examples` with the type, `userId`, `betId` and the amounts that disagree, `outcome` (`ok`, `mismatch`, `failed`), `durationMs`. Logged at `error` when there are mismatches or the run failed. For a balance mismatch only the difference between balance and ledger is logged, not the balance (ADR-0005 logs no balances).
- Metrics (ADR-0006): `crash_reconciliation_mismatches{type}` (gauge, the last completed run, every type reported even at 0) and `crash_reconciliation_last_success_timestamp_seconds` (gauge, the end of the last run that completed, with or without mismatches). A growing gap to now means reconciliation stopped working, which is an alarm too.
- Mismatches are fixed by hand with a corrective ledger entry, never by editing a balance.

## Alternatives

- **Tables for runs and mismatches** (`reconciliation_runs`, `reconciliation_mismatches` with an open/resolved workflow): the production setup, and the base for an admin view. Not needed until there is such a view; the log and the metrics carry the same information for now.
- **Checking in the money path** (assert the invariant inside every transaction): catches the bug at the moment it happens, but adds work to every bet and still misses changes made outside the code.
- **Running on the app pool:** simpler, but a long scan would hold one of the connections bets and cashouts wait for, and would hit the 3 s transaction limit.
- **Excluding recent activity** (only bets settled more than N seconds ago): needed when a check cannot see one consistent snapshot. A single `REPEATABLE READ` transaction gives one, so recent bets are checked too.

## Consequences

- A full scan grows with the number of bets and ledger entries. Long load tests will make it slower; the interval or an incremental check are the levers.
- In Phase 5 every instance would run it. The checks only read, so this is safe but wasteful; one instance should run them (an advisory lock or the round leader).
- History of past runs lives only in logs and Prometheus retention.
