---
description: Rebuilding a stored view's contents by hand does not tell anything downstream about it, so views built on top of it can keep serving old data without being flagged, and integrity rules never get a chance to object to what the rebuild brought in.
architecture: docs/materialized-views.md#refresh-materialized-view
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # rebuildBacking (~1808): replaceContents fast path + constraint-bearing branch that drops the applyMaintenance result; attachMaintainedDerivation cascade (~1564) is the model to copy; reshapeBackingInPlace (~2876) calls rebuildBacking
  - packages/quereus/src/runtime/emit/materialized-view.ts           # refreshMaintainedTable (~182); emitRefreshMaterializedView comment on commit-first (~128)
  - packages/quereus/src/core/database-materialized-views.ts         # postApplyBackingChanges (~775), recordMaintenanceChanges (~852) + its docstring, flushDeferredMaintenance, markMaterializedViewStale (~451)
  - packages/quereus/src/core/database.ts                            # transactionRolledBack (~3159), refreshAllMaterializedViews (~3344), _maintainRowTimeCoveringStructures / _flushDeferredMaintenance
  - packages/quereus/src/core/database-transaction.ts                # notifyRolledBack — fires on rollback, failed commit, rollback to savepoint
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # 'commit-first parity' block (~728) pins the behaviour this ticket changes
  - packages/quereus/test/logic/95-assertions.sqllogic               # comment ~1165 documenting the gap
  - docs/incremental-maintenance.md                                  # § Recording changes (~432, ~443) — the gap paragraph
  - docs/materialized-views.md                                       # § REFRESH MATERIALIZED VIEW (~200)
  - docs/mv-constraints.md                                           # refresh paragraph (commit-first early commit)
  - docs/mv-ingestion.md                                             # ~98 sweep "commit-first, not atomic"
  - docs/module-capabilities.md                                      # ~110 refresh escapes the transaction
  - docs/module-authoring-transactions.md                            # ~332 early-commit sites
repro: verified
---

# What is wrong

`refresh materialized view <mv>` recomputes a materialized view's body and swaps the stored rows. Every other write to a maintained table's rows runs the realized per-row change list through `postApplyBackingChanges` (`core/database-materialized-views.ts`), which records it into the transaction change log (so `create assertion` rules and watchers see the table as changed) and cascades it to every materialized view built on top. Refresh does neither:

- On the common path (no declared CHECK/FK) `rebuildBacking` calls `host.replaceContents(rows)`, which swaps the committed contents and returns nothing.
- On the constraint-bearing path it calls `host.applyMaintenance(conn, [{ kind: 'replace-all', rows }])`, which returns the minimal keyed diff, and discards it, then commits that connection early.

`alter table … set maintained as …` (`attachMaintainedDerivation`, `materialized-view-helpers.ts` § "Cascade the GENUINE reconcile changes") already does the cascade half correctly and is the model.

## Reproduced (memory module, throwaway mocha spec, since deleted)

**Arm 1: a consumer view is left wrong and not flagged.** If the consumer is refreshed before its producer, the producer's refresh changes rows the consumer never hears about. The consumer is not stale, so nothing warns, and later writes keep it permanently missing rows:

```sql
create table src (id integer primary key, v integer not null, g text not null default 'keep');
create materialized view mv1 as select id, v from src where g <> 'skip';
create materialized view mv2 as select id, v * 10 as w from mv1;
insert into src (id, v) values (1, 1);
alter table src alter column g set collate nocase;   -- mv1 and mv2 both go stale
insert into src (id, v) values (2, 2);                -- drifts into src only
refresh materialized view mv2;                        -- mv2 recomputed from stale mv1: [1]
refresh materialized view mv1;                        -- mv1 -> [1, 2]; mv2 not told, not stale
insert into src (id, v) values (3, 3);
select id, w from mv2 order by id;
-- actual:   [{id:1,w:10},{id:3,w:30}]
-- expected: [{id:1,w:10},{id:2,w:20},{id:3,w:30}]
```

(Refreshing producer-first, the order `refreshAllMaterializedViews` uses, does not show the bug: the consumer is still stale, so it is flagged and its own refresh fixes it. The bug is in the case where the consumer is live.)

**Arm 2: an assertion never runs on a refresh.**

```sql
create table src (id integer primary key, v integer not null, g text not null default 'keep');
create materialized view mv1 as select id, v from src where g <> 'skip';
create assertion nonneg check (not exists (select 1 from mv1 where v < 0));
insert into src (id, v) values (1, 1);
alter table src alter column g set collate nocase;
insert into src (id, v) values (2, -2);
refresh materialized view mv1;    -- actual: succeeds, mv1 = [(1,1),(2,-2)]
                                  -- expected: Integrity assertion failed: nonneg
```

