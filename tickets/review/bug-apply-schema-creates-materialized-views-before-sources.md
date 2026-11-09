description: A schema declaration that adds a new materialized view reading a column added or renamed in the same apply, a new plain view, or another new materialized view written after it, could never be applied, because the migration created the materialized view too early. The migration now creates new materialized views where plain view creates already run; review that move.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan (create block split), orderTableCreates, createStageTwoItems (was viewStageTwoItems), plannedBodyOf, freshTableCreate, bodyReach, viewCreate, MigrationCreate.viewReach, computeSchemaDiff (declaredViewBodies moved above the table loop)
  - packages/quereus/src/schema/dependency-order.ts   # NOTE wording only
  - packages/quereus/test/apply-schema-alter-order.spec.ts   # new cases at the end of `a new view reading what the plan changes`
  - packages/quereus/test/schema-differ.spec.ts   # two obsolete create-order tests removed
  - packages/quereus/test/schema/differ-undo-plan.spec.ts   # pinned BROAD_DDL lists: the materialized view create moved
  - docs/schema-declarative.md   # Migration Order items 3, 4, 4.2, Known limits, retype sentence
  - docs/schema-rename-detection.md   # lines 15 and 84
  - docs/materialized-views.md   # Apply ordering bullet
----

# Review: new maintained creates run in stage 2 of the table alters

## What changed

A new maintained table (`create materialized view …`, `create table … maintained as …`, and the recreate of a backing-module move) used to be pushed in the create block with the plain table creates, before every `RENAME COLUMN`, `ADD COLUMN` and view create. Its body is planned when it runs, so it could not see anything those later steps produce. Inside the create block it followed only the creates written before it.

Now `generateMigrationPlan` splits `diff.tablesToCreate`:

