description: A schema declaration that adds a column to a table and also adds a view reading that column could never be applied, because the migration created the view before the column existed. Views now run after the table changes, except where a new column needs the view.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # pushTableAlters, viewStageTwoItems, alterStageTwoItem, objectsNamedIn, followDeclaredViewsInAddedColumnReads; columnReconciledViewStmt deleted
  - packages/quereus/src/schema/dependency-order.ts   # orderDependenciesFirst gained preferredTiers
  - packages/quereus/test/apply-schema-alter-order.spec.ts
  - packages/quereus/test/schema-differ.spec.ts
  - packages/quereus/test/schema/differ-undo-plan.spec.ts
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic
  - docs/schema-declarative.md
  - docs/schema-rename-detection.md
  - docs/sql-ddl.md
repro: verified
----

# Apply schema creates views after the columns they read

## What shipped

`CREATE VIEW` moved out of the create block and into stage 2 of `pushTableAlters`, sorted together with the per-table alter groups. Stage 1 (`RENAME COLUMN`) still runs first, so a view recreate executes the declared statement as written, and `columnReconciledViewStmt` is gone. The rename reconciliation in `computeSchemaDiff` stays, for comparison only.

The rule, as documented in Migration Order: a view is created after every table's stage 2 steps, unless a table's added column reads it, directly or through other declared views. Then it goes ahead of that table.

The sort has these kinds of edge:

- Required: an alter group follows each name in `addedColumnReads`, which holds tables and views the added columns name, plus the views those views reach. A view follows each new view its body names.
- Preferred, first tier: a view follows the tables its body names.
- Preferred, second tier: a view follows every altered table.

`orderDependenciesFirst` adds preferred edges one at a time, strongest tier first, and skips any that would close a cycle.

Two behaviours differ from the older engine, both accepted in review. A bad view beside a retype now reports the schema as partially migrated, because the retype runs first and cannot be undone. A hinted view rename whose declared text still names the old column now fails on the first apply with the catalog restored, where before it succeeded and failed on the second apply. Both are documented.

## Validation

- `yarn workspace @quereus/quereus run test`: 10935 passing, 25 pending, no failures.
- `yarn workspace @quereus/quereus run test:store`: 10928 passing, 32 pending, no failures.
- `yarn workspace @quereus/quereus run lint`: exit 0.

All three ran after the review's last code edit.

## Known gaps

- One table gaining both a column and a reader of a new view over that column stays a documented limit, not pinned by a test.
- New materialized views still have this failure from a different site: `bug-apply-schema-creates-materialized-views-before-sources`.
- A DEFAULT reading an existing view over `t` gets no ordering edge to `t`, and stays under the "References through a view" limit.

## Review findings

Scenarios below were run through `diff schema` and `apply schema` against the current source and against the older engine in `packages/quereus/dist`, in a throwaway script outside the repository.

### Found and fixed in this pass

- **Regression: a new column reading an existing view over a recreated view.** With `v1` over `v2`, `v2` edited, and `u` gaining `z default ((select max(b) from v1))`, the older engine applied this and the implement commit failed with `Table 'v2' not found`. The same held for a generated column. `v2` now ran after `u`, because `u` names only `v1`. Fixed by `followDeclaredViewsInAddedColumnReads`, which extends `addedColumnReads` through declared view bodies. It works from the declaration, so `diff schema` needs no catalog. It adds views only, because a required edge to a table could close a cycle with a direct edge and lose both. Test added.
- **The plan depended on the order views were written in.** With `t.z` reading `r2`, `u.w` reading `r1`, and `r2` reading a column `u` gains, a valid order exists, but one written order failed with `Column not found: d`. `r1`'s unneeded preference for `t` was added first and blocked `r2` from following `u`. Fixed with preference tiers: tables a view's body names come before the rest. Test added, in both written orders.
- **Stale comment** on `viewCreate` said the statement was already rename-reconciled. Corrected.
- **Docs.** Migration Order updated for both fixes. `docs/schema-rename-detection.md` now states the hinted-rename failure the implementer flagged as undocumented; I ran it and confirmed the error and that the old view is restored and readable.
- **Test cut.** `a failure after a view create takes the view back before the column it reads` duplicated `50.4` section 10, which checks the same failure and also runs on the store backend.

### Tripwires recorded

- A table a view reaches only through an existing view sits in the weaker preference tier, and can still lose to another view's preference. `NOTE:` at `viewStageTwoItems`.
- A reached table gets no edge from an added column through a view. `NOTE:` at `recordCrossTableReads`, updated, with the reason.
- `NOTE:` from implement at `addEdgesThatCloseNoCycle`, one graph walk per candidate edge, kept. Not measured. From reading the code, a walk starting at a table follows only that table's reads, which are few in the plans I looked at.

### Checked, no change needed

- **Behaviour differences the implementer asked about.** A bad view beside a retype follows from the order the ticket specified, and is documented. The hinted-rename failure is an improvement: same error, one apply sooner, catalog restored.
- **Other statements that run while a recreated view is missing.** `RENAME COLUMN` and a retype with a dependent view over the recreated view, an assertion over it beside `ADD COLUMN`: all apply on both engines. `SET NOT NULL` backfill, a retype beside a DEFAULT, CHECK or assertion that reaches the view: the drop guard refuses `DROP VIEW` with the same error on both engines, so this change does not affect them.
- **Name handling.** Mixed-case view and table names, a CTE sharing a new view's name, and a `with defaults` subquery reading a later view all order correctly.
- **Undo and restore.** The create goes through the same undo path through `pushCreate`, and `50.4` section 10 covers restoring in order. No new test.
- **Dead code.** `inverseRenamedViewParts` still has callers for comparison, and its comment was updated by implement.
- **Tests.** The rest of the implementer's tests pin distinct behaviour. The changed expectations in `50.2`, `differ-undo-plan.spec.ts` and `schema-differ.spec.ts` match the new order.

### Left as is

- `viewStageTwoItems` uses `create.sql` as a key when `create.ast` is not a `createView`. `MigrationCreate.ast` is typed as any statement, and no code path produces another kind in this bucket. Narrowing the type would touch the test fixtures for no behaviour change.

### Tickets filed

None. Both defects were fixed here, and the rest are recorded as tripwires or existing limits.