# Root cause

One site: `rebuildBacking` / `refreshMaintainedTable` never send the refresh's realized change list through the invariant pipeline (`postApplyBackingChanges`: record + parent-side referential enforcement + cascade). The `replaceContents` fast path cannot, because it reports no changes.

# Design (decided here)

## Refresh becomes transactional on the non-reshape path

Recording and cascading only make sense if the refresh's own write rolls back with its transaction. Change records and cascaded consumer writes live in the transaction's pending state. If the producer's swap were still committed first, then `begin; refresh mv1; rollback` would revert `mv2` and the change log but keep `mv1`, which brings arm 1 back. An assertion failure at COMMIT would also roll the transaction back while leaving the violating `mv1` rows committed. That contradicts the expected behaviour ("the commit fails with that assertion's error, exactly as an ordinary write would"), and it contradicts the documented model in `docs/sql-views.md` / `docs/usage.md` ("a rollback reverts source and backing together"). The current "`begin; refresh; rollback` does not undo the refresh *today*" wording reads as a known wart, not a principle.

So on the **fast (shape-unchanged) arm**, both branches of `rebuildBacking` go through `applyMaintenance(conn, [{ kind: 'replace-all', rows }])` on the transaction's connection (`resolveAttachConnection`). Keep `assertRefreshRowsAreSet` in front so the duplicate-key error stays the same as `replaceContents`'s. There is **no** early commit, and `replaceContents` is no longer used by refresh (create-fill in `materializeView` keeps it). The constraint scan stays where it is when `hasApplicableConstraints` holds.

The **reshape arm** (`reshapeBackingInPlace` → `rebuildBacking`) keeps its early commit. Its post-reconcile retype/recollate/tighten-NOT-NULL module ops scan committed contents, and its structural module ops are non-transactional anyway (DDL-grade). Give `rebuildBacking` a parameter for this (e.g. `{ commitEarly: boolean }`) instead of inferring it. Have `rebuildBacking` **return** the `BackingRowChange[]` on both arms.

## Restore `stale` when the refresh is undone

`refreshMaintainedTable` clears `derivation.stale` and re-registers the row-time plan. Those are catalog changes, and a rollback does not undo them. Once the data is transactional, `begin; refresh; rollback` would leave the MV marked fresh, with a live plan, over its reverted drifted rows. That is a silent wrong result, worse than today. So any refresh that cleared `stale` must re-mark the MV stale (via `markMaterializedViewStale`, which also releases the plan) if that transaction's work is undone. Hook it into `Database.transactionRolledBack` (fires on rollback, failed commit and `rollback to savepoint`): keep a per-transaction set of "MVs this transaction un-staled", re-stale them on undo, and clear the set on commit. Over-staling after a `rollback to savepoint` that did not actually cover the refresh is harmless: it only forces a redundant refresh. A refresh of an MV that was *not* stale needs no restore, because the rolled-back contents are its maintained state. Check whether a failed *statement* (the per-statement atomicity savepoint) reaches `notifyRolledBack`. If it does not, the refresh must re-stale on its own failure path. `refreshMaintainedTable` already leaves `stale` set if it throws before the clear, so ordering the propagation below **before** the stale clear covers most of this.

## Propagate the change list through the same pipeline as maintenance writes

Add one manager entry, e.g. `MaterializedViewManager.propagateRefreshChanges(mv, changes)` (exposed as a `Database._…` internal like `_flushDeferredMaintenance`). After re-registration it looks up the MV's fresh plan and runs `postApplyBackingChanges(plan, changes, undefined, deferred, residualBatch, 0)` with fresh per-statement structures, then `flushDeferredMaintenance(deferred, residualBatch)`. That gives refresh exactly what every other maintained write gets: coarsening telemetry, the NOT-NULL seeded-PK guard, derived-row validation, parent-side referential enforcement (a table FK-referencing `mv1` is checked when a refresh removes a parent row, which today it is not), `recordMaintenanceChanges` (arm 2, plus watchers), and the MV-over-MV cascade (arm 1). Reuse it rather than copying the attach cascade. It may be worth pointing `attachMaintainedDerivation`'s cascade at the same entry, but only if it keeps attach's current behaviour of not recording the attached table's own changes, or if that behaviour is deliberately changed and documented. Don't widen scope silently.

Call order in `refreshMaintainedTable`: rebuild (collect changes) → re-register → propagate → clear `stale` → notify. Record with the **live** record's `primaryKeyDefinition` (`plan.mv` after re-registration, which is the reshaped record on the reshape arm).

