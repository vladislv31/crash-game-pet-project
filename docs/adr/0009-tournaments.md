# 0009. Tournaments with a Redis leaderboard

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

The test dashboard needs a switch that starts and stops a tournament. While a tournament runs, every
cashout of a bet of at least 100 coins earns points equal to its multiplier (1.20x then 2.30x make
3.50 points). The bet amount itself is not shown or weighed, so the leaderboard does not reveal how
much people bet. Players see the top 100 in near real time and their own place, whether or not they
are in the top 100. Equal points rank the player who reached them first higher.

Constraints: PostgreSQL stays the source of truth, a Redis restart or outage loses nothing, and with
no tournament running the game behaves exactly as before. One game-server instance for now.

## Decision

**Storage (PostgreSQL).**

- `tournaments`: `id`, `started_at`, `ended_at` (null while active). At most one is active (unique
  index on rows with `ended_at IS NULL`). Starting creates a new tournament; stopping sets
  `ended_at`. Rows are kept as history and never deleted.
- `tournament_entries`: one row per bet that earned points: `tournament_id`, `bet_id` (unique),
  `user_id`, `points` (integer hundredths, the cashout multiplier), `created_at`. Append-only.
- The entry is inserted in the cashout transaction (`payIn`), so all three cashout paths (manual,
  auto-cashout on a tick, settlement sweep) award points, and exactly once: `payIn` only pays an
  ACTIVE bet and `bet_id` is unique.
- The insert first takes `FOR SHARE` on the active tournament row; stopping updates that row, so it
  waits for cashouts in flight, and no entry lands in a finished tournament.
- The moment of the cashout decides: the tournament active when `payIn` runs gets the points, even
  for a bet placed before it started.

**Active flag in memory.** `TournamentsService` holds the active tournament id, loaded from
PostgreSQL on start and changed by the switch. A cashout with no tournament reads nothing extra.

**Leaderboard (Redis, ioredis).** Per tournament: a sorted set with score = total points in
hundredths (an exact integer), member = `<inverted reachedAt>:<userId>`, plus hashes
`userId → member` and `userId → username`. Equal scores sort by member, so the inverted time ranks
the earlier player higher. A Lua script writes a player's total only when it is higher than the
cached one, so the write is idempotent and a late or repeated write never lowers it. Totals are
read from PostgreSQL after the commit, so the cache copies the database instead of counting on
its own; `ZINCRBY` is not used.
Reads: `ZREVRANGE 0 99` for the top 100 and `ZREVRANK` for a player's place.

**Rebuild.** The cache is filled from PostgreSQL with the same script: on start, whenever the Redis
connection becomes ready (also after a Redis restart), and every `TOURNAMENT_REBUILD_INTERVAL_MS`
(default 60 s) while a tournament runs. Because writes only raise totals, a rebuild never undoes a
newer write.

**Redis down.** Commands fail fast (no offline queue). Cashouts are unaffected (Redis is written
after the commit and its errors are only logged); the leaderboard and ranks are sent as
`available: false` and the client hides them.

**Delivery (WebSocket).**

- `tournament:leaderboard`: the top 100 (username, points), broadcast to every authenticated socket
  every `TOURNAMENT_SNAPSHOT_INTERVAL_MS` (default 2 s) while a tournament runs, once when it
  starts and once when it stops. A new connection gets the last one after its snapshot, from
  memory. With no tournament running nothing is broadcast; the last finished tournament's final
  standings (read once from PostgreSQL) are sent to new connections.
- `tournament:rank`: a player's place and points, sent to that player after each of their cashouts
  that earned points, and in answer to a `tournament:rank` request. For a finished tournament it is
  read from PostgreSQL.

**Control.** `GET /tournaments/active` and `PUT /tournaments/active` with `{ "active": boolean }`,
idempotent, without auth (pet project). The test dashboard shows the switch.

## Alternatives

- **`ZINCRBY` per cashout:** simple, but cannot rank the earlier player first on equal points, is
  not idempotent if retried, and floating-point sums drift (1.2 + 2.3 ≠ 3.5).
- **Aggregate row per player (`ON CONFLICT DO UPDATE points = points + x`):** fewer rows, but no
  audit trail and nothing to check the total against.
- **Leaderboard straight from PostgreSQL every 2 s:** fine at this scale, but the goal is to learn
  sorted sets, and ranking every player on request would hit the database.
- **node-redis:** equivalent; ioredis was chosen for its `ready` event on reconnect and
  `defineCommand` for Lua scripts.

## Consequences

- A cashout during a tournament does two more statements in its transaction (lock the tournament,
  insert the entry) and one aggregate read, plus one Redis script after the commit.
- Stopping a tournament waits for cashouts in flight.
- The top-100 broadcast adds fan-out load; performance runs are done with the tournament off.
- Redis becomes a runtime dependency of the game server, but an optional one: it can be down.
