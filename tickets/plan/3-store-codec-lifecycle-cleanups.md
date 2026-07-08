description: A grab-bag of smaller persistent-store issues — one real correctness bug where a failed save leaks stale statistics into the next transaction, plus several performance and code-hygiene cleanups.
prereq: store-tablekey-split-mis-routes-dotted-identifiers
files:
  - packages/quereus-store/src/common/serialization.ts     # JSON row codec, per-call TextEncoder (24-49); bytesToHex duplicates
  - packages/quereus-store/src/common/transaction.ts        # commit() (215) — failed commit fires neither callback
  - packages/quereus-store/src/common/store-module.ts        # renameTable deletes stats (~1061); CREATE INDEX/ALTER PK buffer whole table (~1753); alterTable 565 lines (~1973 area of a 2,689-line file)
  - packages/quereus-store/src/common/bytes.ts               # candidate home for a single bytesToHex
difficulty: medium
----

# Store: codec and lifecycle cleanups (one correctness bug + hygiene)

A cluster of smaller store issues, grouped because none alone justifies a
ticket. One is a genuine correctness bug and is called out first; the rest are
performance / robustness / maintainability cleanups. Address as one coherent
pass, but treat the correctness item as the priority and give it its own test.

## 1. CORRECTNESS — failed commit fires neither callback, leaking stats delta

`TransactionCoordinator.commit` (`transaction.ts:215`) accumulates a per-table
statistics delta during a transaction and flushes it via an `onCommit` (apply
the delta) / `onRollback` (discard the delta) callback pair. If the commit
itself **throws** partway through, control leaves without firing *either*
callback. The pending stats delta is neither applied nor discarded — it survives
into the **next** transaction on the same coordinator and is then double-counted
or misattributed. Row-count / statistics estimates drift, which feeds the query
planner's cost model with wrong numbers.

Note: this is distinct from the already-completed `store-coordinator-stats-callback-leak`
(which deregistered callbacks on hard table eviction — a memory leak). This is a
*delta-not-cleared-on-commit-failure* bug.

Expected: a commit that fails must leave the coordinator's pending stats state
clean — either roll the delta back (fire `onRollback` semantics) or clear it —
so no delta carries into a subsequent transaction. Add a test that forces a
commit failure and asserts the next transaction's stats start clean.

## 2. `renameTable` deletes statistics

`renameTable` (`store-module.ts` ~1061) drops the table's persisted statistics
on rename, so a freshly-renamed table has no stats until re-gathered — the
planner temporarily costs it blind. Statistics should travel with the table
across a rename (re-key them under the new name), not be discarded.

## 3. Performance: per-call `TextEncoder` in the JSON row codec

The JSON row codec (`serialization.ts:24-49`) constructs `new TextEncoder()` on
every call. `TextEncoder` is stateless and reusable — hoist a single shared
instance (module-level) and reuse it for every encode.

## 4. DRY: triplicate slow `bytesToHex`

Three separate slow `bytesToHex` implementations exist. Consolidate to one fast
implementation (lookup-table based) in `bytes.ts` and route all callers through
it.

## 5. Performance: CREATE INDEX / ALTER PK buffer the entire table

Both operations (`store-module.ts` ~1753) read the whole table into memory
before writing. For large tables this is an unbounded memory spike. Stream the
rows (iterate + write in batches) instead of materializing the full table. Size
permitting; if streaming is a larger redesign than fits this pass, split it into
its own prereq-chained ticket and note the deferral.

## 6. Maintainability: 565-line `alterTable` in a 2,689-line file

`alterTable` in `store-module.ts` is a 565-line method inside a 2,689-line file.
Decompose into small single-purpose helpers (per AGENTS.md: decomposed
sub-functions over grouped sections) and consider extracting the ALTER machinery
to its own module. Behavior-preserving refactor — lean on the existing store
test suite as the regression net.

## Notes

- The related `tableKey.split('.')` mis-routing is a real correctness bug too but
  is ticketed separately (`store-tablekey-split-mis-routes-dotted-identifiers`,
  the prereq here) because it deserves its own repro; do not duplicate it in this
  pass.
- Split any sub-item that grows beyond a single coherent change into its own
  prereq-chained ticket rather than oversizing this one. The stats-on-commit-
  failure correctness fix should not be dropped even if the hygiene items slip.
