description: Whether a schema could be applied used to depend on the order its tables were written in, because the migration finished all of one table's changes before starting the next table's. The migration now runs table changes in stages across all tables, so a table's change no longer runs ahead of a change on another table that it needs.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # pushTableAlters (the five stages) and its push* helpers; recordCrossTableReads; TableAlterDiff.addedColumnReads / droppedColumnReads
  - packages/quereus/src/schema/dependency-order.ts   # new: orderDependenciesFirst / orderDependentsFirst
  - packages/quereus/src/schema/catalog.ts   # new optional column field generatedExpr
  - packages/quereus/src/schema/catalog-rendering.ts   # generatedExpr deliberately not rendered
  - packages/quereus/test/apply-schema-alter-order.spec.ts   # new
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # new section 10, runs on both backends
  - docs/schema-declarative.md   # Migration Order: stages and known limits
  - docs/sql-ddl.md   # Order Independence
----

# Apply schema alters tables in stages, not one table at a time

## What shipped

`generateMigrationPlan` used to emit every phase of one table before the next. `pushTableAlters` now emits five stages across all altered tables:

```
1. RENAME COLUMN, all tables
2. Per table, after the tables its new columns refer to:
     ADD COLUMN → ALTER COLUMN → RENAME CONSTRAINT → DROP CONSTRAINT → ALTER PRIMARY KEY
3. ADD CONSTRAINT, all tables, declaration order
4. DROP COLUMN, all tables, a table before the tables its dropped columns' expressions read
5. SET TAGS, all tables, declaration order
```

A table's own steps keep their old relative order, so a one-table plan is unchanged. `diff schema` and `apply schema` share one plan, and no undo arm changed.

Departures from the fix ticket, all kept after review:

- `SET DEFAULT` makes no ordering edge, because it does not validate its expression and a `SET NOT NULL` backfill folds it to a literal.
- Generated columns count on the drop side, which needed `generatedExpr` on `CatalogTable.columns`.
- `orderDropsByFKDependency` stays separate, because moving it onto the shared sort would change the `DROP TABLE` order `diff schema` shows.
- A refused `DROP COLUMN` reports a partial migration rather than a restore, and the docs say so.

Known limits are listed in docs/schema-declarative.md § Migration Order: inline foreign keys forming a cycle, a cycle that exists only between tables, references through a view, and dropped columns whose defaults read each other.

## Review findings

Reviewed from `ticket(implement): bug-apply-schema-alters-tables-in-declaration-order`, with the diff read before the handoff.

**Behaviour checked by running it.** I ran 35 scenarios against the built engine, each with the tables written in both orders, on the memory module, plus two hand-run statements. Each one checked the outcome, an empty re-diff on success, and the catalog restored on failure. All matched the docs. They covered:

- Forward references: inline CHECK, inline foreign key on an existing column, named inline foreign key, mixed-case names, a table rename, a new table's foreign key to an added column, and backfill with rows present.
- Removals: inline and named-inline CHECK on a dropped column, removing a foreign key or default while keeping the column, and three-table chains in both directions.
- Other changes beside a foreign key: a parent key change and a parent retype.
- Undo: a forced failure after dropping a foreign key, CHECK or default that names a column the same plan renames, in both orders. Undo spelling across stages held in every case, with the catalog restored.
- The documented limits: the view limit (add and drop) and both cycle cases.

**Handoff items settled.**

- The named-foreign-key workaround was listed as not run. I ran it for both cycle cases, naming either key, and it applies in both orders.
- I weighed the between-tables cycle the handoff flagged, and it is a real defect reachable now. Filed as `bug-apply-schema-one-way-table-cycle-depends-on-written-order` rather than fixed here. The fix the code's `NOTE:` suggested would have regressed a working case: `add column z text default 'ABC' references t(d)` fails until `t`'s `SET COLLATE` has run (statement run by hand), and today's edge runs it first. I corrected the `NOTE:` and recorded this in the ticket.
- The view-create contract had no test. Added `applies a DEFAULT reading a view the same plan creates`, and noted the constraint on `bug-apply-schema-creates-views-before-added-columns`, which will now land second.

**Minor, fixed in this pass.**

- `computeTableAlterDiff` computed the added-column list twice by filter and once more by loop. It now computes it once, as `addedColumnDefs`.
- The `orderDependenciesFirst` doc claimed it moves items "as little as that allows", which nothing proves. Removed.
- The spec header claimed order independence with no mention of the limits, and narrated the old behaviour. Reworded.
- Cut the test `reverses the edges on request`: the drop-direction tests run `orderDependentsFirst` through real plans. I did not re-run the implementer's mutation table after this cut or the added test.
- Pointed `apply-schema-creates-referenced-tables-first` at the shared sort. It and the view ticket also cite `docs/schema.md` for Migration Order, so both now note the section lives in `docs/schema-declarative.md`.
- Refreshed the measured count in `debt-oversized-source-files`: `schema-differ.ts` is 3,991 lines (`wc -l`, was 3,872). The implement commit's helpers add to an already-tracked file, so no new ticket.

**Major.** One ticket, `bug-apply-schema-one-way-table-cycle-depends-on-written-order`, in `backlog/`, covering the between-tables cycle above. No type or generalized-test rung fits better: it is one ordering rule, and the edge data at one site is what has to change.

**Tripwires.** The existing `NOTE:`s at `recordCrossTableReads` (view reach, per-table edges) and `orderDependenciesFirst` (rescan cost) stand. No new ones.

**Other angles, nothing found.**

- Resource cleanup: this is plan generation with nothing to release.
- Error handling: errors pass through unchanged, and `orderDependenciesFirst` cannot fail to place an item because cycle edges are removed first.
- Type safety: the new diff fields are optional because tests hand-build partial diffs, and no consumer needs them set.
- Performance: not measured. The sort only does work when a plan has an edge.
- Docs: the Migration Order stages and limits match what I ran. I searched `docs/` for other statements of the alter order and read the matches in `docs/sql-ddl.md`, `docs/sql-alter.md`, `docs/schema-rename-detection.md` and `docs/schema-undo-plan.md`; none contradicts the new order. I did not read those files in full.
- Not exercised: a schema-qualified reference to another schema (read only, since `create schema` is not available to probe it), and my scenarios on the store module. Store coverage comes from section 10 of `50.4`.

**Validation, after the edits above.**

- `yarn workspace @quereus/quereus run test`: 10924 passing, 25 pending.
- `yarn test:store`: 10917 passing, 32 pending.
- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn docs:check`: one failure, `docs/module-authoring.md` at 12360 words against the 12000-word cap. This work did not touch that file, so it is reported in `tickets/.pre-existing-error.md`.
- Not re-run: `yarn build` and the other workspaces' tests. The edits since the implementer's full run are limited to `packages/quereus` (a refactor with no behaviour change, comments, and the spec).
