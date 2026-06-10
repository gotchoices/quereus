----
description: Review — restoration pass that revives dependent MVs an ALTER … RENAME marked stale but provably did not affect (unreferenced column rename, constraint-only rewrite of another source, `select *` pure name shift), instead of leaving them silently stale with writes no longer propagating.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # restoreUnaffectedMaterializedViews (new, exported), restoreMaterializedViewLive (new shared restore tail), renameShiftedBackingColumns (+optional preDerivedShape), applyMaterializedViewRewrite (tail extracted)
  - packages/quereus/src/runtime/emit/alter-table.ts                 # propagateTableRename / propagateColumnRename call the pass after the per-schema loops
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic   # new §10–§12
  - packages/quereus/test/mv-rename-propagation.spec.ts              # failure-path test updated; new transient-failure-healed test
  - docs/materialized-views.md                                       # "Provably-unaffected restoration" bullet in § Rename propagation
----

# Restore provably-unaffected MVs after a source rename — implemented

## What was built

`restoreUnaffectedMaterializedViews(db, preStale)` in `materialized-view-helpers.ts`,
called once at the end of `propagateTableRename` and `propagateColumnRename`
(after all per-schema loops, so every rewrite / backing rename / cascade event has
fired). For every MV across all schemas with `mv.stale && !preStale.has(key)`
(statement-local staleness only — a pre-existing flag is never touched):

1. `deriveBackingShape(db, astToString(mv.selectAst), mv.columns)` — a throw
   (body no longer plans, e.g. chained MV referencing a renamed-away producer
   output name) is caught: log, leave stale, continue.
2. `describeBackingShapeMismatch(liveBacking, shape)` structural mismatch → leave
   stale (REFRESH's shape-mismatch rebuild owns it).
3. Otherwise the shared restore tail `restoreMaterializedViewLive`:
   `renameShiftedBackingColumns` (no-op when names match; carries a pure name
   shift onto the live backing, firing the backing `table_modified` that
   correctly cascades staleness to chained MVs) → `db.registerMaterializedView`
   → `mv.stale = false` (register-before-clear preserved).

The tail was extracted from `applyMaterializedViewRewrite` so both restore paths
share one code path; the changed-AST path passes `{ bodySql }` only when the body
changed (`renamedColumns`), so a table rename / clause-only change still skips the
backing-name re-plan. `renameShiftedBackingColumns` accepts an optional
pre-derived shape so the restoration pass doesn't plan the body twice.

No `materialized_view_modified` fires from the pass (MV record unchanged; `stale`
is runtime state, not persisted) — per ticket spec.

## Validation done

- `yarn build` clean, `yarn test` fully green (all workspaces), `yarn workspace
  @quereus/quereus run lint` clean.
- 53.2 sqllogic extended with the ticket's three reproductions (§10 unreferenced
  column rename, §11 FK-only rewrite of another source, §12 `select *` name
  shift), each asserting live writes after the rename AND a working REFRESH.
  **Sensitivity verified**: with the restoration call disabled, §10 fails exactly
  as the ticket describes (row-count mismatch — insert not propagated).
- Existing §1–§9 stay green, including §6 (`n2` chained MV stays stale with the
  staleness diagnostic).
- 53.2 also run under `QUEREUS_TEST_STORE=true` (store-backed sources, memory
  backing) — green.
- Unit spec `mv-rename-propagation.spec.ts`: pre-existing-stale-survives test
  unchanged and green (the pass's `preStale` filter is what protects it).

## Behavioral change a reviewer should scrutinize

**Failure-path retry semantics.** The pass deliberately filters only on
`stale && !preStale`, so an MV that `failMaterializedViewRenamePropagation`
force-marked stale earlier in the same statement is *retried* by the pass. A
persistent failure fails again → stays stale (the old guarantee). A *transient*
failure is now healed within the statement: the retry re-validates body + shape +
registration, and all three passing implies the MV is consistent (the catalog
record was swapped with the rewritten body before the throw; backing data is
statement-locally valid). The old unit test asserted a one-shot injected
registration failure leaves the MV stale — that mock now heals, so the test was
split: the persistent-failure case throws for the whole statement (asserts 2
attempts, stays stale, REFRESH recovers), and a new test locks in the
transient-failure-healed behavior. If review judges the heal undesirable, the
alternative is tracking failure-marked MVs in a statement-local set and excluding
them from the pass.

## Known gaps / not done

- **Persistence edge (pre-existing, unchanged):** when a body rewrite's
  `materialized_view_modified` never fired because the rewrite threw mid-way, a
  store reopen rehydrates the OLD body. That gap exists with or without this
  ticket; the heal only changes the in-session state (live vs stale).
- **Cross-schema MV chains:** restoration order is schema-creation order, which is
  topological for same-schema chains (producer restores before consumer) but not
  guaranteed across schemas; a cross-schema consumer examined before its producer
  restores is left stale (REFRESH recovers). Single pass per ticket spec — no
  fixpoint iteration.
- Full `yarn test:store` was NOT run (AGENTS.md reserves it for store-specific
  diagnosis/release); only the 53.2 file was run in store mode.
- The constraint-only `table_modified` listener refinement (avoiding the spurious
  stale-mark entirely) is deliberately out of scope — backlog
  `mv-staleness-constraint-only-table-modified`.

## Quick manual probes

```sql
-- unreferenced column rename: MV stays live
create table t (id integer primary key, v integer not null, u integer not null);
insert into t values (1, 10, 100);
create materialized view mv as select id, u from t;
alter table t rename column v to w;
insert into t values (2, 20, 200);
select id, u from mv order by id;   -- both rows

-- select * pure name shift: exposed name follows the rename, MV stays live
create table rs (id integer primary key, v integer not null);
create materialized view mvs as select * from rs;
alter table rs rename column v to w;
insert into rs values (1, 10);
select id, w from mvs;              -- new name, live
```
