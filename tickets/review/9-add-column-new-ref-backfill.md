description: Review the implementation of `new.<column>` (and other non-foldable, deterministic) DEFAULTs on ALTER TABLE ADD COLUMN — validated through the shared DDL validator, stored for future inserts, and backfilled into existing rows by per-row evaluation with the existing row in scope. Treat the tests as a floor; the per-row CHECK validation gap (below) is the highest-priority thing to verify/close.
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/planner/building/alter-table.ts, packages/quereus/src/planner/nodes/alter-table-node.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic, docs/sql.md, docs/runtime.md
----

## What landed

`ALTER TABLE … ADD COLUMN … DEFAULT (…)` now accepts a non-foldable, deterministic
default (including `new.<column>`), stores it on the new column's schema (future inserts
resolve it via the existing `createRowExpansionProjection` path), and **backfills existing
rows by per-row evaluation** with the existing row in scope. `new.<column>` resolves to
the existing row's sibling during backfill — the moral equivalent of
`update <t> set <newcol> = <default over the row>` over the pre-existing rows.

### Seam chosen (and why) — read this before reviewing

The ticket suggested an engine-generic internal `update <t> set <newcol> = <default>`. I
**tried that first and abandoned it**: in the memory module, `addColumn` mutates the base
layer *in place*, and an internal `UPDATE` re-enters the DML executor on a connection whose
transaction-layer schema is still the pre-ALTER shape — it fails with "Too many values for
UPDATE … expected 2, got 3" (and worse, succeeds by luck of layer-collapse timing in other
orderings). This is exactly why `rebuildMemoryTable` bypasses SQL. So the implementation
uses the **`keyDefault` pattern** instead (the same one the shared-key view-write envelope
uses), which reuses `buildRowDefaultScope` as the ticket directs:

- **Planner** (`planner/building/alter-table.ts` → `buildAddColumnBackfill`): for a
  non-foldable default, validates it through the shared DDL validator
  (`SchemaManager.validateAddColumnDefault`, newly added — a sibling of
  `validateAlterColumnDefault` over a shared `validateDdlDefault` core), then compiles the
  default against the table's **existing** columns as the "supplied" row via
  `buildRowDefaultScope` (fresh attributes + `RowDescriptor`), and hangs `{ node,
  rowDescriptor }` on the `addColumn` action (`AlterTableNode` → `AddColumnBackfill`).
  Literal / NULL defaults fold → no backfill node (fast path preserved).
- **Emitter** (`runtime/emit/alter-table.ts`): emits the scalar via `emitCallFromPlan`
  (scheduled param → callback), installs a `createRowSlot` over the row descriptor, and
  builds a per-row `backfillEvaluator(row)` that sets the slot and runs the callback. The
  evaluator is passed to `module.alterTable` via the new optional
  `SchemaChangeInfo.addColumn.backfillEvaluator`. The slot is closed as soon as
  `alterTable` returns.
- **Memory module** (`memory/module.ts` → `manager.addColumn` → `base.addColumnToBase` →
  `recreatePrimaryTreeWithNewColumn`): when an evaluator is supplied, derives each new-column
  value from the existing row; builds the new B-tree **locally and swaps it in only once
  every row migrates**, so a throwing evaluator / NOT NULL violation leaves the live tree
  intact for rollback. The manager's NOT NULL pre-check was relaxed to allow a non-literal
  expression default (the engine backfills + the module enforces NOT NULL per row).
- **Store module** (`quereus-store`): `addColumn` reads the same `backfillEvaluator` and
  threads it into `store-table.ts` `migrateRows`, which derives each new-column value per
  row and rejects NULL for a NOT NULL column. The isolation layer already passes
  `SchemaChangeInfo` through unchanged, so no isolation change was needed.

### NOT NULL / revert

