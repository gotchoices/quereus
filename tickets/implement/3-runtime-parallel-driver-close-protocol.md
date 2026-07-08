----
description: When the parallel query driver shuts down its data sources, it tells a source it is finished while that source is still in the middle of producing the previous item — a sequence some data sources are not built to handle safely.
files: packages/quereus/src/runtime/parallel-driver.ts
difficulty: medium
----
`ParallelDriver.closeAll()` (`parallel-driver.ts` approx lines 228-249) calls `it.return()` on its source iterators while a `next()` call on the same iterator may still be pending. Native async generators queue a `return()` behind an in-flight `next()` and handle this safely, but arbitrary vtab `AsyncIterator` implementations — which the parallel driver is meant to drive — are under no obligation to. Calling `return()` concurrently with a pending `next()` violates the async-iterator protocol the driver itself relies on, and a third-party module could misbehave (drop cleanup, throw, or corrupt state).

Expected behavior: `closeAll()` must not invoke `return()` while a `next()` is outstanding for the same iterator. The safe fix is to await (or otherwise settle) each source's pending pull before calling `return()` on it, so cleanup runs strictly after the outstanding `next()` resolves. This keeps the driver correct against any conforming `AsyncIterator`, not just native generators.

## TODO
- In `closeAll()`, for each source with an outstanding `next()` promise, await/settle that promise before calling `return()` (guard against the pull itself rejecting — settle, don't let it throw past cleanup).
- Ensure sources with no pending pull are still `return()`-ed.
- Preserve overall close semantics: all sources get closed, errors from individual closes are aggregated/logged rather than aborting the remaining closes.
- Add or extend a test with a mock `AsyncIterator` (not a native generator) that asserts `return()` is never called while its `next()` is unresolved.
