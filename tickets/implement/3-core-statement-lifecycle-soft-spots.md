description: Tighten prepared-statement lifecycle in the SQL engine so concurrent runs can't interleave transactions, a schema listener can't leak, resetting mid-run can't start a second run, and a single-row query binds its parameters only once.
files:
  - packages/quereus/src/core/statement.ts (iterateRows/_allGenerator, compile schema-listener block, reset, ~lines 138-227, 391-422, 549-562)
  - packages/quereus/src/core/database.ts (db.get, ~lines 437-447)
  - packages/quereus/src/util/async-iterator.ts (wrapAsyncIterator — reference for cleanup ordering)
  - packages/quereus/test/statement-iterator-cleanup.spec.ts (existing lifecycle tests; add reproductions here)
difficulty: medium
----

# Core statement lifecycle soft spots

Four independent lifecycle weaknesses in `core/statement.ts` (plus one line in
`core/database.ts`). All small and confined; grouped in one ticket because they
share the same file and test harness. Each has its own reproduction and fix
below. Do them in the order given — (a) is the most delicate.

Background on the two internal iteration paths (important for (a)):

- `iterateRows()` / `all()` / `iterateRowsWithTrace()` are **public** entry points.
- `_iterateRowsRaw()` is the **internal** path used *while the exec mutex is
  already held* — by `run`/`get`/`all` themselves, and by re-entrant callers
  (`foreign-key-actions.ts`, `constraint-builder.ts`, `schema/manager.ts`,
  `database-assertions.ts`, `database.ts` `eval`). It must stay mutex-free or those
  callers deadlock on the chained-promise mutex (`db._acquireExecMutex`).

---

## (a) `iterateRows()` skips the exec mutex

`run`/`get`/`all` serialize through `db._acquireExecMutex()` /
`db._runWithMutex()`; `iterateRows()` does not. Two `iterateRows()` runs from the
same db can interleave the implicit-transaction lifecycle
(`_finalizeImplicitTransaction`), producing wrong transaction boundaries.

`all()` already models the correct shape: `_allGenerator()` (statement.ts:549-562)
acquires the mutex, `yield*`s the rows, and releases in `finally`; the outer
`all()` wraps that generator in `wrapAsyncIterator` for transaction finalize.

**Fix:** give `iterateRows()` the same treatment — an internal generator that
acquires the exec mutex around `_iterateRowsRaw`, released in `finally`, wrapped by
`wrapAsyncIterator` for the implicit-transaction cleanup. Mirror `_allGenerator`
exactly (including the pre-flight `throwIfAborted(signal)` before acquiring the
mutex), but yield raw `Row` (no `rowToObject`).

**Deadlock guard — do NOT touch these:**
- Leave `_iterateRowsRaw` / `_iterateRowsRawInternal` mutex-free.
- Leave `iterateRowsWithTrace` mutex-free. `explain.ts` (lines 473, 627) calls it
  from a table-valued function *during* an outer statement's execution, i.e. with
  the mutex already held; adding a mutex there deadlocks.

**Ordering note (tripwire, not a blocker):** on normal completion
`wrapAsyncIterator` runs the transaction-finalize cleanup *after* the wrapped
generator's `finally` (mutex release) — so the implicit-transaction commit lands
just outside the mutex. This is exactly the existing `all()` behavior, so matching
`all()` keeps `iterateRows` consistent with it; don't try to "improve" the ordering
here. If you notice it's worth documenting, drop a one-line `// NOTE:` at the site
rather than filing follow-up work.

**Reproduce:** two statements over the same db, iterate both with `iterateRows()`
interleaved (pull one row from each alternately), assert implicit-transaction
boundaries aren't corrupted (`db._isImplicitTransaction()` stays coherent) — or,
more simply, assert the second `iterateRows()` observes the mutex is held (its
first pull does not begin until the first iteration releases). Contrast with the
same test on `all()`, which already serializes.

## (b) Schema-change listener leak on zero-dependency recompile

In `compile()` the "remove existing listener" call (statement.ts:167-169) sits
*inside* `if (dependencies && dependencies.hasAnyDependencies())`. When a recompile
yields a plan with **no** dependencies, the old listener is never unsubscribed →
one leaked listener on `schemaManager.getChangeNotifier()` per such recompile.

**Fix:** unconditionally unsubscribe the previous listener *before* the
`hasAnyDependencies()` check, then add a new listener only when there are
dependencies:

```ts
// Always drop the previous listener before (re)compiling.
if (this.schemaChangeUnsubscriber) {
    this.schemaChangeUnsubscriber();
    this.schemaChangeUnsubscriber = null;
}
if (dependencies && dependencies.hasAnyDependencies()) {
    this.schemaChangeUnsubscriber = this.db.schemaManager.getChangeNotifier().addListener(event => { ... });
}
```