NOT NULL of a per-row default is enforced **in the module** during backfill (values in
hand, throws `CONSTRAINT` before the column is committed), which the engine surfaces as a
clean ALTER failure with the catalog untouched (the manager's existing catch restores its
schema; build-local-then-swap keeps the tree intact). This replaced an earlier
post-backfill `SELECT … WHERE <col> IS NULL` scan that proved unreliable (see gap #1).

## Use cases to validate (tests are a floor)

Memory (`yarn test`) and store (`yarn test:store`) both green for the ALTER files. Covered
in `test/logic/03.4-defaults.sqllogic`:

- `add column doubled integer default (new.base * 2)` over pre-existing rows → each existing
  row backfills from its **own** `base`; a later insert supplying `base` derives `doubled`;
  an explicit value still overrides; an insert **omitting** `base` raises the same
  `isn't a column` resolution error as the single-source path.
- Literal-fold ADD COLUMN default (`default (3 + 4)`) still bulk-backfills (fast path).
- `add column doubled integer not null default (new.base * 2)` — all-non-null backfill
  succeeds; a backfill that yields NULL for some row is **rejected and the table is left
  unchanged** (column not added).
- `90.2.1-alter-extra-errors.sqllogic` unchanged-and-passing: bind-param `default (:foo)`
  and bare-column `default (a + 1)` ADD COLUMN defaults still rejected (now at plan-build
  time via the shared validator), and the literal-default + CHECK-backfill revert
  (`§3`) still rejects + leaves the table unchanged.

Reviewer-suggested additional cases: `new.<col>` reading a generated sibling; multiple
`new.` refs; `add column` on an empty table (no rows → no backfill); store-mode parity for
the NOT NULL-rejection case (only the success/error-substring cases run there today).

## Known gaps — please scrutinize

1. **(Highest priority) Non-foldable default + a column-level CHECK that some backfilled
   rows violate is NOT reliably rejected.** `validateBackfillAgainstChecks` runs a
   mid-ALTER `SELECT`, and that scan does **not** observe the evaluator-backfilled rows
   (it sees the pre-backfill committed layer — a layer-visibility fragility that only
   surfaces now that non-foldable defaults are allowed; the **literal**-default CHECK path
   is unchanged and still works, per `90.2.1 §3`). Repro:
   `create table t(id integer primary key, base integer null); insert … (1,5),(2,-3);
   alter table t add column c integer default (new.base*2) check (c > 0);` — should reject
   (c=-6) but currently succeeds. NOT NULL is unaffected because the module enforces it
   in-hand. Root cause appears to be that running the backfill sub-program on the runtime
   context perturbs the subsequent sibling `SELECT`'s snapshot; closing the row slot before
   the scan did **not** fix it. Recommended fix: enforce the new column's CHECK per row in
   the module (mirroring the NOT NULL path) rather than via a post-scan, or chase the
   sub-program/SELECT snapshot interaction. Consider spawning a `fix/` ticket.

2. **Store overlay / staged rows.** `quereus-isolation`'s `migrateOverlayForAlter` was not
   touched — only the underlying store's committed rows are backfilled via the evaluator.
   An ADD COLUMN issued while the same connection has uncommitted staged writes in the
   overlay would append the default (not the per-row value) to those staged rows. Untested;
   my tests commit before ALTER.

3. **Subquery defaults** (`default (coalesce((select …), 0) + new.x)`) compile to an
   unoptimized scalar emitted via `emitCallFromPlan`; not exercised by tests. The
   single-source INSERT path supports them, so parity is plausible but unverified.

4. **Design note:** the backfill `ScalarPlanNode` is stored on the `addColumn` action, not
   exposed via `AlterTableNode.getChildren`/`getRelations`, so optimizer passes don't see
   it (intentional — it resolves purely via the runtime row slot, like `keyDefault`). Fine
   for the tested scalar shapes; worth a glance for anything that walks the full plan tree.

5. **Mutation-context tables:** `buildAddColumnBackfill` does not pass
   `mutationContextVarNames` to `buildRowDefaultScope` (no mutation context exists at
   backfill time). An ADD COLUMN default referencing a context var on such a table is an
   untested edge case.

## Validation run

- `yarn workspace @quereus/quereus test` → **4740 passing, 9 pending**.
- `yarn workspace @quereus/quereus lint` → clean. `… run typecheck` → clean.
- `yarn test:store` (filtered to `03.4-defaults`, `90.2-alter-table-errors`,
  `90.2.1-alter-extra-errors`) → **3 passing**. Store mode requires `quereus` + `quereus-store`
  to be **built** first (their `@quereus/quereus` import resolves to `dist`); I rebuilt both
  locally — CI/`test:full` builds fresh, so no committed dist.

## Docs

`docs/runtime.md` (DDL DEFAULT validation note) and `docs/sql.md` (§ Default Values +
ADD COLUMN section) updated to describe the per-row existing-row backfill semantics.
