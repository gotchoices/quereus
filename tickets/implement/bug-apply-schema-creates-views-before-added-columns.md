description: A schema declaration that adds a column to a table and also adds a view reading that column can never be applied, because the migration creates the view before the column exists. Views should be created after the table changes, except where a new column needs the view.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan (pushCreates viewsToCreate), pushTableAlters, columnReconciledViewStmt, inverseRenamedViewParts, the view comment block in computeSchemaDiff
  - packages/quereus/src/schema/dependency-order.ts   # orderDependenciesFirst
  - packages/quereus/test/apply-schema-alter-order.spec.ts   # new cases; the existing DEFAULT-reads-a-new-view case must keep passing
  - packages/quereus/test/schema-differ.spec.ts   # plan-order and recreate-text expectations
  - packages/quereus/test/schema/differ-undo-plan.spec.ts   # plan-order expectations (view create at line ~699)
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic   # recreate text expectations, if any name the old column
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # section 10 is the store-backend coverage for alter ordering
  - docs/schema-declarative.md   # Migration Order
  - docs/schema-rename-detection.md   # line ~84 states the old order and names columnReconciledViewStmt
  - docs/sql-ddl.md   # Order Independence
repro: verified
----

# Apply schema creates views before the columns they read

## The failure

Over an applied `table t { id integer primary key, b integer null }`:

```sql
declare schema main {
	table t { id integer primary key, b integer null, d integer null }
	view v as select d from t
}
apply schema main;
```

```
Failed to execute DDL: create view v as select d from t
Error: Column not found: d
```

The catalog is restored, so nothing is damaged. The declaration describes a reachable end state, and the plan cannot reach it in one apply.

`generateMigrationPlan` pushes `diff.viewsToCreate` ahead of `pushTableAlters`, and `CREATE VIEW` plans its body when it runs. The one code site that has to change is that push.

## What was run

Each declared case below was applied on the memory module with the engine in `packages/quereus/dist`. That build has the staged table alters but predates the last review commit, whose source edits the review describes as no behaviour change. In the last column, "by hand" means the statements were run one at a time in the proposed order; "re-diff empty" means the declaration was then re-declared and `diff schema` returned nothing. "Expected" means reasoned from the order and not run.

The proposed sort itself has not been prototyped, only these hand-run statement orders.

| Case | Today | In the proposed order |
|---|---|---|
| Added column, view reads it | fails: `Column not found: d` | by hand: works, re-diff empty |
| Same, through a hinted table rename | fails the same way | expected to work; not run |
| New view names a column renamed in the same apply | fails: `Column not found: b2` | expected to work; not run |
| Edited existing view names a column renamed in the same apply | fails: `Column not found: b2` | by hand: works, re-diff empty |
| Hinted view rename plus column rename | works, through `columnReconciledViewStmt` | by hand with the declared text: works, re-diff empty |
| New view reads a new view written after it | fails: `Table 'c' not found` | expected to work with the view-to-view order below; not run |
| New `v2` reads an existing `v1` (`select * from t`), and `t` gains the column `v2` names | fails: `Column not found: d` | by hand: works, re-diff empty |
| `u.z default ((select m from w))`, `w` reads the column `t` gains | fails: `Column not found: d` | by hand (`t` add, `w`, `u` add): works, re-diff empty |
| `t.z default ((select m from w))`, `w` reads `t.b`, which already exists | works | must keep working: this is today's order, `w` first |
| `t` gains `d` and `z default ((select m from w))`, `w` reads `t.d` | fails | by hand, it works only if the added columns are split around the view (`d`, `w`, `z`); the stated rule does not do that |
| Named CHECK reads a new view | works | expected to keep working: stage 3 follows every view; not run |
| New `select *` view beside a `DROP COLUMN`; new view beside a retype | works | expected to keep working; not run. The retype now runs before the view instead of after it |

Three facts that moving the view relies on, each run by hand:

- `alter table u alter column y set default ((select m from w))` succeeds while `w` does not exist yet, and so does a following `set data type`. So existing-column DEFAULT changes need no ordering edge to a view, as `recordCrossTableReads` already says.
- `set not null` over a NULL row with a subquery default fails with `column y contains NULL values` whether or not the view exists yet, so that failure does not depend on this order.
- Tables and views share one namespace (`create view` refuses a name a table holds, and `docs/sql-ddl.md` says so), so the alter keys and view keys can live in one sort without colliding.

## The fix

Create views inside stage 2 of `pushTableAlters`, sorted together with the per-table alter groups. Stage 1 (`RENAME COLUMN`) still runs first, so every view sees post-rename names.

The rule to state in the docs: **a view is created after every table's stage 2 steps, unless a table's added column reads it, directly or through other new views. Then it goes ahead of that table.**

As a sort, over one list of the alter groups followed by the view creates:

```
required edges
  alter → each name in addedColumnReads (now also resolves to a new view)
  view  → each new view its body names

preferred edges
  view  → every altered table, skipped when adding it would close a cycle
```

