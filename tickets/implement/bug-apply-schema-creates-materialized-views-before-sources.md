description: A schema declaration that adds a new materialized view reading a column added or renamed in the same apply, a new plain view, or another new materialized view written after it, can never be applied, because the migration creates the materialized view too early. Move these creates to where plain view creates already run.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan (create block), orderTableCreates, createsAheadOfMaintained, isMaintainedCreate, pushTableAlters, viewStageTwoItems, freshTableCreate, viewCreate, declaredReachBodies, MigrationCreate.viewReach
  - packages/quereus/src/schema/dependency-order.ts   # orderDependenciesFirst (no change expected)
  - packages/quereus/test/apply-schema-alter-order.spec.ts   # `a new view reading what the plan changes` block: add the reproductions here
  - packages/quereus/test/schema-differ.spec.ts   # `generateMigrationPlan: table create order`: the two maintained-create tests
  - docs/schema-declarative.md   # Migration Order, items 3 and 4.2
  - docs/schema-rename-detection.md   # line 84, "Residual hazard" sentence
repro: verified
----

# Apply schema creates a new materialized view before what it reads

## Reproduction

All of these fail on the memory module at HEAD `068d0875a`, run through `apply schema main` from source, with the catalog restored. The first three start from an applied `table t { id integer primary key, b integer null }`; the last two start from an empty catalog.

```sql
-- 1. reads a column added in the same apply
table t { id integer primary key, b integer null, d integer null }
materialized view m as select id, d from t
-- plan: create materialized view m …; ALTER TABLE t ADD COLUMN d …
-- Column not found: d

-- 2. reads a column renamed in the same apply
table t { id integer primary key, b2 integer null with tags ("quereus.previous_name" = 'b') }
materialized view m as select id, b2 from t
-- plan: create materialized view m …; ALTER TABLE t RENAME COLUMN b TO b2
-- Column not found: b2

-- 3. reads a new plain view
table t { id integer primary key, b integer null }
view w as select id, b from t
materialized view m as select id, b from w
-- Table 'w' not found in schema path: main

-- 4. a maintained table written ahead of its new source
table mt { id integer primary key } maintained as select id from c;
table c { id integer primary key }
-- Table 'c' not found in schema path: main

-- 5. a materialized view written ahead of the new materialized view it reads (found in this fix pass)
table t { id integer primary key, b integer null }
materialized view m2 as select id from m1
materialized view m1 as select id from t
-- Table 'm1' not found in schema path: main
```

Each applies when written in a different order, or split over two applies.

These already apply and must keep applying: a new plain view reading a new materialized view (`view w as select id, b from m`), an added column whose DEFAULT reads a new materialized view (`z … default ((select max(b) from m))`), a new plain table whose foreign key names a new maintained table, and an edited body of an existing materialized view that reads a renamed column (that goes through the late `set maintained as`, not through a create).

## Cause

A new materialized view, and a new `table … maintained as`, are fresh creates in `diff.tablesToCreate` (`freshTableCreate`). `generateMigrationPlan` pushes that whole bucket in the create block, through `orderTableCreates`, ahead of `pushTableAlters`. So a maintained create runs before every `RENAME COLUMN`, `ADD COLUMN` and view create. Its body is planned when it runs (`buildCreateMaterializedViewStmt` → `planViewBody`), so anything those later steps produce is missing.

Inside the create block, `createsAheadOfMaintained` makes a maintained create follow every create written before it, and nothing written after it. That is why cases 4 and 5 depend on written order.

A destructive backing-module move (`maintainedModuleMigrations`) also rides `tablesToCreate` as a fresh create, so it has the same early position.

An existing table that becomes maintained is not affected: its `set maintained as` runs after the whole alter block.

## Fix

Move maintained creates out of the create block and sort them into stage 2 of `pushTableAlters`, as items of the same shape plain view creates already use. Plain creates stay in the create block.

- **Split the bucket** in `generateMigrationPlan`: plain table creates go through `orderTableCreates`; maintained creates (`isMaintainedCreate`) go to `pushTableAlters` beside `diff.viewsToCreate`. `diff.tablesToCreate` itself keeps its order, as it does now.
- **Stage-two item for a maintained create**, built like `viewStageTwoItems`:
  - `key`: the created name, lowercased (`createdObjectTarget`).
  - `runsAfter`: the new views and new maintained creates its body reaches, directly or through declared view bodies. This fixes cases 3 and 5.
  - `prefersToRunAfter`: the other names its body names (tables). `alsoPrefersToRunAfter`: every altered table. Because every table's stage 2 steps include `ADD COLUMN`, and stage 1 has already run `RENAME COLUMN`, this fixes cases 1 and 2. Case 4 is fixed because every plain create now runs before stage 2.
  - `push`: `sink.pushCreate(create, 'table')`. The undo kind must stay `'table'`, not `'view'`.
