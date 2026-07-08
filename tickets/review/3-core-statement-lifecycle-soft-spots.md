description: Review four small prepared-statement lifecycle fixes in the SQL engine — serializing one iteration path, plugging a listener leak, refusing an unsafe reset, and removing a duplicate parameter-bind.
files:
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/test/statement-iterator-cleanup.spec.ts
difficulty: medium
----

# Review: core statement lifecycle soft spots

Four independent lifecycle weaknesses in `core/statement.ts` (plus one line in
`core/database.ts`) were fixed. All small, confined, and covered by new
reproductions in `test/statement-iterator-cleanup.spec.ts` under the
`describe('Lifecycle soft spots')` block. Build/lint (`yarn workspace
@quereus/quereus run lint`, EXIT 0) and the full suite (`yarn test`: quereus
6521 passing / 9 pending, all sibling packages green, EXIT 0) pass.

## What changed

### (a) `iterateRows()` now serializes through the exec mutex
`iterateRows()` previously called `_iterateRowsRaw` directly with no mutex, so
two `iterateRows()` runs on the same db could interleave the implicit-transaction
lifecycle. Added `_iterateRowsGenerator` (mirrors the existing `_allGenerator`):
pre-flight `throwIfAborted(signal)`, `await db._acquireExecMutex()`, `yield*
_iterateRowsRaw`, release in `finally`. `iterateRows()` wraps it in
`wrapAsyncIterator` for implicit-transaction finalize — the same shape as `all()`,
but yielding raw `Row` (no `rowToObject`).

Deadlock guard held intact: `_iterateRowsRaw`, `_iterateRowsRawInternal`, and
`iterateRowsWithTrace` are all still mutex-free — the re-entrant callers
(foreign-key-actions, constraint-builder, schema/manager, database-assertions,
`database.eval`) and `explain.ts`'s in-execution `iterateRowsWithTrace` must not
re-acquire the chained-promise mutex.

### (b) Schema-change listener leak on zero-dependency recompile
The "remove existing listener" call in `compile()` was inside the
`if (dependencies.hasAnyDependencies())` branch — a recompile into a
zero-dependency plan never unsubscribed the old listener. Moved the unsubscribe
out unconditionally (always drop the previous listener before (re)compiling),
then add a new listener only when there are dependencies.

### (c) `reset()` now refuses when busy
`reset()` only `warnLog`'d and cleared `busy`, letting a second iteration slip
past the busy guard in `_iterateRowsRawInternal`. Now throws
`MisuseError("Statement busy, cannot reset an in-flight iteration; ...")` when
busy, matching `bind`/`bindAll`/`clearBindings`/`nextStatement`. `finalize()`
remains the force-clear escape hatch. Removed the now-unused `warnLog` binding.

### (d) `db.get()` binds parameters once
`db.get()` called `prepare(sql, params)` (constructor binds + infers types) then
`stmt.get(params)` (which re-binds via `bindAll` + re-validates every value).
Changed to `stmt.get(undefined, options)` — the constructor's bind stands.
Confirmed isolated: `db.eval` does `prepare(sql)` with no params; `db.exec` takes
a different path.

## Use cases to validate

Concentrate scrutiny here — these are the behaviors that must hold:

- **(a) Serialization.** Two statements on one db, both driven with `iterateRows()`
  interleaved: the second's first pull must not begin until the first releases the
  mutex. New test `serializes concurrent iterateRows() through the exec mutex`
  asserts this. Contrast: `all()` already serialized (existing test `should allow
  concurrent statements after early exit releases mutex`).
- **(a) No regression** to early-exit / error / normal-completion transaction
  finalize for `iterateRows()` (existing `Statement.iterateRows()` tests) or to
  the re-entrant/`explain` callers (full plan/optimizer suite passes).
- **(b) Listener count** on `schemaManager.getChangeNotifier()` returns to baseline
  after a table-dependency statement recompiles into a zero-dependency plan. New
  test `does not leak schema-change listeners on a zero-dependency recompile` uses
  the existing `getListenerCount()` accessor and a `select ...; select 1` batch +
  `nextStatement()`.
- **(c) reset refusal** mid-iteration throws `MisuseError`; reset after the
  iteration drains/early-exits still succeeds. New test `refuses reset() while an
  iteration is in flight`. Existing callers only reset after drain (see
  `statement-iterator-cleanup.spec.ts` multiple-early-exits test, still green).
- **(d) Single bind.** `db.get(sql, params)` must not call `bindAll` again (the
  constructor already bound the values directly). New test `binds parameters
  exactly once in db.get()` monkey-patches `Statement.prototype.bindAll` and
  asserts zero calls during `db.get`.

## Tripwire (parked, not a ticket)

On normal completion `wrapAsyncIterator` runs the transaction-finalize cleanup
*after* `_iterateRowsGenerator`'s `finally` (mutex release), so the
implicit-transaction commit for `iterateRows()` lands just outside the mutex —
identical to the pre-existing `all()`/`_allGenerator` behavior, so this is
consistency, not a new hazard. Documented in a `NOTE:`-tagged docstring at
`_iterateRowsGenerator` (statement.ts). Do not "improve" the ordering here without
also revisiting `all()`.

## Known gaps / reviewer starting points

- **(a) test is timing-based.** It uses `setTimeout(20ms)` to let the event loop
  drain and asserts the second pull hasn't resolved. Robust in practice (the mutex
  await is a microtask chain, settled well within one macrotask), but it is not a
  deterministic scheduler hook — worth a skeptical look if it ever flakes under CI
  load. No deterministic instrumentation hook was added.
- **(a) transaction-boundary corruption** is verified indirectly. The test proves
  the *mechanism* (mutex serialization); it does not construct an interleaving that
  corrupts `_isImplicitTransaction()` directly. If you want belt-and-suspenders,
  add an assertion that two interleaved `iterateRows()` runs leave
  `_isImplicitTransaction()` coherent.
- **(b) test** drives `compile()` directly and advances via `nextStatement()`; it
  does not exercise the schema-change-triggered `needsCompile` recompile path into
  a zero-dependency plan (harder to set up). The unconditional unsubscribe covers
  both, but only the `nextStatement` path has an explicit test.
- **(c)** the "second iteration not startable until the first completes" clause of
  the reproduction is covered implicitly (busy stays set; a same-statement second
  `iterateRows()` also blocks on the held mutex before reaching the busy guard).
  There is no direct test that a raw `_iterateRowsRaw` second call throws while
  busy — that path is internal.
- **(d)** the assertion is "bindAll called 0 times" (the constructor binds via
  direct `boundArgs` assignment, not through `bindAll`), which proves the redundant
  *second* bind is gone but does not independently assert the constructor's first
  bind happened. Type inference from the values is still exercised by the query
  returning the right row.
