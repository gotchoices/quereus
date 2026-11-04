description: A schema declaration that adds a column to a table and also adds a view reading that column could never be applied, because the migration created the view before the column existed. Views now run after the table changes, except where a new column needs the view.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # pushTableAlters, viewStageTwoItems, alterStageTwoItem, objectsNamedIn; columnReconciledViewStmt deleted
  - packages/quereus/src/schema/dependency-order.ts   # orderDependenciesFirst gained preferredDependenciesOf
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

## What changed

`CREATE VIEW` moved out of the create block and into stage 2 of `pushTableAlters`, sorted together with the per-table alter groups. Stage 1 (`RENAME COLUMN`) still runs first, so a view recreate now executes the declared statement as written, and `columnReconciledViewStmt` is gone. The rename reconciliation in `computeSchemaDiff` stays, for comparison only.

The rule, as documented in Migration Order: a view is created after every table's stage 2 steps, unless a table's added column reads it, directly or through other new views. Then it goes ahead of that table.

The sort has two kinds of edge:

- Required: an alter group follows each name in `addedColumnReads`, which holds view names as well as table names. A view follows each new view its body names.
- Preferred: a view follows every altered table, skipped when adding the edge would close a cycle. `orderDependenciesFirst` adds these one at a time, each checked against the graph so far.

A view's required edges must stay limited to new views. My first version used every name in the body, so `t.z` reading `w` over the existing `t.b` became a required cycle and lost its ordering. The same-table test in `apply-schema-alter-order.spec.ts` caught it.

## Behaviour to validate

Each of these was run against the source, with the plan printed. The first group is pinned by tests; the second was run once in a throwaway spec and has no test.

| Case | Result | Where |
|---|---|---|
| Added column, view reads it | applies, re-diff empty | spec |
| Edited view names a renamed column | applies, re-diff empty | spec |
| Hinted view rename plus column rename | applies, re-diff empty | 50.2 § 19 and § 23 |
| View written before the new view it reads | applies, re-diff empty | spec |
| New view over an existing `select *` view, `t` gains the column | applies, re-diff empty | spec |
| `u.z` through `w` to a new `t.d`, both written orders | applies, re-diff empty | spec |
| `t.z` through `w` over the existing `t.b` | plan is `w`, `t` | spec |
| Hinted table rename with added column and view | applies, re-diff empty | run once |
| New view names a renamed column | applies, re-diff empty | run once |
| Named CHECK reads a new view | applies, re-diff empty | run once |
| New `select *` view beside a `DROP COLUMN` | applies, re-diff empty | run once |
| New view beside a retype | applies, re-diff empty | run once |
| `t` gains `d` and `z default ((select m from w))`, `w` reads `t.d` | fails with `Column not found: d`, the documented limit | run once |

## Behaviour that got different, not just fixed

Both were compared against the older engine in `packages/quereus/dist`. The reviewer should decide whether either needs more than what is here.

- **A bad view beside a retype no longer restores.** The retype now runs first and cannot be undone, so a `CREATE VIEW` that fails after it reports the schema as partially migrated. Before, the view failed first and the catalog was restored. This follows directly from the order the ticket specified. I added a sentence to the Known limits follow-up paragraph in Migration Order and no test.
- **A hinted view rename whose declared text still names the old column now fails on the first apply**, with `Column not found` and the catalog restored. Before, the first apply succeeded through rename propagation, the re-diff was not empty, and the second apply failed with the same error. No doc mentions this and no test pins it.

## Tests

Added:

- `apply-schema-alter-order.spec.ts`, new block `a new view reading what the plan changes`:
  - a view reading a column its table gains (the ticket's repro)
  - an edited view naming a column renamed in the same apply
  - a view written before the new view it reads
  - a view reading a new column through an existing view, which is why the preferred edge covers every altered table
  - a DEFAULT reading a view over a column another table gains, in both written orders
- `apply-schema-alter-order.spec.ts`, next to the existing pinned case: a DEFAULT reading a new view over a column its own table already has, which needs the view ahead of its own source table.
- `apply-schema-alter-order.spec.ts`: `a failure after a view create takes the view back before the column it reads`, which checks the catalog is restored.
- `apply-schema-alter-order.spec.ts`, `dependency ordering` block: a preferred dependency orders items and is skipped when it would close a cycle, and is also skipped when the cycle runs through other preferred edges.
- `50.4-declare-schema-apply-restore.sqllogic` section 10: the same failure and retry through SQL, so it also runs on the store backend.

Changed expectations, each matching the rule above:

- `50.2` § 19 and § 23: the recreate now follows `RENAME COLUMN` and names the new column.
- `differ-undo-plan.spec.ts`: the view create moves to after `ALTER PRIMARY KEY` in both broad plan lists.
- `schema-differ.spec.ts`: the hinted-rename recreate test now pins the declared text and that the create follows `RENAME COLUMN`.

Deleted: `a hinted view rename renders its recreate DDL with the non-FROM clause-expr ref inverse-renamed` in `schema-differ.spec.ts`. It pinned the behaviour of the deleted helper, and the remaining hinted-rename test covers what is left.

## Validation run

- `yarn workspace @quereus/quereus run test`: 10933 passing, 25 pending, no failures.
- `yarn test:store`: 10926 passing, 32 pending, no failures. This ran before the last edits, which changed only comments and docs.
- `yarn workspace @quereus/quereus run lint`: clean.

## Known gaps

- The limit where one table gains both a column and a reader of a new view over that column remains, and is listed in Known limits. It is not pinned by a test, matching how the existing limits are handled.
- New materialized views still have this failure from a different site. That is `bug-apply-schema-creates-materialized-views-before-sources`, and the Residual hazard sentence in `docs/schema-rename-detection.md` keeps its materialized-view half.
- A DEFAULT reading an existing view stays under the existing "References through a view" limit.
- `NOTE:` added at `addEdgesThatCloseNoCycle` for the one graph walk per candidate edge. I did not measure its cost.
