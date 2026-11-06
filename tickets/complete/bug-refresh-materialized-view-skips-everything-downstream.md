---
description: Rebuilding a stored view's contents by hand now tells everything downstream — views built on it are updated, integrity rules check the rebuilt rows, and the rebuild is undone by a rollback like any other write.
architecture: docs/materialized-views.md#refresh-materialized-view
files:
  - packages/quereus/src/runtime/emit/materialized-view.ts            # refreshMaintainedTable (savepoint, stale clear, undo action), rebuildAndPropagate
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts    # rebuildBacking (single replace-all path, RebuildBackingOptions, returns diff), reshapeBacking/reshapeBackingInPlace
  - packages/quereus/src/core/database-materialized-views.ts          # propagateRefreshChanges, enforceRecordAndCascade
  - packages/quereus/src/core/database-transaction.ts                 # TransactionManager.onUndo + undoLayers
  - packages/quereus/src/core/database.ts                             # _onTransactionUndo, _propagateRefreshChanges
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic
  - packages/quereus/test/logic/95-assertions.sqllogic
  - packages/quereus-store/test/mv-store-backing.spec.ts
---

# What shipped

`refresh materialized view <mv>` used to swap the stored rows and tell nobody. Now (landed in `ticket(implement): bug-refresh-materialized-view-skips-everything-downstream`):

- `rebuildBacking` always lands the recomputed rows with `applyMaintenance(conn, [{ kind: 'replace-all', rows }])` on the transaction's connection and returns the realized keyed diff; `replaceContents` is used only by the create-fill. Only the reshape arm (`commitEarly: true`) commits the rows ahead of the transaction, because its post-reconcile retype/recollate/tighten ops read committed contents (accepted limitation recorded in a `NOTE:` in `reshapeBackingInPlace`).
- `MaterializedViewManager.propagateRefreshChanges` sends that diff through the tail of the ordinary maintenance pipeline (`enforceRecordAndCascade`): parent-side referential actions, change-log recording (so assertions and watchers see the refresh), and the cascade into live maintained tables built on the refreshed one.
- `refreshMaintainedTable` runs inside a `__refresh_N` savepoint, so a failed refresh inside an explicit transaction unwinds only itself.
- New `TransactionManager.onUndo(action)` primitive, layered like the change log (`rollback to savepoint` runs the discarded layers' actions, `release` moves them to the parent, rollback / failed commit runs all, commit drops them). A refresh that cleared `stale` (or took the reshape arm) registers "mark stale again" through it.

Behaviour changes: `begin; refresh; rollback` undoes a data-only refresh and leaves the view stale; a refresh enforces a declared secondary UNIQUE; a refresh that removes or changes a row referenced by another table's foreign key runs that key's parent-side action (RESTRICT rejects the refresh).

# Review findings

Read the implement diff first, then the handoff. Probed the untested contracts with a throwaway spec (deleted afterwards).

**Correctness — checked, no defect found.**
- Savepoint/connection interplay: a backing connection that joins after `__refresh_N` is created gets the savepoint replayed (`TransactionManager.replaySavepoints`), and the reshape arm's early commit re-joins through the same path, so release / rollback-to stay in range. A failing early commit rolls the whole transaction back; the following `_rollbackAndReleaseSavepointBroadcast` swallows the now-missing savepoint, as intended.
- Undo layering: `undoLayers.length` stays `changeLogLayers.length + 1` through create / release / rollback-to / `clearChangeLog` / reset. Probed `begin; savepoint s; refresh; rollback to s` → view stale again; a second refresh then `release s; commit` → view live and maintaining new rows.
- `propagateRefreshChanges`' "no row-time plan" internal error cannot fire spuriously: `registerMaterializedView` always installs a plan or throws, and `backingRecomputed: true` skips the function-drift re-stale.
- Failure path: the reshape arm grafts `mv.derivation` onto the live record, so the `mv.derivation.stale` check in the catch sees the catalog record's flag.
- Probed: a failed refresh (CHECK violation) inside `begin` keeps the transaction's earlier insert; `begin; refresh rc1; rollback` restores the cascaded consumer `rc2` rows too (both levels end stale — see tripwire below); FK `on delete cascade` from a child of the maintained table deletes the child row on refresh.
- Store persistence of `stale`: the undo action goes through `markMaterializedViewStale`, which emits `table_modified`, the event the store's durable stale-MV set already recomputes on.

**Handoff gap re-assessed.** "Reshape-arm diff images predate the post-reconcile retype" is narrower than stated: the reconcile writes the re-planned body's rows as given, so the diff's *new* images already carry the new type; only the *old* images carry the old type, and those are what the rows really held. No change made.

**Tests.**
- Added one: `maintained-table-refresh-revalidation.spec.ts` § "a refresh that removes a row a child references under RESTRICT is rejected" — pins the parent-side enforcement the docs promise for refresh, which had no test.
- Kept the implementer's tests: the two sqllogic arms reproduce the bug (verified failing without propagation per the handoff), and "a later failed statement … does not undo the refresh" pins the layered-undo design choice over the ticket's simpler over-staling proposal, which this review endorses (the simpler design would re-stale on every failed DML statement in the transaction).

**Tripwires parked.**
- Over-staling after an undone refresh (consumer cascade through the backing invalidation; failed COMMIT after the MV's connection already committed) — `NOTE:` above `markStaleIfPresent` in `runtime/emit/materialized-view.ts`.
- Wide change-log diff from a refresh that rewrites most of a table — already parked by the implementer in the `NOTE:` above `recordMaintenanceChanges`.

**Docs.** Read `docs/materialized-views.md` § REFRESH, `docs/incremental-maintenance.md`, `docs/mv-backing-host.md`, `docs/migration.md` (sync replication of refresh deltas still accurate: the store host publishes per-change events from `applyMaintenance`), `docs/module-authoring.md`; grepped docs and sources for leftover "commit-first" wording — none remain. No further edits needed.

**Hygiene.** `materialized-view-helpers.ts` is 3509 lines and `database.ts` 3484 (`wc -l`); both are already tracked by `debt-oversized-source-files`. The module-level `refreshSavepointCounter` is fine: savepoint lookup searches newest-first, so even a user savepoint with the same name resolves to the refresh's own.

**Not done / out of scope.** `attachMaintainedDerivation`'s own cascade was not repointed at `propagateRefreshChanges` (implementer's call to limit scope; behaviour is unchanged there). Commit-failure undo ordering differs slightly from rollback's (actions run before `resetToAutocommit` on a failed commit, after it on a rollback); both only touch catalog flags, so no effect.

**Validation.** `yarn workspace @quereus/quereus run lint` clean; `yarn test` (all workspaces) green — 11103 passing in quereus, no failures anywhere. `yarn test:store` not re-run: this pass changed only a comment and added a memory-engine test; the implementer ran it green after the engine changes.