Derived-row validation inside `postApplyBackingChanges` repeats the bulk scan's check for the changed rows. That is acceptable (bounded by the diff). Skipping it for refresh is an optimisation the implementer may take if it stays simple.

## Cost: row-granular, bounded by the diff

`replace-all` realizes the **minimal keyed diff**, so the change list scales with how far the stored rows drifted, not with table size. A refresh that reproduces identical contents yields zero changes, and `postApplyBackingChanges` returns at once on an empty list: no records, no cascade, no notifications. Only a refresh that rewrites most of the table costs O(table) downstream, in one transaction. That is the same shape as the attach cascade and the full-rebuild arm. Stay row-granular. Extend the existing `NOTE:` above `recordMaintenanceChanges` (table-granular invalidation as the escape hatch) to name refresh as a second wide-diff source, instead of building table granularity now.

## Reshape-arm limitation (accepted, document it)

On the reshape arm the data is already committed when COMMIT-time assertions run. A violating reshaping refresh therefore fails the commit with the assertion error (better than today's silence), but the rebuilt rows stay. Consumers are already stale there (the reshape fires `table_modified`), so arm 1 does not apply. Leave a `NOTE:` at the reshape call site and one line in `docs/materialized-views.md` § REFRESH.

# Knock-on effects

- `emitRefreshMaterializedView`'s DDL-policy gate comment: keep the gate (the reshape arm is still escaping DDL and is data-dependent), but reword reason (2). Only the reshape arm is commit-first now.
- `refreshAllMaterializedViews` keeps per-MV implicit transactions and topological order. A dependent's body still reads its producer's refreshed rows, because the producer's implicit transaction has committed. With the cascade, a live consumer is updated by its producer's refresh, and its own later refresh is then a zero-diff no-op. Reword `docs/mv-ingestion.md` ~98, which justifies the sweep by commit-first.
- quereus-store `replaceContents` commits the coordinator's pending transaction before swapping (`packages/quereus-store/src/common/backing-host.ts` ~356). Moving refresh off it removes that side effect for refresh. The store's `applyMaintenance('replace-all')` already backs the constraint-bearing branch, so that path is exercised. Run `yarn test:store` once, since this changes refresh's store path.
- Replicating store backings (`quereus.sync.replicate`) already publish the minimal diff from both `replaceContents` and `replace-all`. Events now flush at the engine commit, as `applyMaintenance`'s do.

# TODO

- `rebuildBacking`: drop the `replaceContents` refresh branch; always `assertRefreshRowsAreSet` → `applyMaintenance('replace-all')` on `resolveAttachConnection` → (constraints) `validateDeclaredConstraintsOverContents` → early commit **only** when the caller asks (reshape arm). Return the changes. Update its docstring (the commit-first section).
- `reshapeBackingInPlace`: pass the early-commit flag and thread the returned changes back to `refreshMaintainedTable`. Add the reshape-limitation `NOTE:`.
- Add the manager propagation entry (`postApplyBackingChanges` + `flushDeferredMaintenance` with fresh structures) and its `Database._…` internal. Call it from `refreshMaintainedTable` after re-registration, before the stale clear.
- Restore-`stale`-on-undo: track the MVs a transaction un-staled; re-stale them in `transactionRolledBack`, clear on commit. Confirm a failed statement inside an explicit transaction is covered.
- Update `recordMaintenanceChanges`'s docstring ("bulk fills … `rebuildBacking` refresh … never route through") and extend its `NOTE:`.
- Tests, kept to what pays:
  - arm 1 repro above as sqllogic (e.g. in `53-materialized-views-rowtime.sqllogic` near the MV-over-MV cascade cases);
  - arm 2 repro above in `95-assertions.sqllogic`, plus a check that the refresh was undone (mv1 back to `[(1,1)]`). Replace the "deliberately stays outside" comment at ~1165;
  - invert `maintained-table-refresh-revalidation.spec.ts` § 'commit-first parity': `begin; refresh; rollback` now restores the pre-refresh rows **and** leaves the MV stale (one test, covering the restore-stale hook).
- Docs: delete the gap paragraph in `docs/incremental-maintenance.md` § Recording changes and fix its "bulk fills" sentence; update `docs/materialized-views.md` § REFRESH (no longer `replaceContents`; transactional except the reshape arm), `docs/mv-constraints.md` refresh paragraph, `docs/mv-ingestion.md` ~98, `docs/module-capabilities.md` ~110, `docs/module-authoring-transactions.md` ~332 (early-commit sites: the refresh reshape arm only).
- `yarn test` from `packages/quereus` (plus `yarn lint`), then `yarn test:store` once.
