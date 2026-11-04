description: On a storage backend that cannot change a primary key in place, a primary-key change whose final commit failed used to leave the table empty. The rows are now committed before the original table is dropped, and the copy no longer re-checks rows that are not changing.
architecture: docs/module-authoring-schema-changes.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts   # rebuildViaShadowTable, shadowHoldsRowsError, indexesMissingError, the explicit-transaction refusal message
  - packages/quereus/src/parser/ast.ts   # InsertStmt.skipRowChecks
  - packages/quereus/src/planner/building/insert.ts   # the three skips in buildInsertStmt
  - packages/quereus/src/core/database.ts   # _parseSql is now @internal rather than private
  - packages/quereus/src/core/database-auto-analyze.ts   # NOTE on entries a rename leaves behind
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts   # rebuildNotOnlyEffectError message
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # comments only
  - packages/quereus/test/alter-table-conformance.spec.ts
  - packages/quereus/test/apply-schema-restore.spec.ts
  - packages/quereus/test/alter-primary-key-in-transaction.spec.ts   # comment only
  - docs/schema-undo-plan.md
  - docs/module-authoring-schema-changes.md
  - docs/sql-alter.md
  - docs/schema-declarative.md
  - docs/module-events.md
repro: verified
----

# A rebuilt primary key no longer loses its rows when a commit fails

A backend that cannot re-key in place changes a primary key by building a hidden copy of the table (the shadow table), copying the rows, dropping the original and renaming the copy over it. The drop and rename survive a rollback and an uncommitted copy does not, so any failure after the drop emptied the table. Only third-party backends reach this path; memory and the store both re-key in place.

## What changed

- **The copy commits before the drop.** `rebuildViaShadowTable` calls `_commitTransaction` then `_ensureTransaction` straight after the copy. `docs/schema-undo-plan.md` § A primary-key rebuild explains why this does not reopen the earlier rejected decision.
- **The copy skips row-level judgment.** A new engine-only `InsertStmt.skipRowChecks` makes `buildInsertStmt` skip `buildConstraintChecks`, `buildChildSideFKChecks` and `buildNotNullDefaults`. This also closed the former backlog ticket `bug-rebuild-copy-refused-when-table-reads-context`, which is deleted.
- **The shadow is kept once it holds the only copy.** A failed rename raises `shadowHoldsRowsError`, which names the shadow, gives the statement that restores the table, and lists any indexes to re-create.
- **A failed index re-creation is reported in full (added in review).** `indexesMissingError` says the key changed and names every index left missing.
- **Refusals keep their conditions, with new reasons.** A multi-step apply and an explicit transaction are still refused, because the rebuild now commits part-way.

## What a failure leaves

| Failure point | Table | Rows | Reported | Checked by |
|---|---|---|---|---|
| copy refused (key collision) | original | intact | the error | test |
| commit of the copy | original | intact, no shadow left | the error | test |
| drop refused | original | intact | the error | code reading |
| rename | missing | in the shadow, named in the error | wrapped error with the recovery statement | test |
| index re-creation | new key, that index and the later ones missing | intact | wrapped error naming each missing index | test |
| final commit | new key | intact | the error, though the key changed | test |

## Validation

`yarn workspace @quereus/quereus run lint` exits 0. `yarn test` reports no failures in any workspace, with 10945 passing and 25 pending in `@quereus/quereus`. `yarn test:store` was not run, because the store re-keys in place and never enters this path.

## Review findings

Read the diff of `ticket(implement): bug-rebuild-loses-rows-when-implicit-commit-fails` before the handoff, then read the surrounding transaction, event and apply code. Two throwaway probes were run and removed.

**Fixed in this pass**

