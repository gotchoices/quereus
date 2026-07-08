description: Prepared statements have several rough edges around concurrency and cleanup that can let two runs interfere, leak a subscription, or bind parameters twice.
files:
  - packages/quereus/src/core/statement.ts (iterateRows, run/get/all, reset, schema-change listener — around lines 164–213 and 390–421)
  - packages/quereus/src/core/database.ts (db.get)
----

## Problem

`core/statement.ts` has four related lifecycle weaknesses. They share a theme —
inconsistent guarding of a statement's execution/iteration lifecycle — so they are
tracked together, but each needs its own reproduction and fix.

**(a) `iterateRows()` skips the exec mutex.** `run()`, `get()`, and `all()`
acquire an execution mutex before running; `iterateRows()` does not. Two
statements iterating concurrently can therefore interleave with the implicit-
transaction lifecycle (auto-begin/commit around a statement), producing incorrect
transaction boundaries or interleaved side effects.

**(b) Schema-change listener leaks.** When a recompile yields no dependencies, the
unsubscribe path is conditional and the schema-change listener is never removed.
Over many recompiles this leaks listeners against the schema-change signal.

**(c) `reset()` does not actually stop in-flight iteration.** `reset()` merely
logs a warning and clears the `busy` flag while an iteration may still be running.
Because `busy` is cleared, a second iteration can start concurrently with the
first — two iterations over one statement at once.

**(d) `db.get()` binds parameters twice.** The `get()` path binds the supplied
parameters, then binds them again, doing redundant work and risking divergence if
binding has any observable effect (e.g. parameter-type validation running twice).

## Expected behavior

- Row iteration is guarded by the same execution mutex as `run`/`get`/`all`, so
  concurrent statement execution cannot interleave implicit-transaction boundaries.
- Recompilation always unsubscribes the previous schema-change listener, including
  when the new compile has zero dependencies — no listener leak across recompiles.
- `reset()` on a statement with iteration in flight either safely tears down the
  active iteration before allowing a new one, or refuses/serializes rather than
  clearing `busy` and permitting a concurrent second iteration.
- `db.get()` binds parameters exactly once.

## Use case

- Two statements from the same database iterated concurrently should not corrupt
  each other's implicit transaction (a).
- Preparing and re-executing statements in a loop should not grow the schema-change
  listener count without bound (b).
- Calling `reset()` mid-iteration and then re-iterating should not run two
  iterations simultaneously (c).
- `db.get(sql, params)` with parameter-type validation enabled should validate the
  parameters once, not twice (d).

## Notes

- Sub-parts are related but independently reproducible/fixable; the resulting
  implement work may be one ticket or split per sub-part — decide during fix.
- Watch that adding a mutex to `iterateRows()` does not deadlock against callers
  that already hold the mutex (e.g. if `all()` internally drives iteration).
