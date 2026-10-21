# Load simulations

Manual load hardcoded into the server to see how the metrics react, before the load generator exists (Phase 4). Each simulation is switched on by an environment variable, so it never runs by accident, and recorded here as:

- **What:** the code added and where, and how to switch it on
- **Expected:** which panels should move and why
- **Observed:** what the dashboard showed (numbers, screenshots)
- **Conclusion:** what it teaches about the server

The panels are described in [observability.md](../observability.md#dashboard-panels).

## Baseline: idle server

No players, the game loop running rounds, macOS laptop.

| Panel            | Value                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| Tick delay       | close to 0                                                                              |
| Ticks per second | 2–10, depending on how long rounds fly (see the panel description)                      |
| Event loop lag   | about 16 ms: the 10 ms measuring interval plus macOS timer slack, so the real lag is ~0 |
| CPU              | close to 0                                                                              |
| Memory           | stable, under 100 MiB                                                                   |
| GC time          | about 0.01%                                                                             |

## CPU: blocking the event loop

**What.** In `main.ts`, a busy loop that holds the event loop for 100 ms every second:

```ts
setInterval(() => {
  const now = performance.now();
  while (performance.now() - now < 100) {}
}, 1000);
```

**Expected.** Nothing else can run while the loop spins: timers, ticks and incoming messages wait for it. Event loop lag and tick delay should rise by up to the block length; CPU should rise by the busy share of time.

**Observed.**

| Panel          | Change                                 |
| -------------- | -------------------------------------- |
| Tick delay     | p99 up to about 100 ms                 |
| Event loop lag | p99 up to about 100 ms                 |
| CPU            | +12%                                   |
| Memory         | small fluctuations, as at the baseline |
| GC time        | unchanged                              |

**Conclusion.**

- The block covers 10% of the time, so it hits about one tick in ten. The median stays near 0 while p95/p99 jump to the block length: averages hide it, tail percentiles show it. Players whose tick lands in the block see the multiplier stall for up to 100 ms.
- The CPU cost is the busy share itself: 100 ms of every 1000 ms is 10% of a core whatever the loop body does (`performance.now()` only tells the loop when to stop), plus the baseline.
- The loop allocates nothing worth collecting, so GC time does not move; memory moves only with the usual noise.
- Any synchronous work on the main thread behaves the same way: a large `JSON.stringify`, a broadcast to thousands of sockets, a heavy calculation. This is why broadcast cost is the first suspect for experiment 1.

## GC: one huge short-lived array

**What.** In `main.ts`, a 10-million-element array allocated every second and dropped half a second later:

```ts
setInterval(async () => {
  const array = new Array(1e7).fill(0);
  await new Promise(resolve => setTimeout(resolve, 500));
}, 1000);
```

**Expected.** About 80 MB of garbage per second (10 million 8-byte elements) should keep the garbage collector busy, and its pauses should show up as event loop lag and tick delay.

**Observed.**

| Panel          | Change                     |
| -------------- | -------------------------- |
| Tick delay     | unchanged                  |
| Event loop lag | up to ~60 ms (idle ~20 ms) |
| Memory         | small sawtooth             |
| GC time        | up to ~1%                  |

Measured separately with `node --trace-gc`: `new Array(1e7).fill(0)` takes 15–21 ms of synchronous work; the array is then freed by one young-generation collection (scavenge) of 1–3 ms.

**Conclusion.**

- The lag comes from creating and filling the array on the main thread, not from collecting it: one array is one object, and freeing it is cheap.
- A ~20 ms block once a second rarely lands on a tick, so tick delay stays flat while the event loop lag peaks show it.
- Many bytes in few objects cost little to collect.

## GC: a million small objects kept alive

**What.** In `main.ts`, a million small objects created every second and kept for two seconds, so two or three batches are alive at once:

```ts
setInterval(async () => {
  const objects = Array.from({ length: 1e6 }, (_, i) => ({ i }));
  await new Promise(resolve => setTimeout(resolve, 2000));
  void objects.length;
}, 1000);
```

**Expected.** The collector has to trace and copy every surviving object, so its pauses should grow with the number of live objects.

**Observed.**

| Panel          | Change                                        |
| -------------- | --------------------------------------------- |
| Tick delay     | p99 ~80 ms                                    |
| Event loop lag | typical percentiles +10–20 ms, peaks 60–80 ms |
| GC time        | ~0.1% (idle ~0.01%, huge array ~1%)           |

Measured separately with `node --trace-gc`: creating the million objects takes 37–61 ms, interleaved with young-generation collections of 1–7 ms each (survivors are copied and promoted to the old generation), followed by a full mark-compact of ~12 ms.

**Conclusion.**

- Collection cost follows the number of live objects: surviving objects are copied out of the young generation and later traced by a full collection on the main thread. Together with the allocation itself this blocks for tens of milliseconds, long enough to delay ticks.
- Compared with the huge array: fewer bytes, far more objects, much more impact. For the game server this points at per-message garbage under load: one object per bet, per broadcast or per log line adds up.
- Open question: GC time rose tenfold over idle (~0.1%) but stayed below the huge array's ~1%, although `--trace-gc` shows longer pauses here. Running the server itself with `--trace-gc` would show which collections the panel counts.
