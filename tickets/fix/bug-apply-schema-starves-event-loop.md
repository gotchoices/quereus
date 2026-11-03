description: Applying a schema never gives the JavaScript event loop a turn when the storage backend does no real waiting, so a caller's timeout cannot fire and a browser or mobile interface freezes until the whole migration has finished.
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts # runStepsWithUndoJournal: one await per step, no yield
repro: verified
----

Reported in GitHub issue #34, which includes a self-contained test. Reproduced on the v4.25.0 build: a `setTimeout(fn, 0)` scheduled before a 200-table `apply schema main` had not fired when the apply finished, about 17 ms later.

The reporter's module does no real I/O in its schema hooks, so the stall lasts as long as its schema work takes, and `Promise.race` against a timeout cannot win.

Expected: the migration loop gives up a macrotask turn during a long apply, so timers and interface events run. The yield must work on every supported platform (node, browser, React Native), which rules out node-only primitives. Bound its cost, for example by yielding on elapsed time, so a small apply does not get slower by one timer per step.

The hard part is what a yield exposes: other statements on the same database could now run between steps. Work out what prevents a statement from seeing, or writing into, a half-applied schema before adding the yield, and whether the undo journal survives it. A timer firing does not cancel the apply, so the docs must not imply that it does; cancellation is a separate request.
