description: The engine now gives each storage-module connection exactly one commit or rollback per begin, the rule is written down, and every SQL logic test fails if the engine breaks it. Review the engine changes, the new check, and the docs.
architecture: docs/invariants.md
files:
  - packages/quereus/src/core/database-transaction.ts # openConnections, closingTransaction, joinConnection, commitOpenConnections, rollbackOpenConnections, commitConnectionEarly
  - packages/quereus/src/core/database.ts # registerConnection, _commitConnectionEarly; deferred-evaluation wrappers removed
  - packages/quereus/src/core/database-internal.ts # registerConnection doc comment
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # the two early-commit sites and their comments
  - packages/quereus/src/vtab/connection.ts # contract on the interface comment
  - packages/quereus/src/vtab/test-support/connection-lifecycle-check.ts # new
  - packages/quereus/src/index.ts # exports the check
  - packages/quereus/test/logic.spec.ts # installs the check, asserts after every block
  - packages/quereus/test/core/connection-lifecycle-check.spec.ts # new
  - packages/quereus/test/core/overlapping-statement-finalize.spec.ts # the arm 4 assertion
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic # section 13
  - packages/quereus/test/README.md
  - scripts/check-docs.mjs # TXN area
  - docs/invariants.md # TXN-001
  - docs/doc-conventions.md
  - docs/module-authoring-transactions.md # Connection lifecycle section
  - docs/module-authoring.md
  - docs/materialized-views.md
  - docs/mv-ingestion.md
difficulty: hard
----

## What changed

The contract is TXN-001 in `docs/invariants.md`: on a connection passed to `Database.registerConnection`, every begin, commit, rollback and savepoint call holds the execution mutex, calls never overlap, and the connection gets begin, then in-range savepoint calls, then exactly one commit or rollback before the next begin. A commit that rejects is followed by rollback. With no statement running and the database in autocommit, every registered connection is idle.

`TransactionManager` now tracks which connections it has begun and not finished (`openConnections`). Every engine commit and rollback goes through that set.

- **Begun but never committed (arm 2).** One flag, `closingTransaction`, is set for the whole of `commitTransaction` and `rollbackTransaction`. A connection registered in that window gets no calls and joins at the next begin. This replaces the old deferred-constraint flag, which covered only part of the commit. `TransactionManager.runDeferredRowConstraints`, `isEvaluatingDeferredConstraints`, `Database.runDeferredRowConstraints`, `Database._isEvaluatingDeferredConstraints` and the context interface member are removed.
- **Rollback to the wrong connections (arms 3 and 4).** A failed commit now rolls back only connections still open. One that already committed gets no rollback, and one that never began gets none. Both rollback paths share `rollbackOpenConnections`, which isolates each call so a synchronous throw cannot skip the others.
- **Committed twice (arm 1).** The two places that commit one connection ahead of the transaction (`attachMaintainedDerivation` and `rebuildBacking` in `materialized-view-helpers.ts`) call `Database._commitConnectionEarly`. It commits, then begins the connection again and replays the open savepoint depths. If the commit rejects it rolls back the whole transaction and rethrows.
- **Begin failures.** `beginTransaction` marks the transaction active before its loop, so a connection registered during another connection's `begin()` joins. A rejected begin rolls back the connections already begun and leaves autocommit. `registerConnection` no longer swallows a rejected begin: it removes the connection from the registry and rethrows.

The check is `installConnectionLifecycleCheck(db)`, exported from the package beside `installCommitStall`. `logic.spec.ts` installs it on every database and calls `assertClean()` after every block, including the end-of-file one, prefixing failures with `file:line`.

## Results

Run on this tree, after `yarn build`:

| Command | Result |
|---|---|
| `yarn workspace @quereus/quereus run lint` | clean |
| `yarn build` | clean |
| `yarn test` | all workspaces pass. Engine: 11,079 passing, 26 pending |
| `yarn test:store` | 11,072 passing, 33 pending |
| `yarn docs:check` | 1 failure, not from this ticket (see below) |

The store, isolation and sync package suites import the built `dist`, and planning had not run them against this design. They pass.

The logic corpus alone took 24 s on memory with the check installed. I did not time it without the check, so there is no overhead figure from this pass.

To confirm the corpus really pins arm 1, I put the bare `conn.commit()` back at both sites and ran file `51.7` on memory. It failed with `Connection lifecycle violation: commit on connection 'memory-main.plain1-15' (table 'main.plain1') is not a legal call; state: idle; last calls: begin, commit`. I then restored the fix. I did not repeat that experiment in store mode or for the other arms.

## Tests added or changed

`packages/quereus/test/core/connection-lifecycle-check.spec.ts`:

- `refuses <case>`, one per row of a table: commit while idle, rollback while idle, begin while open, each savepoint call while idle, a create that skips a depth, a create that repeats a depth, a release and a rollback-to at a depth not held, a release at a depth already released. Each expects a throw, one recorded violation naming the method, connection and table, and that the call never reached the connection.
- `refuses begin / commit / createSavepoint after a rejected commit`: only rollback is legal there.
- `refuses a call that overlaps an unsettled one`.
- `refuses a commit made without the execution mutex`.
- `records nothing for a legal sequence, and returns what the connection returns`: includes begin, commit, begin, commit; a rejected commit followed by rollback; a rejected begin leaving the connection idle; and that a synchronous method stays synchronous through the wrapper.
- `assertClean throws for a connection left open with no statement running`.
- `a rejected begin rolls back the connections already begun and leaves autocommit`: the `beginTransaction` unwind.
- `a connection whose begin rejects on registration is not left registered`.
- `a rejected early commit rolls the whole transaction back`.

