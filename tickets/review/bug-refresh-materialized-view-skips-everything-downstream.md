---
description: Rebuilding a stored view's contents by hand now tells everything downstream — views built on it are updated, integrity rules check the rebuilt rows, and the rebuild is undone by a rollback like any other write. Review the change before it ships.
architecture: docs/materialized-views.md#refresh-materialized-view
files:
  - packages/quereus/src/runtime/emit/materialized-view.ts            # refreshMaintainedTable (savepoint, stale clear, undo action), rebuildAndPropagate
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts    # rebuildBacking (single replace-all path, RebuildBackingOptions, returns diff), reshapeBacking/reshapeBackingInPlace (ReshapedBacking, NOTE on the reshape limitation)
  - packages/quereus/src/core/database-materialized-views.ts          # propagateRefreshChanges, enforceRecordAndCascade (split out of postApplyBackingChanges), recordMaintenanceChanges docs + NOTE
  - packages/quereus/src/core/database-transaction.ts                 # TransactionManager.onUndo + undoLayers (new primitive)
  - packages/quereus/src/core/database.ts                             # _onTransactionUndo, _propagateRefreshChanges, refreshAllMaterializedViews docs
  - packages/quereus/src/vtab/backing-host.ts                         # doc-only: replaceContents is create-fill only now
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic
  - packages/quereus/test/logic/95-assertions.sqllogic
  - packages/quereus-store/test/mv-store-backing.spec.ts
  - docs/materialized-views.md, docs/incremental-maintenance.md, docs/mv-constraints.md, docs/mv-ingestion.md, docs/module-capabilities.md, docs/module-authoring-transactions.md, docs/mv-backing-host.md, docs/module-authoring.md, docs/migration.md
---

# What changed

`refresh materialized view <mv>` used to swap the stored rows and tell nobody. Now:

- **One swap path.** `rebuildBacking` always lands the recomputed rows with `applyMaintenance(conn, [{ kind: 'replace-all', rows }])` on the transaction's connection (`resolveAttachConnection`), after `assertRefreshRowsAreSet` (same "must be a set" error as before). The bulk CHECK/FK scan still runs only when `hasApplicableConstraints`. It returns the realized keyed diff. `replaceContents` is now used only by the create-fill (`materializeView`).
- **Early commit only on the reshape arm.** `rebuildBacking(db, mv, { commitEarly, validationColumns? })` — `commitEarly: true` only from `reshapeBackingInPlace` (its post-reconcile retype/recollate/tighten ops read committed contents). A `NOTE:` there records the accepted limitation: a reshaping refresh's rows are committed before COMMIT-time assertions run and survive a rollback.
- **Propagation.** New `MaterializedViewManager.propagateRefreshChanges(mv, changes)` (via `Database._propagateRefreshChanges`), called in `refreshMaintainedTable` after re-registration and before the `stale` clear. It runs the back half of `postApplyBackingChanges` (now factored into `enforceRecordAndCascade`): parent-side referential enforcement → `recordMaintenanceChanges` → MV-over-MV cascade, then `flushDeferredMaintenance` with fresh structures.
- **Statement atomicity.** `refreshMaintainedTable` wraps the work in a `__refresh_N` savepoint (broadcast), so a failed refresh inside an explicit transaction unwinds its own writes. Before this, a constraint violation inside `begin … refresh` left the rejected `replace-all` rows pending in the transaction (static reading; not separately reproduced).
- **Re-stale on undo.** New primitive `TransactionManager.onUndo(action)` (`Database._onTransactionUndo`): actions are layered like the change log — a `rollback to savepoint` runs the actions of the layers it discards, `release` moves them to the parent layer, a rollback or failed commit runs all, a commit drops them. A refresh that cleared `stale` (or took the reshape arm) registers `markStaleIfPresent` after its savepoint releases. On a failure path, a stale MV whose plan was re-registered is unregistered again.

## Deviations from the ticket's design (please weigh)