- Plain table creates still go through `orderTableCreates` in the create block. `orderTableCreates` lost `createsAheadOfMaintained` and the `plainTables` filter; it now orders by foreign key parents only. A parent not in its input (a table in the catalog, or a new maintained table) gives no edge, because `orderDependenciesFirst` already ignores keys no item has.
- Maintained creates go to `pushTableAlters` beside `diff.viewsToCreate` (views first, then maintained creates, as input order). `createStageTwoItems` (renamed from `viewStageTwoItems`) builds one stage-2 item per create of either kind:
  - `key`: the created name, lowercased, via `createdObjectTarget`.
  - `runsAfter`: `viewReach` (or the body's names) filtered to every stage-2 create key, so a plain view now must follow the new maintained table it reads, and a maintained create must follow the new views and maintained tables it reads.
  - `prefersToRunAfter`: the body's other names. `alsoPrefersToRunAfter`: every altered table.
  - push kind: `'view'` for `createView`, `'table'` otherwise, so the undo stays `DROP TABLE IF EXISTS`.
- `plannedBodyOf` returns the body a create plans: `select` for a view or materialized view, `maintained.select` for a `createTable`.
- `freshTableCreate` now gives a maintained create a `viewReach` (`bodyReach`), so `declaredViewBodies` is built before the table loop in `computeSchemaDiff`.

`diff.tablesToCreate` itself keeps its order; only the plan's emission changes.

## Decisions the reviewer should check

- **Reach walks view bodies only, not `declaredReachBodies`.** The ticket suggested considering `declaredReachBodies` (views plus declared maintained bodies). I kept `declaredViewBodies` for both views and maintained creates: planning a read of a maintained table does not plan that table's body, so a chain through a maintained table does not need that table's sources to exist. The direct edge to a new maintained table is still there, because its name is in the reader's body. The reason is in `bodyReach`'s doc comment.
- **A maintained create whose foreign key names another new maintained table gets no edge.** This matches the old rule ("a maintained parent does not affect the order"). Both are now stage-2 items; they keep input order unless a body read orders them.
- **A plain table whose foreign key names a new maintained table now always runs before its parent.** Memory and store do not check the parent at create. Checked on memory ad hoc (applies, re-diff empty). Not checked on store, and no test was added for it. This limit is documented in Migration Order item 3.

## Tests

Added in `apply-schema-alter-order.spec.ts` § `a new view reading what the plan changes`. Each asserts that `apply schema` succeeds and a re-diff is empty. All five reproductions failed at HEAD with the errors the ticket lists:

- `applies a new maintained table reading a column its source gains` (case 1, `ADD COLUMN`)
- `… reading a column renamed in the same apply` (case 2, `RENAME COLUMN`)
- `… reading a new view` (case 3)
- `… reading a new table written after it` (case 4, `table mt … maintained as select id from c; table c …`)
- `… reading a new materialized view written after it` (case 5)
- `applies a view reading a new materialized view`: pins the widened `runsAfter`. It passed at HEAD only because the materialized view ran in the create block. Without the widening it would fail after the move.

All six run from the block's `beforeEach` state (`t`, `u` existing). Cases 4 and 5 still exercise new-before-new ordering because `mt`/`c` and `m1`/`m2` are all new.

Removed from `schema-differ.spec.ts` § `generateMigrationPlan: table create order`: `a maintained create stays after every create written before it` and `a maintained child follows its parent; a maintained parent does not affect the order`. They pinned the deleted rule, and the apply tests above cover the new one.

Changed in `test/schema/differ-undo-plan.spec.ts`: `BROAD_DDL_MAIN` / `BROAD_DDL_ANALYTICS` moved `create materialized view mv1 as select id from fresh` from right after `create table fresh` to right after `create view fresh_v` (stage 2, after the `new_t` stage-2 steps, before `ADD CONSTRAINT`). That is the position the new rule gives it. The comment above the lists says so.

## Checked ad hoc (memory, not added as tests)

- A DEFAULT on an added column reading a new materialized view (`z … default ((select max(b) from m))`): the plan puts `create materialized view m` ahead of `ADD COLUMN z`; it applies.
- An edited body of an existing materialized view reading a renamed column: `RENAME COLUMN`, then `set maintained as`; it applies.
- When the view fills: with `t.b` retyped to `text` and `t.d` added with `default 7`, a new `m` over `t` fills after both, and its row reads `{"id":1,"b":"5","d":7}`.
- Planning cost: 500 materialized views over 20 altered tables plan in 11 ms, a chain of 500 written backwards in 13 ms, and 500 plain tables plus 500 materialized views with no alters in 3 ms. The deleted `createsAheadOfMaintained` comment had recorded 41 s for an older edge-per-pair design. The number is now in the `NOTE:` on `addEdgesThatCloseNoCycle`.

## Validation

- `yarn workspace @quereus/quereus run test`: 11135 passing, 26 pending.
- `yarn workspace @quereus/quereus run test:store`: 11128 passing, 33 pending. The run logs `[TransactionCoordinator] … transaction was committed out from under it` lines. Those lines also appear in older runs' logs in `tickets/.logs/`, so they are not from this change.
- `yarn workspace @quereus/quereus run lint`: clean.

The new spec cases use `new Database()` with the default memory module. `test:store` runs the `.sqllogic` files against the store, so these orderings have not been exercised on the store module.

## Known gaps and limits

- **A table that gains a column and also a DEFAULT reading a new materialized view over that column** still fails: stage 2 keeps one table's steps together, so the view runs first and does not find the column. It also failed before. The Known limits bullet now names materialized views beside views.
- **A failed maintained create after a `SET DATA TYPE`** now reports the schema as partially migrated, as a failed view create already did. This is documented, not tested.
- **Order between a view and a maintained create with no edge between them** follows bucket order (views first), not declaration order. Nothing depends on it.

## Docs

- `docs/schema-declarative.md` § Migration Order:
  - Item 3 now covers plain tables only, says maintained creates are sorted into stage 2, and states the limit for a foreign key child of a new maintained table.
  - Item 4's title and 4.2 now include `CREATE MATERIALIZED VIEW` / `CREATE TABLE … MAINTAINED AS`, say that a plain view follows the new maintained tables it reads, and say when the maintained table fills.
  - The cycle sentence, the Known limits bullet and the retype sentence also mention maintained creates now.
- `docs/schema-rename-detection.md`:
  - Line 84: the stale "Residual hazard" sentence is replaced. Maintained creates, backing-module recreates and `set maintained as` all run after `RENAME COLUMN`.
  - Line 15: this sentence was not on the ticket's list but was also stale. It claimed a rename-matched recreate is rendered with column renames inverse-applied because "creates run before `RENAME COLUMN`". The code executes the declared statement as written (view creates run after `RENAME COLUMN`, index creates after the alter block), and the sentence now says that.
- `docs/materialized-views.md` § Apply ordering bullet: one sentence on where a fresh maintained create runs.