**Reproduce:** prepare a statement whose first compile has dependencies (reads a
table) and force a recompile (`needsCompile = true` via a schema change, or
`nextStatement`) into a plan with zero dependencies; assert the change-notifier's
listener count does not grow across repeated recompiles. If the notifier exposes no
count, add a minimal internal accessor or spy in the test.

## (c) `reset()` clears `busy` mid-iteration

`reset()` (statement.ts:416-422) only `warnLog`s and sets `busy = false`. If called
while an iteration is genuinely in flight, clearing `busy` lets a second iteration
pass the `if (this.busy) throw` guard in `_iterateRowsRawInternal` (:308) → two
concurrent iterations over one statement.

Every sibling mutator (`bind`, `bindAll`, `clearBindings`, `nextStatement`) already
**refuses** when busy with `MisuseError("Statement busy, ...")`. `reset` is the
outlier.

**Fix:** make `reset()` refuse when busy, consistent with the siblings:

```ts
async reset(): Promise<void> {
    this.validateStatement("reset");
    if (this.busy) throw new MisuseError("Statement busy, cannot reset an in-flight iteration; complete or finalize it first.");
}
```

Existing callers only `reset()` *after* an iteration has drained or early-exited
(the generator's `finally` already cleared `busy`) — see
`statement-iterator-cleanup.spec.ts:92` and `plan/materialized-view-plan.spec.ts` —
so refusing-when-busy does not regress them. `finalize()` remains the escape hatch
that force-clears `busy`. (Execution is stateless per iteration — a fresh
`Scheduler` per `_iterateRowsRawInternal` — so `reset` has no VM state to roll back
beyond the busy guard.)

**Reproduce:** start an `iterateRows()`/`all()` iteration, pull one row (leaving it
in flight), call `reset()`, assert it throws `MisuseError` and that a second
iteration is not startable until the first completes.

## (d) `db.get()` binds parameters twice

`db.get()` (database.ts:441-443) calls `this.prepare(sql, params)` — the `Statement`
constructor infers parameter types **and** binds the initial values into
`boundArgs` — then `stmt.get(params, options)`, whose `_iterateRowsRawInternal`
calls `bindAll(params)` again (statement.ts:313), rebuilding `boundArgs` and
re-running `isSqlValue` validation over every value.

**Fix:** bind once. Keep `prepare(sql, params)` (its type inference from the values
is useful) and drop the redundant re-bind by not re-passing params:

```ts
const stmt = this.prepare(sql, params);
try {
    // Params were already bound (and their types inferred) by prepare(); don't rebind.
    return await stmt.get(undefined, options);
} finally {
    await stmt.finalize();
}
```

Confirm no other db-level convenience method has the same double-bind: `db.eval`
(database.ts:1623) already does `prepare(sql)` with no params, and `db.exec` takes a
different path — so this is isolated to `db.get`.

**Reproduce:** with parameter-type validation observable (e.g. spy/counter on
`bindAll` or on `isSqlValue`, or count `validateParameterTypes` invocations), call
`db.get(sql, params)` and assert the parameters are bound exactly once.

---

## TODO

Phase 1 — (a) exec mutex on `iterateRows`
- [ ] Add an internal mutex-holding generator mirroring `_allGenerator` (pre-flight
      `throwIfAborted`, `_acquireExecMutex`, `yield* _iterateRowsRaw`, release in
      `finally`) yielding raw `Row`.
- [ ] Point `iterateRows()` at it via `wrapAsyncIterator` + `_finalizeImplicitTransaction`.
- [ ] Verify `_iterateRowsRaw`, `_iterateRowsRawInternal`, and `iterateRowsWithTrace`
      remain mutex-free (no deadlock for re-entrant/explain callers).

Phase 2 — (b) listener leak
- [ ] Move the unsubscribe out of the `hasAnyDependencies()` branch; always drop the
      old listener first, add a new one only when dependencies exist.

Phase 3 — (c) reset guard
- [ ] Make `reset()` throw `MisuseError` when `busy`, matching bind/bindAll/clearBindings.

Phase 4 — (d) single bind
- [ ] Change `db.get()` to bind once (`prepare(sql, params)` then `stmt.get(undefined, options)`).

Phase 5 — tests + validation
- [ ] Add reproductions for (a)-(d) to `test/statement-iterator-cleanup.spec.ts`
      (or a sibling spec) — each should fail before its fix, pass after.
- [ ] `yarn workspace @quereus/quereus run lint` and `yarn test` green
      (stream with `2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`).
- [ ] Skim `docs/runtime.md` for any statement-lifecycle wording that needs a touch;
      update in place if so (no new summary doc).
