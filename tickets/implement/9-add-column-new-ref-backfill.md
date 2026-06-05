description: Extend `new.<column>` DEFAULT references to the last remaining default path — ALTER TABLE ADD COLUMN. Allow a `new.<col>` (or otherwise valid non-literal) default, validate it through the shared DDL validator, store it for future inserts, and backfill existing rows by per-row evaluation with the existing row in scope. Split out of `default-new-ref-envelope-and-alter` because the per-row backfill needs a new module seam and is atomic with its own test.
prereq: default-new-ref-envelope-and-alter
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/planner/building/default-scope.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic, docs/sql.md, docs/runtime.md
----

## Background (what already landed in the prereq)

The prereq ticket (`default-new-ref-envelope-and-alter`) extended `new.<column>` defaults to the
shared-key view-write envelope and to `ALTER COLUMN SET DEFAULT`, and left the infrastructure this
ticket builds on:

- **`planner/building/default-scope.ts` → `buildRowDefaultScope(parentScope, targetColumns,
  sourceAttributes, mutationContextVarNames?)`** — registers supplied columns as `new.<col>` (+ bare).
  The single-source INSERT path (`createRowExpansionProjection`) already uses it, so a column added
  with a `new.<col>` default resolves for **future** inserts the moment its schema is stored — no
  INSERT-path change is needed for the forward direction.
- **`schema/manager.ts` → `validateOneDefault(...)`** (private core) and **`validateAlterColumnDefault(
  expr, columnName, tableName, hasMutationContext)`** (public) — the shared DDL validator that allows
  `new.`, rejects bind params / bare columns / non-determinism, and defers the build/determinism check
  to INSERT time. Reuse this (or generalize its name) for ADD COLUMN.

## The invariant to preserve

`new.<col>` means **"the value of sibling column `col` for the row this default is applied to, at the
moment it is applied."** For a *future* INSERT that is the INSERT-supplied sibling (already works via
the stored schema). For **backfilling existing rows** there is no INSERT — `new.<col>` must mean **the
existing row's sibling value**. Same "row this default is applied to" reading; coherent (the row
exists, read its column); but it changes ADD COLUMN backfill from "one literal for every row" to
"evaluate the default per existing row." Implement backfill as the moral equivalent of
`update <t> set <newcol> = <default over the row>` over the pre-existing rows.

## Current state to change

`runtime/emit/alter-table.ts` `runAddColumn()` (~lines 204–215) rejects any default that does not
`tryFoldLiteral(...)` to a concrete literal:

```ts
if (defaultConstraint && defaultConstraint.expr && tryFoldLiteral(defaultConstraint.expr) === undefined) {
    throw new QuereusError(`ALTER TABLE ADD COLUMN DEFAULT … must fold to a literal …`);
}
```

The memory module (`vtab/memory/layer/manager.ts` `addColumn`, and `base.ts` `addColumnToBase` /
`recreatePrimaryTreeWithNewColumn`) takes a single folded `defaultValue: SqlValue` and writes it into
every existing row — it currently *warns and writes NULL* when the default is a non-literal
expression. That single-literal seam is what must grow a per-row form.

## Requirements

- **Allow** a `new.<col>` (and otherwise valid, deterministic, non-literal) default on ADD COLUMN.
  - Route the default through the shared DDL validator (allow `new.`, defer; reject bind params /
    bare columns / non-determinism). A non-`new.`, non-literal, non-deterministic default stays
    rejected — so the existing `90.2.1-alter-extra-errors.sqllogic` cases (`default (:foo)`,
    `default (a + 1)` bare column) keep failing exactly as today.
  - Store the validated default expression on the new column's schema, so **future** inserts resolve
    it via `createRowExpansionProjection` (forward direction already works once stored).
- **Backfill existing rows by per-row evaluation** with the existing row in scope:
  - `new.<col>` resolves to the existing row's `col`; a literal/deterministic default evaluates as
    before. Reuse `buildRowDefaultScope` to build the default against the table's existing columns as
    the "supplied" row, then evaluate per existing row.
  - Decide the seam: either (a) the engine evaluates the default per row (e.g. an internal
    `update <t> set <newcol> = <default>` after the column is added NULL), or (b) a new module
    backfill hook that takes a per-row evaluator. Prefer the engine-generic path so non-memory modules
    inherit it; keep the literal fast-path (`tryFoldLiteral`) so the common case still does a single
    bulk write and does not regress.
  - NOT NULL interaction: an ADD COLUMN NOT NULL whose per-row backfill yields NULL for some row must
    still be rejected (mirror `validateNotNullBackfill` / the CHECK-backfill revert path). The
    existing CHECK-backfill validation (`validateBackfillAgainstChecks`) must still see the
    backfilled values.
- **Streaming / transaction safety**: the backfill happens inside the ALTER's transaction; on failure
  (NOT NULL / CHECK / evaluation error) revert the column add (the existing revert path drops the
  column and restores the catalog entry — extend it to cover the new backfill failure modes).

## Tests

- **ADD COLUMN backfill** (`test/logic/03.4-defaults.sqllogic` or a sibling): `alter table t add column
  c integer default (new.base * 2)` over a table with pre-existing rows — existing rows backfill from
  their own `base`; a subsequent insert supplying `base` derives `c`; a subsequent insert omitting
  `base` raises the resolution error (parity with the single-source path). Pre-existing literal-fold
  ADD COLUMN cases keep passing.
- **ADD COLUMN NOT NULL** whose per-row backfill would yield NULL → rejected, table unchanged.
- **Existing rejections preserved** (`90.2.1-alter-extra-errors.sqllogic`): bind-param and bare-column
  ADD COLUMN defaults still rejected.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log` and
  `yarn workspace @quereus/quereus lint`. If touching the store path, also sanity-check `yarn test:store`
  for ALTER (per AGENTS.md, store-mode exercises the ALTER code path).

## TODO

- Replace the literal-fold rejection in `runAddColumn` with: validate via the shared DDL validator
  (allow `new.`/defer; reject bind/bare/non-det), then store the default on the column schema.
- Implement per-row backfill (engine-generic preferred), reusing `buildRowDefaultScope` with the
  existing table columns as the row, keeping the literal fast-path.
- Extend NOT NULL / CHECK backfill validation + revert to the per-row default case.
- Update `docs/runtime.md` (the note now says ADD COLUMN still folds to a literal — flip it once this
  lands) and `docs/sql.md` § Default Values (ADD COLUMN `new.<col>` = existing-row backfill semantics).
