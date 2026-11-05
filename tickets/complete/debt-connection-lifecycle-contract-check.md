description: The engine now gives each storage-module connection exactly one commit or rollback per begin, the rule is written down, and every SQL logic test fails if the engine breaks it.
architecture: docs/invariants.md
files:
  - packages/quereus/src/core/database-transaction.ts # openConnections, closingTransaction, joinConnection, commitOpenConnections, rollbackOpenConnections, commitConnectionEarly
  - packages/quereus/src/core/database.ts # registerConnection, _commitConnectionEarly
  - packages/quereus/src/core/database-internal.ts # registerConnection doc comment
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # the two early-commit sites
  - packages/quereus/src/vtab/connection.ts # contract on the interface comment
  - packages/quereus/src/vtab/test-support/connection-lifecycle-check.ts # the check
  - packages/quereus/src/index.ts # exports the check
  - packages/quereus/test/logic.spec.ts # installs the check, asserts after every block
  - packages/quereus/test/core/connection-lifecycle-check.spec.ts
  - packages/quereus/test/core/overlapping-statement-finalize.spec.ts
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic # section 13
  - packages/quereus/test/README.md
  - scripts/check-docs.mjs # TXN area
  - docs/invariants.md # TXN-001
  - docs/doc-conventions.md
  - docs/module-authoring-transactions.md # Connection lifecycle section
  - docs/module-authoring.md
  - docs/materialized-views.md
  - docs/mv-constraints.md
  - docs/mv-ingestion.md
----

## What changed

The contract is TXN-001 in `docs/invariants.md`. On a connection passed to `Database.registerConnection`, every begin, commit, rollback and savepoint call holds the execution mutex, calls never overlap, and the connection gets begin, then in-range savepoint calls, then exactly one commit or rollback before the next begin. A commit that rejects is followed by rollback. With no statement running and the database in autocommit, every registered connection is idle. A connection the module removes from the registry while open gets no further calls.

`TransactionManager` tracks which connections it has begun and not finished (`openConnections`), and every engine commit and rollback goes through that set.

- **Begun but never committed.** `closingTransaction` is set for the whole of `commitTransaction` and `rollbackTransaction`. A connection registered in that window gets no calls and joins at the next begin. This replaces the old deferred-constraint flag, which covered only part of the commit; `runDeferredRowConstraints` and `_isEvaluatingDeferredConstraints` are gone.
- **Rollback to the wrong connections.** A failed commit rolls back only connections still open. One that already committed gets no rollback, and one that never began gets none.
- **Committed twice.** The two places that commit one connection ahead of the transaction (`attachMaintainedDerivation` and `rebuildBacking`) call `Database._commitConnectionEarly`. It commits, begins the connection again and replays the open savepoint depths. If either step rejects it rolls back the whole transaction and rethrows.
- **Begin failures.** A rejected `begin()` at the start of a transaction rolls back the connections already begun and leaves autocommit. A rejected `begin()` on registration removes the connection from the registry and rejects the registration.

The check is `installConnectionLifecycleCheck(db)`, exported from the package beside `installCommitStall`. `logic.spec.ts` installs it on every database and calls `assertClean()` after every block.

Two behaviour changes are visible to users, both documented in `docs/module-authoring-transactions.md`: a rejected `begin()` now fails the statement that registered the connection (it used to be logged and ignored), and a failed early commit now rolls back an explicit transaction (it used to fail only the statement).

## Review findings

**Method.** Read the implement-stage diff (`ticket(implement): debt-connection-lifecycle-contract-check`) before the handoff. Read the callers of both early-commit sites, the savepoint broadcasts, the public begin/commit/rollback API, and the three ways a connection leaves the registry. Then ran twelve scratch scenarios against the engine with the check installed (deleted afterwards; none kept, because the corpus-wide check or an existing test already pins each).

**Checked and found correct.**

- Second of three commits rejects: the first stays committed with no rollback, the second and third each get one rollback.
- A rollback that throws synchronously does not stop the other connections being rolled back.
- A connection registered from inside another connection's commit, or its rollback, gets no calls and joins at the next begin.
- A connection registered from inside another connection's `begin()` at the start of a transaction joins once and is committed.
- The same object registered twice mid-transaction is begun once.
- An early commit inside two savepoints replays both depths, and a later `rollback to`, `release` and `commit` are in range.
- Real SQL: `refresh materialized view` of a CHECK-bearing maintained table inside a transaction with savepoints, a `rollback to`, and a final rollback; a retyping `alter table … set maintained` outside and inside a transaction.
- The check installed with `installCommitStall` in either order.
- Every path to the two early-commit sites starts a transaction first (`_ensureTransaction` in the create-table, alter-table and refresh emitters, and in `refreshAllMaterializedViews`), so the new "not open in the current transaction" internal error is not reachable from them.
- Savepoint broadcasts still go to every registered connection, not to the open set. That is sound because every registered connection is open inside a transaction that is not closing, and the corpus-wide check would report the first exception.
- The check's state machine matches the engine's depth arithmetic for release (drops the named depth) and rollback-to (keeps it).

