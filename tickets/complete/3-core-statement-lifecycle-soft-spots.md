description: Reviewed four small prepared-statement lifecycle fixes in the SQL engine — serialized one iteration path, plugged a listener leak, refused an unsafe reset, and dropped a duplicate parameter bind. All four hold up; no new defects found.
files:
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/test/statement-iterator-cleanup.spec.ts
difficulty: medium
----

# Complete: core statement lifecycle soft spots

Four independent lifecycle fixes in `core/statement.ts` (plus one line in
`core/database.ts`), reviewed adversarially. All four are correct, consistent
with existing patterns, and covered by reproductions in
`test/statement-iterator-cleanup.spec.ts` (`describe('Lifecycle soft spots')`).

## What shipped

- **(a) `iterateRows()` serializes through the exec mutex.** New
  `_iterateRowsGenerator` acquires `db._acquireExecMutex()` and holds it for the
  whole iteration (mirrors `_allGenerator`), so two public iterations over one db
  can't interleave the implicit-transaction lifecycle.
- **(b) Schema-change listener leak fixed.** The "drop previous listener" call in
  `compile()` moved out of the `hasAnyDependencies()` branch, so a zero-dependency
  recompile no longer leaks the old listener.
- **(c) `reset()` refuses when busy.** Now throws `MisuseError` mid-iteration
  instead of silently clearing `busy` (which let a second iteration slip past the
  busy guard). `finalize()` remains the force-clear for `busy`.
- **(d) `db.get()` binds once.** Changed `stmt.get(params, options)` →
  `stmt.get(undefined, options)`; the `prepare(sql, params)` constructor already
  bound + inferred types, so the redundant `bindAll` re-bind is gone.

## Review findings

**Verification run:** `yarn workspace @quereus/quereus run lint` → EXIT 0
(eslint + `tsc` over test files). `yarn workspace @quereus/quereus run test` →
6521 passing / 9 pending, EXIT 0. Both re-run at this SHA, both green.

### Correctness — checked, nothing found

- **(a) Re-entrancy / deadlock.** The whole risk of (a) is that a caller already
  holding the mutex re-enters through the now-serialized `iterateRows()` and
  self-deadlocks on the chained-promise (non-reentrant) mutex. Enumerated every
  production caller of the iteration paths: all re-entrant callers
  (`foreign-key-actions`, `constraint-builder`, `schema/manager`,
  `database-assertions`, `alter-table`, `materialized-view-helpers`,
  `database._evalGenerator`) use `_iterateRowsRaw` (mutex-free); `explain.ts` uses
  `iterateRowsWithTrace` (mutex-free). **No production code calls public
  `iterateRows()` at all** (only tests do). Deadlock guard intact.
- **(a) `.return()` releases the mutex.** Confirmed via `wrapAsyncIterator`: early
  exit runs the transaction-finalize cleanup, then delegates to
  `iterator.return()`, which triggers `_iterateRowsGenerator`'s `finally` →
  `releaseMutex()`. The new test drives exactly this (`it1.return!()` unblocks
  `it2`).
- **(b) Recompile / finalize interaction.** Unsubscribe sits after `optimize()`
  inside the compile try; a planning failure before it leaves the old (still-valid)
  listener in place with `needsCompile` still true → next compile re-runs cleanly.
  `finalize()` still unsubscribes independently. No double-unsubscribe, no leak.
- **(c) reset callers.** No production code calls `Statement.reset()`. Every test
  caller (`lifecycle.spec` reuse-after-error, `materialized-view-plan.spec`) resets
  only after the prior iteration has fully drained or errored (busy already
  cleared) — all still green. The lifecycle "reuse after error via reset()" test
  passes because `run()`'s failure path clears `busy` in the raw generator's
  `finally` before `reset()` is reached.
- **(d) Single bind, correct values.** `db.get('… where id = ?', [2])` returns the
  right row (`value === 200`), which only holds if the constructor's bind took —
  so the "first bind happened" gap noted in the handoff is in fact covered
  transitively by the assertion, not just the `bindAll`-count check.

### Minor observations — considered, no change

- **(d) `isSqlValue` validation timing.** The old double-bind meant `db.get`
  rejected a malformed (non-`SqlValue`) argument at bind time via `bindAll`'s
  `isSqlValue` check; the constructor bind path skips that check. This is not a new
  gap — `prepare(sql, params)` + `run()`/`all()` already bind through the
  constructor without it, so `db.get` now simply matches the dominant path. A
  malformed value still surfaces at execution (`getPhysicalType` /
  `validateParameterTypes`), not silently. Aligning the API's bind-time validation
  is a separate, pre-existing concern — not filed.
- **(c) `reset()` docstring** ("resets to initial state, ready to be re-executed")
  slightly overpromises — `reset()` only guards `busy`; it does not clear bindings
  or batch position. Pre-existing wording, roughly SQLite `sqlite3_reset`
  semantics (which also leaves bindings intact). Left as-is.

### Tripwires (parked, not tickets)

- **Implicit-txn commit lands just outside the mutex on normal completion.**
  Already documented by the implementer as a `NOTE:` docstring at
  `_iterateRowsGenerator` (statement.ts). Identical to `all()`/`_allGenerator`;
  consistency, not a hazard. Confirmed accurate.
- **A leaked iteration holds the mutex.** `iterateRows()` (like `all()`) now holds
  the exec mutex for the entire lazy iteration, and `finalize()` clears `busy` but
  does **not** release that mutex — only draining or the iterator protocol
  (`for await` break → `.return()` → generator `finally`) does. So a consumer that
  abandons an `iterateRows()` iterator without draining/returning wedges the db.
  This is inherent to the mutex-holding-generator pattern and **shared verbatim
  with the pre-existing `all()`** — it is a consistency property of (a), not a new
  hazard, and normal `for await` usage handles it automatically. Parked here in
  findings (no new code comment, to avoid implying `all()` differs); becomes work
  only if a caller pattern that leaks iterators is introduced.

### Test coverage — adequate, gaps are conditional

The implementer's known gaps (timing-based (a) assertion; (a) not asserting
`_isImplicitTransaction()` coherence directly; (b) only the `nextStatement`
recompile path, not the schema-change-triggered one; (c) no direct
raw-second-call test) are all belt-and-suspenders / harder-to-rig variants of
behaviors the shipped tests already cover through the observable mechanism. None
represents an untested code path in the diff. No additional tests added — the
present set covers happy path, the refusal/error path (c), the leak edge (b), and
the serialization contract (a).

## End
