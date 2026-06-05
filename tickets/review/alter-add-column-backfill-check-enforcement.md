description: Review of per-row CHECK enforcement for ADD COLUMN with a non-foldable (per-row) DEFAULT. The plan-build guard rejecting DEFAULT(new.<col>)+CHECK was removed and replaced with per-row CHECK evaluation inside the backfill hook (mirrors the working NOT NULL per-row path). A violating backfilled row now aborts the ALTER and leaves the table unchanged on both memory and store modules.
files: packages/quereus/src/planner/building/alter-table.ts, packages/quereus/src/planner/nodes/alter-table-node.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic
----

## What was implemented

Goal: `ALTER TABLE … ADD COLUMN … DEFAULT (<non-foldable>) CHECK (<predicate over new col>)`
now enforces the new column's CHECK against every backfilled existing row. A violating
row aborts the ALTER and leaves the table unchanged (no column added, catalog restored).
The interim `StatusCode.UNSUPPORTED` plan-build guard was removed.

The literal-default + CHECK path (post-backfill scan `validateBackfillAgainstChecks`,
regression `90.2.1 §3`) is unchanged and still validates/reverts.

### Mechanism (Approach 1 from the fix triage)

CHECK enforcement reuses the per-row backfill hook the NOT NULL evaluator path already
uses. Because both modules accumulate into a *local* structure and only commit after the
loop (memory `base.ts recreatePrimaryTreeWithNewColumn` swaps `this.primaryTree = newTree`
after the loop; store `store-table.ts migrateRows` calls `batch.write()` after the loop),
a throw mid-loop discards the in-progress work and propagates out of `module.alterTable`
**before** `runAddColumn` reaches `schema.addTable(enhancedTableSchema)` — so the catalog
is never mutated. Zero extra rollback code. No module code was changed.

### Changes by file

- `planner/nodes/alter-table-node.ts`: added/exported `AddColumnCheck` interface
  (`predicates: [{node, name?, exprText}]` + `rowDescriptor` over existing cols + new col);
  extended the `addColumn` action variant with optional `checks`.
- `planner/building/alter-table.ts`: removed the UNSUPPORTED guard. New helper
  `buildAddColumnChecks` compiles each column-level CHECK predicate against a
  `buildRowDefaultScope` covering existing columns + the new column (so bare `<col>`,
  `new.<col>`, and existing-sibling refs all resolve). The new column's logical
  type/nullability come from `inferType(columnDef.dataType)` + the column's notNull
  constraint. Checks are compiled **only when a backfill is present** (evaluator path).
- `runtime/emit/alter-table.ts`:
  - `emitAlterTable` emits check predicate sub-programs as params after the backfill param
    (fixed slot order: backfill first when present, then checks). `run` slices `args`
    accordingly and threads `checks` + check callbacks into `runAddColumn`.
  - `runAddColumn` installs a second row slot over `checks.rowDescriptor`, wraps the
    backfill evaluator to set that slot to `[...row, value]`, evaluates each check, and
    throws `StatusCode.CONSTRAINT` (`CHECK constraint failed: <name> (<exprText>)`) on
    `result === false || result === 0` (NULL / other truthy pass — matches write-time
    `constraint-check.ts` semantics). Both slots close in the same `finally`.
  - Post-scan `validateBackfillAgainstChecks` is now gated on `!backfill` (per-row path
    already enforced it; the post-scan reads a stale pre-backfill snapshot for the
    evaluator path — that was the original bug). Literal-default path still runs the scan.
  - Added a one-line follow-up comment: the same per-row hook could later validate
    column-level FKs against backfilled rows (still out of scope; FKs merge for future
    INSERT/UPDATE only).

## How to validate / use cases

Memory + store (the store cases run because `03.4-defaults.sqllogic` is re-run by
`yarn test:store`). New/updated cases in `03.4-defaults.sqllogic` (replacing the old
`ac_chk` rejection block):

- **Passing CHECK** (`ac_chk_ok`): `base` all positive, `default (new.base * 2) check (c > 0)`
  → column added, derived values correct.
- **CHECK over new + existing col** (`ac_chk_ref`): `check (c > base)` resolves both
  → column added.
- **One row violates** (`ac_chk_bad`): a negative `base` → `-- error:`, then `select *`
  shows the table unchanged (no `c` column).
- **All rows violate** (`ac_chk_all`): `check (c > 1000000)` → `-- error:`, table unchanged
  (covers the original silent-admission scenario).

`90.2.1-alter-extra-errors.sqllogic §3` (literal default + CHECK) intentionally unchanged.

### Commands run (all green except one pre-existing, unrelated failure)

- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0
- Memory logic suite (full, no-bail): **219 passing, 1 failing** — the single failure is
  `41.7.1-alter-column-collate-unique.sqllogic:46` (SET COLLATE path), confirmed
  pre-existing on clean HEAD and documented in `tickets/.pre-existing-error.md`. Unrelated
  to this ticket (touches no SET COLLATE / UNIQUE / memory re-key code).
- `node test-runner.mjs --grep "03.4"` (memory) → pass; `--store --grep "03.4"` → pass
  (exercises `migrateRows` + `store-module.alterTable` rollback path).
- `node test-runner.mjs --grep "90.2.1"` (memory) → pass.

## Reviewer focus / known gaps & risks

- **Truthiness parity**: the new throw uses `result === false || result === 0` to match
  `constraint-check.ts:checkCheckConstraints`. Confirm there's no edge (e.g. CHECK returning
  a BLOB/bigint 0, or a string `'0'`) where write-time and backfill-time semantics could
  diverge. The write path uses the same literal comparison, so they should match, but a
  deliberate parity test (insert a row that fails the same CHECK and compare error
  behavior) is not present — consider adding one.
- **Slot ordering / arg bookkeeping**: `params` is `[backfill?, ...checks]` and `run`
  slices `args.slice(backfill ? 1 : 0)`. Checks are only ever compiled when `backfill`
  exists, so the `backfill ? 1 : 0` branch's `0` case is currently dead for checks — fine,
  but verify no future path emits checks without a backfill.
- **Multiple CHECKs on one ADD COLUMN**: the code handles N predicates (loop), but the
  tests only exercise 1 CHECK per ADD COLUMN. A two-CHECK case (one passing, one failing)
  would harden coverage.
- **Named CHECK error message**: when the CHECK is named, the message uses `pred.name`;
  unnamed falls back to `_check_<col>`. Tests only assert `-- error:` (text-agnostic), so
  the exact message shape is unverified by tests.
- **Empty table**: with zero existing rows the backfill loop never runs, so no CHECK is
  evaluated at ALTER time (correct — nothing to validate); future inserts enforce via the
  merged table-level CHECK. Not separately tested here (the analogous NOT NULL empty-table
  case `ac_empty` exists).
- **FK backfill validation** remains unimplemented for all default kinds (documented
  follow-up in `runAddColumn`).
- Pre-existing unused-param warning (`schema` in `rebuildViaShadowTable`) is untouched and
  pre-dates this work.