- **Precise undo instead of "re-stale on any undo".** The ticket proposed a per-transaction set re-staled from `Database.transactionRolledBack`. Every failed DML statement in an explicit transaction rolls back its own statement savepoint, which fires that hook, so `begin; refresh mv; <any failing insert>; commit` would have left `mv` stale. The layered `onUndo` avoids that and needs no commit hook. Cost: a new TM primitive (~40 lines).
- **No per-row validation and no collision telemetry in propagation.** The ticket listed both. Derived-row validation is redundant with the bulk scan (which covers every stored row) and would be evaluated against pre-retype images on the reshape arm. Coarsening collision telemetry contradicts `docs/materialized-views.md` § Coarsened backing keys ("the REFRESH path is not a collision site"): the set gate already rejects real collisions, so a refresh `update` is a replacement over time and would be reported as a false merge.
- **`attachMaintainedDerivation`'s cascade was left as is** (it still loops `_maintainRowTimeCoveringStructures` itself and does not record the attached table's own diff). Not repointed at the new entry, to avoid widening scope.

## Behaviour changes a reviewer should know

- `begin; refresh; rollback` now undoes a data-only refresh (rows restored, MV stale again). `refreshAllMaterializedViews` inside a caller's `begin` is now decided by that transaction.
- A refresh now enforces a declared secondary UNIQUE on the maintained table (the host checks `applyMaintenance` batches; `replaceContents` never did).
- A table whose FK references a maintained table now has its parent-side actions run when a refresh removes or changes a parent row (RESTRICT rejects the refresh). Not covered by a new test.
- The store's `replaceContents` used to commit the coordinator's pending transaction before swapping; refresh no longer goes through it, so the store parity tests in `mv-store-backing.spec.ts` no longer log "rollback-to savepoint depth 0 out of range".
- The `ddl_transaction_policy = 'strict'` gate on REFRESH is unchanged (the reshape arm still escapes); only its justification comment was reworded.

# Tests

- `53-materialized-views-rowtime.sqllogic` (after the fan-out block): arm 1 — refresh consumer `rc2` first, then producer `rc1`; `rc2` must end with rows 1, 2, 3. Fails without propagation (verified: "Row count mismatch. Expected 3, got 2").
- `95-assertions.sqllogic` (§ "A REFRESH that re-derives violating rows trips the assertion", replacing the old "deliberately stays outside" note): arm 2 — the refresh fails with `Integrity assertion failed: arf_nonneg` and `arf_mv` is back to `[(1,1)]`. Fails without propagation (verified).
- `maintained-table-refresh-revalidation.spec.ts` § "a refresh is part of its transaction" (replaces 'commit-first parity'):
  - an enclosing rollback restores the pre-refresh rows and leaves the table stale (the restore-stale hook);
  - a later failed statement in the same transaction does not undo the refresh — pins the layered-undo precision. Cut it if the reviewer prefers the ticket's simpler over-staling design.
- `quereus-store/test/mv-store-backing.spec.ts`: the store "commit-first parity" test is inverted (rollback restores the store rows and leaves `mt` stale), using a `g … set collate nocase` stale trigger so the data-only arm runs. Two parity tests had their comments corrected.

Runs: `yarn lint` (quereus) clean; `yarn test` (all workspaces) green; `yarn test:store` green (11095 passing). Store package tests resolve `@quereus/quereus` from its built `dist`, so `packages/quereus` must be rebuilt (`yarn build`) before running them against engine changes.

# Known gaps / things to probe

- **Reshape-arm diff images predate the post-reconcile retype.** Recorded change-log projections and parent-side FK enforcement on that arm see the pre-conversion values (e.g. TEXT `'5'` for a column becoming INTEGER). PK columns cannot be retyped by a reshape (inexpressible), so keys are right. Consumers are already stale there (the reshape fires `table_modified`), so the cascade does not run. Untested.
- **Re-staling cascades.** `markMaterializedViewStale` emits the backing invalidation, which also marks consumers stale. So after `begin; refresh mv1; rollback`, a live `mv2` over `mv1` goes stale too. That forces one extra refresh; it does not make anything wrong.
- **Failed commit with partially committed connections.** If COMMIT fails after some connections committed, the undo actions still run and may re-stale an MV whose rows did commit. That also only forces an extra refresh.
- **Parent-side referential actions from a refresh** (RESTRICT / CASCADE on tables referencing a maintained table) have no dedicated test.
- **Cost.** The change log and cascade scale with the diff; the `NOTE:` above `recordMaintenanceChanges` now names refresh as a second wide-diff source (escape hatch: table-granular invalidation).