`overlapping-statement-finalize.spec.ts`, `a failing commit rejects the writer and not the overlapping select`: the connection that already committed now expects 0 rollbacks, and the failing connection expects 1. This pins arm 4.

`51.7-maintained-table-attach-detach.sqllogic` section 13: the two blocks from the plan (refresh of a CHECK-bearing maintained table; a retyping attach inside a savepoint). I also added four `drop` statements after them, matching how every other section in the file cleans up. Nothing later in the file needs them.

## Use cases worth exercising in review

- A module whose `commit()` throws when called on an idle connection, run through `refresh materialized view` on a maintained table with a CHECK, and through `alter table … set maintained` with a retype, both inside and outside an explicit transaction with open savepoints.
- A commit where the second of three connections rejects: the first stays committed with no rollback, the second and third each get one rollback.
- A connection registered from inside a global assertion, a deferred constraint, a `commit()` of another connection, or a `Database.watch` handler: it should get no begin until the next transaction, and reads through it should still return committed rows.
- A connection whose `begin()` rejects, registered mid-transaction and at the start of a transaction.
- The check installed together with `installCommitStall`, in either order.
- A third-party-style module test: install the check, run statements, call `assertClean()`.

## Known gaps and judgment calls

- **Re-begin failure after an early commit.** `commitConnectionEarly` treats a rejected re-begin the same as a rejected commit: whole-transaction rollback and rethrow. The ticket only specified the rejected-commit case. In `attachMaintainedDerivation` this means `reconcileCommitted` stays false although the rows are committed, so the catch restores the prior catalog record over reconciled rows. No in-tree module's `begin` rejects, so this is dormant. There is a `NOTE:` on `commitConnectionEarly`. A reviewer may decide it deserves a ticket instead.
- **Begin-failure unwind calls `rollbackTransaction()`.** That does what the ticket listed (roll back the begun connections, discard the event batch, restore autocommit) and also clears the change log and runs the rolled-back bookkeeping hook. Both are empty at that point, so I reused the method instead of writing a second unwind.
- **When the commit loop reads its participants.** The old code snapshotted the registry before assertion and deferred evaluation. The new loop reads the open, still-registered connections after that evaluation. A connection removed from the registry during evaluation would have been committed before and now is not. I know of no path that removes one there.
- **`openConnections` is updated before `begin()` is awaited**, and removed again if it rejects. This stops a second join of the same object from beginning it twice. The ticket did not say which order to use.
- **Check semantics the ticket's table left open.** A savepoint call that rejects leaves the recorded depth unchanged. A refused call throws synchronously even when the real method is async. Refused and rejected calls appear in the eight-call history, marked `(refused)` and `(rejected)`. A connection registered before the check was installed is not watched.
- **Not tested, by inspection only.** A connection registered during another connection's `begin()` in `beginTransaction`; registration during a rollback or a post-commit watcher; the same object registered twice; a re-begin failure in the early commit; the savepoint-replay rejection path (it keeps log-and-continue, with the `NOTE:` the ticket asked for).
- **The three engine tests do not install the check.** They count calls on a fake connection. Installing the check would have meant taking the mutex by hand around `registerConnection`.
- **The doc section restates the contract.** `docs/doc-conventions.md` says a topic doc links an invariant and does not restate it. The ticket asked for the contract in `docs/module-authoring-transactions.md`, so the four bullets are there under the back-link. If the convention should win, cut the bullets and keep the back-link, the depth explanation and the two consequences.
- **`docs/materialized-views.md` is now 11,756 words**, 244 from the 12,000-word cap. I added two clauses (about 47 words) covering the re-begin and the whole-transaction rollback on a failed early commit. The next addition to that file should go in a satellite.
- **Behaviour changes visible to users.** A rejected `begin()` now fails the statement that registered the connection, where it used to be logged and ignored. A failed early commit now rolls back an explicit transaction, where it used to fail only the statement. Both are documented in the module doc, and the second also in `docs/materialized-views.md`.
- **Line endings.** The working copy of `docs/module-authoring-transactions.md` was CRLF while every other changed file was LF. I converted it to LF, which is what `.gitattributes` normalizes to on commit.

## Pre-existing failure

`yarn docs:check` fails on `docs/sync.md`: 12,268 words against the 12,000-word cap, with no ratchet entry. The file is untouched by this ticket and measures the same at HEAD `5a65612e8`. It is the only failure the check reports, so this ticket's doc edits pass. Recorded in `tickets/.pre-existing-error.md`. I did not add a ratchet entry or split the doc.

## Tripwires parked in code

- `TransactionManager.replaySavepoints`: a rejected savepoint replay leaves the connection short of depths.
- `TransactionManager.commitConnectionEarly`: a rejected re-begin is reported like a rejected commit.
