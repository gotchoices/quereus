description: Let the planner learn table sizes seen inside a transaction only once that transaction commits, and forget them if it rolls back — so it never remembers a row count that included changes which were later undone.
prereq: cardinality-feedback-scan-observations
architecture: docs/progressive-optimizer.md#35-publication-and-transactions
files: packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/core/database.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, docs/progressive-optimizer.md
difficulty: medium
----

# Hold in-transaction observations until commit

Third of the `cardinality-feedback-*` chain (design: `docs/progressive-optimizer.md` §3.5). After `cardinality-feedback-scan-observations`, an execution that ends while a transaction is open throws its observations away. That is safe but loses every observation made by a writing statement (its implicit transaction is still open when the run site publishes) and by reads inside an explicit `begin … commit` — the normal shape for many embedded hosts. This ticket keeps them, scoped to the transaction's outcome.

## Design

### Manager side (`core/database-cardinality-feedback.ts`)

- `publish(sink, { readCommitted })`: unchanged for `readCommitted` and no-transaction executions (apply now). Otherwise merge the sink's entries into a `pending` map keyed like the overlay (last count per table wins) instead of discarding.
- `onCommitted(changedCounts: () => Map<string, number>)`: if `pending` is empty return without calling the thunk. Otherwise apply (`record`) every pending observation **whose key is not in `changedCounts()`**, then clear `pending`. A table the transaction itself changed is skipped: its count was taken mid-transaction, possibly before later writes in the same transaction, and the change log cannot say which came first. (This also skips tables an `update` merely rewrote; reads outside such transactions re-observe them.)
- `onRolledBack()`: clear `pending`.

The change log (`TransactionManager.getChangedRowCounts()`) is keyed by the same lowercased `<schema>.<table>` the overlay uses — reuse the same key helper, do not re-derive.

### Transaction side (`core/database-transaction.ts`, `core/database.ts`)

- **Commit:** `Database.recordCommittedChangeCounts(counts)` is already called in the post-commit window while the change log is alive. Make it memoize the thunk once and fan out: auto-analyze (still gated on `auto_analyze`) and `this._cardinalityFeedback.onCommitted(memo)` (not gated on `auto_analyze`). Update its doc comment, and the generic wording of the `errorLog` around the call site in `commitTransaction` (today it says "Auto-analyze commit bookkeeping threw").
- **Rollback:** add `transactionRolledBack(): void` to `TransactionManagerContext`; `Database` implements it as `this._cardinalityFeedback.onRolledBack()`. Call it from every path that undoes work:
  - `rollbackTransaction` — in its `finally`, so a throwing connection rollback still clears;
  - `commitTransaction`'s `catch` — a failed commit (deferred constraint or assertion violation, connection commit error) rolls the connections back directly without going through `rollbackTransaction`;
  - `rollbackToSavepoint` — conservatively discards **all** pending observations, including ones made before the savepoint; precision is not worth tracking per savepoint.
- An implicit transaction upgraded to explicit by `BEGIN` keeps its pending observations (same transaction).

## Edge cases & interactions

- **Writing autocommit statement** (`insert into t2 select * from big`): observations of `big` are held through the statement's implicit transaction and applied at its commit; `t2` is not observed (it is a write target, not a scan source). Verify: test.
- **Table changed in the same transaction** (`begin; delete from big where id <= 10; select * from big; commit;`): `big`'s observation is dropped at commit. Verify: test.
- **Explicit read-only transaction** commits its observations. Verify: test.
- **ROLLBACK** discards. Verify: test.
- **`rollback to savepoint`** discards everything pending. Verify: inspection (one call site).
- **Failed commit** discards. Verify: inspection — the hook is in the `catch` that already rolls connections back.
- **`OR ROLLBACK` conflict** goes through `_rollbackTransaction` → `rollbackTransaction` → hook; **`OR FAIL`** commits prior rows → `onCommitted`. Verify: inspection of `_finalizeImplicitTransaction`.
- **Concurrent committed read** during a writer's open transaction still applies immediately; if the writer later commits an observation of the same table, the later write wins — both describe committed state. Verify: inspection.
- **Auto-analyze off** must not disable feedback's commit handling, and with nothing pending no counts map is built. Verify: inspection of the memoized fan-out.
- **Pending is bounded** by the number of distinct tables observed in one transaction. Verify: inspection.
- **`close()` with a transaction open**: `dispose()` clears `pending` with everything else. Verify: inspection.
- **Bookkeeping errors** never fail a commit or a rollback — the commit-side call is already inside a try/catch; wrap the rollback hook the same way. Verify: inspection.

## Tests (only these)

In `packages/quereus/test/runtime/cardinality-observations.spec.ts` (`pragma auto_analyze = false`, `pragma cardinality_feedback = true`, a 20,000-row never-analyzed `big`), replacing the previous ticket's "discarded inside a transaction" case:

- `begin; select * from big; commit;` → `big` recorded at 20,000 after the commit, absent before it.
- `begin; select * from big; rollback;` → not recorded.
- `begin; delete from big where id <= 10; select * from big; commit;` → not recorded.
- `insert into t2 select * from big` (autocommit) → `big` recorded after the statement completes.

## TODO

- Manager: `pending`, `onCommitted`, `onRolledBack`; `publish` holds instead of discarding.
- `TransactionManagerContext.transactionRolledBack()` + the three call sites.
- `Database.recordCommittedChangeCounts`: memoize the thunk, fan out to auto-analyze (gated) and feedback (ungated); update comments and the commit-side log message.
- `Database.transactionRolledBack()` implementation.
- Tests above (rewrite the interim discard test).
- `docs/progressive-optimizer.md` §3.5: present tense; drop the interim-discard note.
- `yarn lint`, `yarn test`.