- **A failed index re-creation under-reported (defect).** Probed with two indexes on a re-key: the error named only the first, did not say the key had changed, and the second index was silently never attempted, so a UNIQUE index in that position stops enforcing with no warning. The rename path already named the indexes for this reason. Added `indexesMissingError` and a test, which failed before the fix.
- **The recovered `alter` event's wrong old key was only in the handoff.** The `NOTE:` and the docs said re-issuing "delivers the event" without saying its `oldKeyColumns` names the new key. Both now say so, and the `NOTE:` names the effect on a syncing peer. From reading `rekeyTableBookkeeping`, a peer given the same old and new key finds nothing filed under that key and re-files nothing; not run.
- **A lost `alter` event on index failure was undocumented.** `sql-alter.md` and the `NOTE:` now cover it. The probe showed no event delivered.
- **`docs/sql-alter.md` overclaimed.** "The copy judges only the key" was not accurate: `checkNotNullConstraints` still runs for each row. It now says the key and NOT NULL. A stored NULL there would refuse the copy with the table intact, so this errs in the safe direction.
- **A stale comment.** `alter-primary-key-in-transaction.spec.ts` still gave the old reason for the explicit-transaction refusal.

**Tripwires recorded**

- Auto-analyze now keeps one `<table>__rekey_<ms>` staleness entry per rebuild, because the copy commits while the shadow exists. Probed: the entry is tracked after a successful re-key, and an armed refresh evicts it without running `analyze` (zero refreshes). Parked as a `NOTE:` in `AutoAnalyzeManager.subscribeToSchemaChanges`, beside the equivalent note for detached schemas.
- The missing `alter` event followed by a wrong old key on re-issue, in the existing accepted-tradeoff `NOTE:` at the commit. It needs a module failing an empty commit, or a failed index re-creation, on a backend behind a syncing peer. No in-repo module fails either way, and the docs tell module authors not to fail an empty commit.

**Checked, no defect**

- Mid-statement commit: `_execBatchAutocommit`, `iterateRows` and `_finalizeImplicitTransaction` all re-read the transaction source, so the new implicit transaction is committed or rolled back normally. After a failed commit the manager is back in autocommit, so the catch's shadow drop opens its own transaction.
- The handoff's question about the "commits the whole implicit transaction" `NOTE:`: confirmed, wider than the handoff's grep of `src`. Across all packages, only core calls `_execWithinTransaction`/`_execAstWithinTransaction`, and the only internal issuers of the statement are the differ's migration and undo steps, under the apply's refusal flag. Every other route is a top-level statement in its own implicit transaction, or explicit and refused.
- Event scopes across the commit: the schema event watermark is a lifetime-monotonic counter (`beginSchemaEventScope`), so `flushBatch` does not invalidate it. The `alter` event is raised after the scope closes, into the new batch.
- Commit-time checks: `runGlobalAssertions` dispatches on changed tables and only the shadow changed. An assertion with no table dependency runs on every commit anyway, and failing it leaves the original intact.
- Post-commit watchers and cardinality feedback see only the shadow's name at the copy's commit, as they did at the old final commit. From reading.
- `skipRowChecks` has one setter and no parser path. Type conversion and uniqueness still apply.
- Tests: each new test reproduces the bug or pins one arm of the failure table, and none verifies a mock of an owned module; none cut. The one-step apply test overlaps the direct foreign key test, but it is a separate entry path that used to empty the table, so it stays.
- Docs read: `usage.md` (silence on all three channels still true), `design-isolation-challenges.md`, the isolation README, and the two backlog tickets on this path, neither of which relied on the old behaviour.

**Not run, carried from the handoff**

These stay code-reading only. Each is a module breaking its contract or a narrow race, none has a reachable in-repo path, and none met the filing bar:

- A `destroy` that deletes its storage and then throws. The catch treats it as a refused drop and drops the shadow, losing both copies. The `dropTable` comment defines a `destroy` rejection as having mutated nothing.
- A rename failing after the catalog swap, in the propagation pass, which would make the error's recovery statement wrong. `runRenameTable` describes that pass as unfailable.
- A `begin` failing in `_ensureTransaction` straight after the copy's commit. It should reach the catch with the original intact.
- A commit failing on only some connections. The shadow is dropped and the original is untouched either way.
- The `docs/module-events.md` claim about commit-time events after the copy. No module in the repository emits that way.

**Major findings:** none, so no tickets filed.

**Size:** `alter-table.ts` is 2791 lines (`wc -l`), up from 2733 in the existing backlog ticket `debt-oversized-source-files`, which already claims this file. No new ticket.
