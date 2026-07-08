description: When a query stops reading a data stream early, the machinery that splits or combines streams forgets to tell the underlying source it is done, so resources like row buffers and table connections are never released.
files: packages/quereus/src/runtime/async-util.ts, packages/quereus/src/runtime/utils.ts, packages/quereus/test/runtime/async-util.spec.ts (new)
difficulty: medium
---

Two stream-combinator helpers in `runtime/async-util.ts` — `tee()` (lines ~72-147) and `merge()` (lines ~256-282) — leak their source iterators when consumption ends by anything other than a full drain, and `merge()` additionally allocates unboundedly. Fix both plus add regression tests.

## Background / current state

`getAsyncIterator(src)` (`runtime/utils.ts:46`) returns the source's async iterator. All engine sources are async generators (cursors are `AsyncIterable<Row>`), so the returned iterator **has a `.return()` method** — calling it runs the generator's `finally` block, which is where row slots are freed and vtab `disconnect` fires. Neither `tee` nor `merge` ever calls `.return()`.

**Dormant defect.** `tee` and `merge` are currently exported but **not imported anywhere** in `src` or `test` (confirmed by grep — the many `merge`/`tee` hits elsewhere are merge-join / filter-merge / `.merge()` methods, unrelated). So there is no live query path leaking today; the bug bites the moment a caller wires these in. That makes verification **test-only** — you cannot reproduce through SQL. Write direct unit tests against the helpers with a spy async generator whose `finally` sets a flag / whose `return()` is observable.

## The two bugs

### `tee()` — source never closed
`tee` fans one source out to two consumer streams via a shared `buffer`, filling on demand through `srcIterator`. If a consumer `break`s early (or both consumers finish without fully draining), `srcIterator.return()` is never called, so the source `finally` never runs. Full drain also never closes the source explicitly (it relies on `result.done`, which is fine only for full drain).

**Direction:** refcount the two live consumer streams. When a consumer's `[Symbol.asyncIterator]()` generator exits — normal completion **or** early break/throw (wrap its body in `try/finally`) — decrement. When the count reaches zero, call `srcIterator.return()` once (guard with a `srcClosed` flag so it fires exactly once, and only if `srcIterator` was ever created — early break before any pull leaves it `null`). Note both consumers may not be started; a stream never iterated should still not wedge cleanup — base the refcount on generators actually entered, and additionally close the source if it is fully drained (`srcDone`) so a normal both-drain path still releases deterministically.

### `merge()` — sources never closed + O(sources) per-row allocation
```
while (pending.size > 0) {
  const entries = Array.from(pending.entries());
  const promises = entries.map(([index, promise]) => promise.then(result => ({ index, result })));
  const { index, result } = await Promise.race(promises);
  ...
}
```
Two problems:
1. **Leak:** on consumer early-break (generator `.return()` called by the `for await` that consumes `merge`) or on a source `next()` throwing, the still-live source iterators are never `return()`-ed.
2. **Allocation:** every loop iteration rebuilds `entries` and wraps **every** pending promise in a fresh `.then(...)` for the `Promise.race`. That is O(pending) wrapper promises allocated per emitted row, and re-`.then`-ing the same underlying promise each iteration builds ever-growing handler chains on slow sources.

**Direction:**
- Tag each source's pending `next()` promise **once** with its index at creation: store `promise.then(result => ({ index, result }))` (or an equivalent `{index, result}`-resolving promise) in the `pending` map, so `Promise.race(pending.values())` can identify the winner and only the settled source gets re-pulled — no per-iteration re-wrap of the others.
- Wrap the whole drain loop in `try/finally`. In `finally`, iterate all iterators whose index is still in `pending` (i.e. still live / not yet exhausted) and call `.return()` on each, swallowing/​logging individual errors so one failing close does not mask the others or the original error. This covers all three exit modes: full drain (pending empty → nothing to close), consumer break (generator `.return()` unwinds through the `finally`), and source throw (error propagates through the `finally`).
- Preserve current semantics: yield items as soon as any source produces; a `done` source is dropped from `pending` and not re-pulled.

## TODO

- [ ] `tee()`: add refcount + `srcClosed` guard; wrap each consumer generator body in `try/finally` that decrements and closes the source on last-out; also close on full `srcDone` drain. Ensure `srcIterator.return()` fires exactly once and only when the iterator exists.
- [ ] `merge()`: tag pending promises with their source index once (no per-iteration re-wrap); race over `pending.values()`; wrap drain loop in `try/finally` that `.return()`s every still-live source iterator, tolerating individual close errors (log via the module `log`, don't eat silently per AGENTS.md).
- [ ] New test file `packages/quereus/test/runtime/async-util.spec.ts` (Mocha, matches existing `test/runtime/*.spec.ts` style). Use a helper async generator with an observable `finally` (e.g. increments a `closed` counter) and/or an overridden `return()` spy. Cover:
  - `tee`: consumer-1 early `break` after N items → source closed once after both consumers release; full drain of both → source closed once (no double-close); one consumer never iterated → other draining still releases.
  - `merge`: consumer early `break` → all still-live sources `return()`-ed exactly once; a source `next()` throwing mid-stream → error propagates AND every other live source is closed; full drain → no source left open, no double-close.
  - Optional allocation guard: assert `merge` does not re-wrap — e.g. spy that source `.next()` is called exactly once per consumed item per source (not per emitted row across all sources).
- [ ] `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/test.log; tail -n 40 /tmp/test.log` and `yarn workspace @quereus/quereus run lint` (lint type-checks test files too — catches spec signature drift).

## Notes for reviewer

- These helpers are dead code today (see "Dormant defect" above). The fix is correctness-hardening ahead of first use; the only exercise is the new unit tests. If review prefers, the alternative was to delete the unused helpers instead — chose to fix+keep since the ticket direction is explicit and they are plausibly wanted for future stream fan-out/merge paths.
- `buffered()` (lines ~152-201) already does the `finally { srcIterator.return() }` pattern correctly — mirror its shape.
