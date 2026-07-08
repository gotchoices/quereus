----
description: When a query stops reading a data stream early, the machinery that splits or combines streams forgets to tell the underlying source it is done, so resources like row buffers and table connections are never released.
files: packages/quereus/src/runtime/async-util.ts
difficulty: medium
----
Two stream-combinator helpers in `runtime/async-util.ts` leak their source iterators and, in one case, allocate unboundedly:

**`tee()` (approx lines 43-118).** `tee` fans one source iterator out to multiple consumers. If a consumer breaks out of its loop early, `tee` never calls `srcIterator.return()`, so the source's `finally` block never runs — row slots are not freed, and vtab `disconnect` never fires. The source must be closed once all consumers are done (or all have abandoned). Direction: refcount live consumers and call `srcIterator.return()` when the count drops to zero (or on the last consumer's early termination), so the source cleanup path runs deterministically.

**`merge()` (approx line 238).** `merge` interleaves several source iterators. Two problems: (1) on early consumer break or on a source throwing, the still-live source iterators are never `return()`-ed (same leak as above); (2) it re-wraps every pending source promise on every loop iteration, so it allocates O(sources) wrapper promises per emitted row and builds unbounded promise-handler chains. Direction: tag each source's pending `next()` promise with its source index once (so a settled source can be identified and re-pulled without re-wrapping all the others), and wrap the drain loop in `try/finally` that closes every still-live source iterator on exit — whether that exit is normal completion, consumer break, or a source error.

Expected behavior: for both helpers, every source iterator's `finally`/cleanup runs exactly once regardless of how consumption ends (full drain, early break, error), and `merge` does not allocate per-row-per-source promise wrappers. Add tests covering early-break and mid-stream-error termination that assert source cleanup (e.g. a spy `return()` / disconnect) fires.