- **The body** is `ast.select` for `createMaterializedView` and `ast.maintained.select` for a `createTable` with `maintained`.
- **Reach for a maintained create.** Give it a `viewReach` the way `viewCreate` does, so a hand-built diff still falls back to the names in the body. `freshTableCreate` runs in the table loop, before `declaredViewBodies` is built (around line 799), so either build the view bodies earlier or fill the reach after the view loop. Consider walking `declaredReachBodies` (views plus declared maintained bodies) instead of `declaredViewBodies` for both views and maintained creates, so a chain through an unchanged maintained table is followed; the `runsAfter` filter to new items keeps extra names harmless.
- **Plain views must follow new maintained creates.** `viewStageTwoItems` filters `runsAfter` to `newViews`. Widen that set to every stage-two create key (new views and new maintained creates), and leave those keys out of `prefersToRunAfter`. Today a view reading a new materialized view works only because the materialized view runs in the create block. Without this, it would fail after the move.
- **Added columns** need no change: `addedColumnReads` already holds the names a DEFAULT, CHECK, generated expression or inline foreign key names, and a materialized view name is one of them. It becomes a required edge to the maintained item once that item is in the sort.
- **Simplify `orderTableCreates`.** With no maintained creates left in its input, delete `createsAheadOfMaintained` and the `plainTables` filter. Every foreign key parent is then a plain create in the same bucket or a table that already exists, so keep the filter to names in the bucket (a parent in the catalog, or a parent that is a maintained create now in stage 2, gives no edge).

## Consequences to document

- **A foreign key whose parent is a new maintained table.** The child is a plain create, so it now always runs before the parent. Today it keeps written order with the parent. The memory and store modules do not check a foreign key's parent at create, so this applies on both (checked on memory). A module that resolves the parent at create time gets no help in this case; the `apply-schema-creates-referenced-tables-first` review already recorded that limit. State it in Migration Order item 3 and keep it out of scope. Moving such children into stage 2 would need the move to close over their own children, which is more machinery than this case justifies today.
- **A failed maintained create after a retype** now reports the schema as partially migrated, as a failed plain view create already does, because the `SET DATA TYPE` has run and cannot be undone. Add maintained creates to that sentence in Migration Order.
- **When the materialized view fills.** It now fills after the stage 2 alters, so rows reflect added columns' DEFAULTs and retypes. From reading the code (not run), nothing in stages 3–5 depends on it being filled earlier: `ADD CONSTRAINT` validates against tables, and a stage 4 `DROP COLUMN` already ran after the materialized view existed, so its interaction with the drop guards does not change.

## Tests

Add the five reproductions as `applies(...)` cases in the `a new view reading what the plan changes` block of `packages/quereus/test/apply-schema-alter-order.spec.ts` (cases 4 and 5 need a declaration that does not start from the block's `beforeEach` state, or a separate small `describe`). Each asserts that `apply schema` succeeds and a re-diff is empty, which `applies` already does. Also add a view reading a new materialized view, so the widened `runsAfter` is pinned: that case passes today only by accident of the create block.

In `packages/quereus/test/schema-differ.spec.ts` § `generateMigrationPlan: table create order`, the tests `a maintained create stays after every create written before it` and `a maintained child follows its parent; a maintained parent does not affect the order` pin the rule this ticket deletes. Their expected orders may still pass, since every maintained create now comes last, but the reasoning in them no longer holds. Remove them, or replace them with one test that a maintained create comes after every plain create and after the alters' stage 2 steps.

Run `yarn workspace @quereus/quereus run test`, `yarn workspace @quereus/quereus run test:store` (the store module is where materialized-view backing differs), and `yarn workspace @quereus/quereus run lint`. Some `diff schema` order expectations in specs or `.sqllogic` files may move a `create materialized view` line later; check each moved expectation against the new rule rather than just re-recording it.

## Docs

- `docs/schema-declarative.md` § Migration Order item 3: remove "A maintained create stays after every create written before it…" and "A foreign key whose parent is a maintained create does not affect the order"; say maintained creates are not here, and state the foreign-key-child consequence above.
- Item 4.2: say `CREATE MATERIALIZED VIEW` and `CREATE TABLE … MAINTAINED AS` are sorted with view creates and follow the same rules, and that a plain view follows the new maintained tables it reads. Add maintained creates to the retype sentence at the end of the section.
- `docs/schema-rename-detection.md` line 84: the "Residual hazard (known, unsolved)" sentence is stale. An edited body of an existing materialized view that reads a renamed column applies today, because it is a `set maintained as` that runs late (verified on memory). After this fix, a new materialized view and a backing-module recreate also run after `RENAME COLUMN`. Replace the sentence with a statement that maintained creates and re-attaches both run after `RENAME COLUMN`, or delete it.
- Update the comments on `generateMigrationPlan`'s create block ("A fresh maintained table rides `tablesToCreate` … and re-materializes as part of its create"), `orderTableCreates`, `pushTableAlters` (stage 2 paragraph) and `viewStageTwoItems` to match.

## TODO

- Split `diff.tablesToCreate` in `generateMigrationPlan`: plain creates through `orderTableCreates`, maintained creates into `pushTableAlters`.
- Give maintained creates a `viewReach`, computed after the declared view bodies exist.
- Generalize `viewStageTwoItems` to build items for both view creates and maintained creates; widen `runsAfter` to every stage-two create key; push maintained creates with kind `'table'`.
- Delete `createsAheadOfMaintained` and simplify `orderTableCreates`; update its comment, keeping the existing `NOTE:` about CHECK and DEFAULT reads.
- Add the reproduction tests and the view-over-new-materialized-view test; remove or replace the two obsolete create-order tests.
- Update the Migration Order docs, the rename-detection "Residual hazard" sentence and the code comments listed above.
- Run quereus `test`, `test:store` and `lint`.
