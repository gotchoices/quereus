description: When a query stops reading a data stream early, the stream split (`tee`) and combine (`merge`) helpers forgot to close the underlying source, so row buffers and table connections were never released. Both helpers fixed and regression-tested.
files: packages/quereus/src/runtime/async-util.ts, packages/quereus/test/runtime/async-util.spec.ts
difficulty: medium
---

Fixed source-iterator leaks in the two stream-combinator helpers in `runtime/async-util.ts`. All engine sources are async generators, so `iterator.return()` runs their `finally` — where row slots are freed and vtab `disconnect` fires. Neither helper called it on a non-drain exit (early break / throw).

## What shipped (implement stage)

- **`tee()`** — refactored the two duplicated stream generators into one `createStream(self: 0|1)` factory sharing an `indices = [0,0]` array. A `liveConsumers` refcount (incremented at generator entry, decremented in a `try/finally`) closes the source once the last *entered* consumer leaves — covering normal completion, early break, and throw. `closeSource()` is guarded by `srcClosed` so it fires at most once and skips a redundant `return()` when the source already drained naturally.
- **`merge()`** — (1) leak fix: a `live` Set tracks not-yet-drained sources separately from `pending`; the drain loop's `finally` `return()`s every still-live source, logging (not swallowing) individual close errors. The Set/Map split matters in exactly one case — consumer breaks right after a yield, when the source is out of `pending` but still suspended at its yield. (2) allocation fix: each source's pending `next()` promise is index-tagged once at creation, so `Promise.race(pending.values())` no longer re-wraps every pending promise per emitted row.

## Review findings

**Scope reviewed:** the full implement diff (`d61382fd`) with fresh eyes against the source file, plus a hunt for correctness/resource/concurrency defects, an unhandled-rejection analysis of `merge`, and a docs/caller sweep.

**Correctness — clean.** Traced every exit path of both helpers:
- `tee` last-consumer-out refcount, `srcClosed` once-only guard, and drain-path `closeSource()` all pair correctly; concurrent-decrement in `finally` is race-free (the `liveConsumers--` and `=== 0` check are synchronous before any await).
- `merge` `live` vs `pending` divergence is handled correctly for early-break-at-yield, source-throw, and full-drain. **No unhandled-promise-rejection path exists**: every pending promise is attached to a `Promise.race` (which installs a handler) before the loop can exit, so a sibling that rejects after a break is still handled; the just-won source is re-pulled *after* the yield, so on break it is not in `pending` and cannot leak a rejection.
- Zero-source `merge()` and no-`return()` iterators are both guarded.

**Resource cleanup — clean.** This is the ticket's subject and it is correct: both non-drain exits (break/throw) now release, drain paths do not double-`return()`. Verified against the already-correct `buffered()` shape in the same file.

**Test coverage — one gap fixed inline (minor).** The implementer's 9 cases cover happy path, early break, full drain, no-double-close, allocation guard, never-iterated stream, and last-consumer-out for `tee`; and yield-all, early-break-closes-all, source-throw-closes-siblings, no-double-close, and allocation guard for `merge`. **Gap:** `merge` covered the error path but `tee` did not. Added `tee` test `propagates a source error to the consumer and runs its finally` (`throwAt: 1` → yields 1 then throws). Suite now **10 async-util cases / 6511 total passing**.

**Tripwires (recorded, not ticketed):**
- `tee()` buffer trim keys off the *slower* consumer's index — if one side is never iterated while the other drains a large source, the buffer grows unbounded. Pre-existing, fine for the intended both-sides-consumed use. Already parked as a `NOTE:` at the trim site (`async-util.ts:138`). Introduced by neither this fix.
- The same trim block has a second, pre-existing subtlety: under *concurrent* drain past 100 items, an in-flight `fillBuffer(targetIndex)` holds a frozen `targetIndex` while the peer consumer's trim splices the shared buffer and shifts `indices`. Self-correcting in practice (the outer loop re-reads `indices[self]` fresh each iteration; worst case is one extra/short pull, not data corruption) and requires both sides draining concurrently past the 100-item watermark — the exact regime the existing unbounded-growth NOTE already flags as "revisit." Left as-is; parked here rather than as a new comment to avoid cluttering the same block.

**Docs — checked, no change needed.** `tee`/`merge` are not referenced in `docs/` (runtime.md et al.) or `README.md`; they remain dead code (zero importers in `src`/`test`, re-confirmed). No doc reflects them, so none went stale.

**Dead-code disposition:** kept-and-fixed per explicit ticket direction (plausibly wanted for future stream fan-out/merge). Deleting them was a valid alternative; not taken.

## Validation

- `yarn workspace @quereus/quereus run test` → **6511 passing, 9 pending, 0 failing** (includes the added `tee` error-path case).
- `yarn workspace @quereus/quereus run lint` on this ticket's diff → **clean** (exit 0, verified before an unrelated concurrent edit landed).

## Known unrelated failure at hand-off (NOT this ticket)

The final `lint` run failed on `src/vtab/memory/layer/safe-iterate.ts` (`keyFromEntry` now private). Root cause is a **concurrent, uncommitted** `inheritree` `^0.4.0` → `^1.0.1` bump in the working tree (`package.json` + `yarn.lock`, from the in-flight ticket editing `inheritree-cow-delete.spec.ts`), which changed the BTree API. Outside this ticket's diff (`vtab/memory` BTree layer); committed HEAD pins `inheritree ^0.4.0` under which lint is clean. Recorded in `tickets/.pre-existing-error.md` for triage; not fixed here (belongs to the inheritree-upgrade ticket).