**Found and fixed in this pass.**

- **Latent defect: a rejected re-begin after an early commit undid the catalog over committed rows.** In `attachMaintainedDerivation`, `reconcileCommitted` was set only after `_commitConnectionEarly` returned. If the commit succeeded and the re-begin then rejected, the catch restored the prior catalog record although the reconciled rows were already committed. No in-tree module's `begin` rejects, so this was dormant, but it was wrong the moment that path ran. `commitConnectionEarly` now takes an `onCommitted` callback that runs once the commit has resolved, and the attach site sets the flag from it. The implementer's `NOTE:` on this is replaced by the fix. One test added (`a rejected re-begin after an early commit still reports the commit as made`), and the existing rejected-commit test now also asserts the callback did not run.
- **The topic doc restated the invariant.** `docs/doc-conventions.md` says a topic doc links an invariant and does not restate it. The four contract bullets in `docs/module-authoring-transactions.md` are cut; the back-link, the definition of an in-range depth, the consequences and the early-commit paragraph stay.
- **An undocumented exception to the contract.** A connection removed from the registry while open (`unregisterConnection`, `removeConnection`, `removeConnectionsForTable`) gets neither commit nor rollback. That was already the behaviour before this ticket and is what the store's rename eviction relies on, but TXN-001 read as if every begun connection is closed. Added one sentence to TXN-001, a third consequence to the module doc, and a note in the check's doc comment that re-registering such an object later is reported as a begin while open.
- **Stale wording.** `docs/materialized-views.md`, `docs/mv-constraints.md` and four test comments still described the early commit as a bare `conn.commit()`. Reworded.
- **Check documentation.** `assertClean()` must be called before `db.close()` (it reads transaction state, which a closed database refuses), and the mutex test is "someone holds it", not "this caller holds it". Both now stated on the check.
- **`catch (e: any)`** in the new `logic.spec.ts` helper replaced with an `instanceof Error` test.

**Tests reviewed.** The eighteen check tests exercise a state machine with real branching against a fake connection that is the check's input, not a mock of a module the repository owns; kept. The three engine tests pin behaviour this ticket introduced; kept. None cut.

**Tripwires.**

- `TransactionManager.replaySavepoints`: a rejected savepoint replay leaves the connection short of depths (implementer's `NOTE:`, kept).
- `database-transaction.ts` is 1,010 lines (`wc -l`), up from 911 before this ticket, and about 400 of them are the change log, a separate concern. Parked as a `NOTE:` at the change-log section header.
- `docs/materialized-views.md` is 11,758 words, 242 from the 12,000-word cap (reported by `yarn docs:check`). The next addition should go in a satellite.

**Major findings needing a ticket.** None. The one latent defect was small enough to fix here.

**Considered and left alone.**

- The commit loop reads its participants after assertion and deferred-constraint evaluation, where the old code took a snapshot before. A connection removed from the registry during that evaluation is no longer committed. Nothing removes one there, and the registry-removal exception above now documents the outcome.
- A rejected `begin()` during the begin loop reuses `rollbackTransaction()`, which also clears an empty change log and runs the rolled-back hook. Harmless.
- The interface comment in `vtab/connection.ts` repeats the contract. It is what a module author sees in an editor, and the doc convention governs `docs/`, so it stays.

## Results

Run on this tree after the review edits:

| Command | Result |
|---|---|
| `yarn workspace @quereus/quereus run lint` | clean |
| `yarn build` | clean |
| `yarn test` | all workspaces pass. Engine: 11,080 passing, 26 pending |
| `yarn docs:check` | passes |
| Store mode, logic files matching `10.`, `40.`–`49.`, `50.`, `51.` | 100 passing, 1 pending, including `51.7` |

Not run in review: the full `yarn test:store`. The implementer ran it (11,072 passing, 33 pending) before the review edits, and the only engine change since is the optional `onCommitted` callback. The `yarn docs:check` failure the implementer recorded (`docs/sync.md` over the word cap) was fixed by the triage commit that followed and no longer occurs.
