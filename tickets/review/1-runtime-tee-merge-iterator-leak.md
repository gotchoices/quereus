description: When a query stops reading a data stream early, the stream split/combine helpers forgot to close the underlying source, so row buffers and table connections were never released. Fixed both helpers and added regression tests.
files: packages/quereus/src/runtime/async-util.ts, packages/quereus/test/runtime/async-util.spec.ts
difficulty: medium
---

Reviewer: treat the implementation as a starting point and the tests below as a floor, not a ceiling. These two helpers are **dead code today** (see "Dormant" below), so there is no SQL-level path to exercise; the unit tests are the only verification available.

## What changed

Two stream-combinator helpers in `runtime/async-util.ts` leaked their source async iterators on any non-drain exit (early break / throw). All engine sources are async generators, so `iterator.return()` runs their `finally` — which is where row slots are freed and vtab `disconnect` fires. Neither helper ever called it.

### `tee()` — source never closed
Refactored the two near-identical stream generators into a single `createStream(self: 0|1)` factory sharing an `indices = [0, 0]` array.
- **Refcount** `liveConsumers` counts consumer generators actually *entered* (incremented at the top of the async generator body), not the two stream objects existing. Each body is wrapped in `try/finally`; the finally decrements and, when it hits zero, calls `closeSource()`. Covers normal completion, early `break`, and throw.
- `closeSource()` is guarded by a `srcClosed` flag so it fires **at most once**, and only calls `srcIterator.return()` when the source did **not** drain naturally (`!srcDone`) and the iterator was actually created (early break before any pull leaves it `null`). On full drain the source `finally` already ran, so we just mark it closed — no redundant `return()`.
- `fillBuffer()` calls `closeSource()` when it observes `srcDone`, so the closed flag is set deterministically on the drain path.

### `merge()` — source never closed + O(sources) per-row allocation
- **Allocation:** each source's pending `next()` promise is now tagged with its index **once at creation** (`pull(index)` stores `iterators[index].next().then(result => ({ index, result }))`). The loop races over `pending.values()` directly. Previously every iteration rebuilt an `entries` array and wrapped *every* pending promise in a fresh `.then` for the race — O(pending) wrappers per emitted row, plus ever-growing handler chains on slow sources. Now only the settled source is re-pulled.
- **Leak:** a `live` Set tracks indices not yet fully drained, **separate from `pending`**. They diverge in exactly one case: when the consumer breaks right after we yield a value, that source has been deleted from `pending` but not yet re-pulled — its generator is suspended at a `yield` and still needs closing. (This was a real gap: keying cleanup off `pending` alone missed it — caught by the early-break test during implementation.) The drain loop is wrapped in `try/finally`; the finally `return()`s every index still in `live`, swallowing+logging (`log('merge: error closing source %d…')`) individual close errors so one failing close cannot mask the others or the original error.
- Semantics preserved: yield as soon as any source produces; a `done` source is dropped from `live`/`pending` and not re-pulled.

## Tests — `test/runtime/async-util.spec.ts` (new, Mocha + chai)

Helper `makeSource(items, { throwAt? })` returns `{ iterable, state }` where `state` counts `nextCalls` / `returned` (wrapper-observed) and `finallyRan` (the inner generator's `finally` — distinguishes real cleanup from a no-op `return()` on an already-completed generator).

**tee:**
- consumer breaks early → `return()` called once, source `finally` ran once.
- both consumers fully drain (concurrently, interleaving the shared buffer) → `finally` ran once, **no** redundant `return()`.
- second stream never iterated, first drains → source released via natural completion.
- manual step: enter both, `a.return()` early → source NOT closed while `b` live; `b.return()` → closed once (last-consumer-out).

**merge:**
- yields all items from all sources.
- consumer early break → **every** still-live source `return()`-ed exactly once (this is the case that exposed the `pending` vs `live` gap).
- a source `next()` throwing on first pull → error propagates to the consumer AND the live sibling is closed once.
- full drain → no source left open, no double-close.
- allocation guard: each source pulled exactly `items+1` times (N values + terminating done) — proves no per-row re-wrap.

## Validation run
- `yarn workspace @quereus/quereus run test` → **6510 passing, 9 pending, 0 failing** (includes the 9 new cases).
- `yarn workspace @quereus/quereus run lint` → clean (eslint + `tsc -p tsconfig.test.json` type-check of the new spec).

## Notes / known gaps for the reviewer

- **Dormant.** `tee`/`merge` are exported but imported nowhere in `src` or `test` (confirmed: `async-util` has zero importers). This is correctness-hardening ahead of first use. The alternative was to delete the unused helpers; kept+fixed per the explicit ticket direction, as they are plausibly wanted for future stream fan-out/merge paths. If the reviewer would rather delete them, that is a clean call too.
- **Tripwire (not a ticket):** `tee()`'s buffer trim keys off the *slower* consumer's index (`Math.min(indices[0], indices[1])`). If one consumer is never iterated while the other drains a large source, the buffer grows unbounded. Pre-existing behavior, unchanged by this fix; fine for the intended both-sides-consumed use. Parked as a `NOTE:` at the trim site in `async-util.ts`. Only bites if a caller tees then abandons one side over a big stream.
- **Test-only verification.** No SQL/integration coverage is possible while the helpers are dead. The unit tests use spy async generators; they assert cleanup *is invoked*, not that a real vtab disconnected — because there is no live wiring to a vtab yet. When a first real caller lands, an integration test against an actual cursor source would be worth adding.
- `buffered()` (same file) already had the correct `finally { srcIterator.return() }` shape; the tee fix mirrors it (extended to the two-consumer refcount case).