Worked orders, all from the table above:

- Added column, view reads it: `t`, `v`.
- `u.z` reads `w`, `w` reads the new `t.d`, written `u, t, w`: `u` waits on `w`, so `w → u` is skipped; `w → t` holds; the result is `t`, `w`, `u`.
- `t.z` reads `w`, `w` reads the existing `t.b`: `w → t` is skipped; the result is `w`, `t`. This is what keeps the case pinned by `applies a DEFAULT reading a view the same plan creates` and its same-table form working.
- `v2` reads an existing view over `t`: `v2 → t` holds without looking at `v1`, so the plan needs no catalog.

Why preferred edges to every altered table and not only to the tables a view names: naming alone misses a view reached through an existing view (the `v1`/`v2` row), and following it would need the catalog, which `diff schema` planning does not have. Why not a plain "views after alters" list: that fails the `u.z` and `t.z` rows, where an added column's DEFAULT reads a view the same plan creates.

Implementation notes:

- Confirm that `addedColumnReads` includes view names. From reading `collectExpressionReads` it should, since it keeps every name the walk finds in the schema, but today nothing consumes a view name from it, so no test shows it.

- `orderDependenciesFirst` drops every required edge inside a cycle. Add the preferred edges afterwards, one at a time, each only if its target does not already reach its source in the graph so far. Checking each one only against the required edges is not enough: `v1 → t`, `t → v2`, `v2 → s`, `s → v1` would each pass and together form a cycle, and the sort's `findIndex` would then return -1. Add this as an optional fourth parameter, leaving the existing call sites unchanged.
- Read a view's names at plan time from the create's AST with `collectTableRefsInAst` and `singleSchemaObjectRefResolver`, under `schemaName ?? 'main'`. No new field is needed on `SchemaDiff`. Test diffs are hand-built, so guard on the statement type being a create view.
- A view step still pushes through the same create path, so its undo stays `DROP VIEW IF EXISTS`. `dropCreated` reads only the name. The unwind now takes the view back before the column operations it reads, which is the order it needs.
- `computeSchemaDiff` keeps the view rename reconciliation for comparison (`reconciledDeclaredViewDefinition`, `declaredViewMatchesModuloRenameArtifacts`). Only the recreate text changes.
- Delete `columnReconciledViewStmt`: the recreate now runs after `RENAME COLUMN`, so the declared statement is correct as written, the same way `columnReconciledIndexStmt` went for indexes. Update the comments that describe the old order at `computeSchemaDiff`'s view block, `resolveDeclaredColumn`, `inverseRenamedViewParts`, and `generateMigrationPlan`.

## Limits that remain

Add these to the Known limits list in Migration Order:

- A table that gains a column and also gains a DEFAULT, CHECK or generated column reading a new view over that new column. Stage 2 keeps one table's steps together, so the view fails on the column. Splitting the added columns would change the order columns are declared in. Add the first column in an earlier apply.
- The existing limit "References through a view" stays for a DEFAULT reading an existing view. This ticket does not touch it.

New materialized views have the same failure from a different site. They are filed separately as `bug-apply-schema-creates-materialized-views-before-sources`, so the `Residual hazard` sentence in `docs/schema-rename-detection.md` should keep its materialized-view half.

## TODO

- Add the optional preferred-dependency parameter to `orderDependenciesFirst`, with one test in the `dependency ordering` block of `apply-schema-alter-order.spec.ts`: a preferred edge orders items, and one that would close a cycle, including across other preferred edges, is skipped.
- Move the view creates into stage 2 of `pushTableAlters`, using the sort above.
- Delete `columnReconciledViewStmt`, simplify `inverseRenamedViewParts` if that leaves a parameter or branch unused, and update the comments listed above.
- Add cases to `apply-schema-alter-order.spec.ts`: the repro above, an edited view naming a renamed column, a new view written before the new view it reads, a new view over an existing `select *` view, and `u.z` through `w` to a new `t.d` in both written orders. Add the same-table `t.z` through `w` over the existing `t.b` next to the existing pinned case. Add one forced failure after a view create that checks the catalog is restored.
- Add a case to section 10 of `50.4-declare-schema-apply-restore.sqllogic`, so the move also runs on the store backend.
- Update expectations that pin the old order or the old-column recreate text in `schema-differ.spec.ts`, `differ-undo-plan.spec.ts` and the `50.x` logic files. Change an expectation only when the new order is the one the rule above predicts.
- Update docs: Migration Order items 3 and 4 and the Known limits in `docs/schema-declarative.md`; line ~84 of `docs/schema-rename-detection.md` (views no longer have the hazard, and the helper is gone); a line under Order Independence in `docs/sql-ddl.md` if the view case reads as missing.
- Run `yarn workspace @quereus/quereus run test`, `yarn test:store` and `yarn workspace @quereus/quereus run lint`.
