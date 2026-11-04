description: Whether a schema can be applied can depend on the order its tables are written in, because the migration finishes all of one table's changes before starting the next table's. Reorder the plan so a table's change never runs ahead of a change on another table that it needs.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan (per-table alter loop at ~3191), computeTableAlterDiff (~2296, columnsToAdd at ~2370), TableAlterDiff (~182), orderDropsByFKDependency (~3021), UndoRenderer
  - packages/quereus/src/schema/rename/table-rename.ts   # collectTableRefsInAst: table names an expression reads, including in subqueries
  - packages/quereus/src/schema/catalog.ts   # CatalogTable.columns[].defaultValue, the source for the drop-side ordering
  - packages/quereus/test/apply-schema-index-order.spec.ts   # the model for the new spec
  - packages/quereus/test/schema-differ.spec.ts   # pins plan order; multi-table expectations may change
  - packages/quereus/test/schema/differ-undo-plan.spec.ts   # pins plan order and undo; same
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # runs on both backends
  - docs/schema-declarative.md   # Migration Order, item 4 and the closing paragraph
repro: verified
difficulty: medium
----

# Apply schema alters tables one at a time, in declaration order

## The problem

`generateMigrationPlan` loops over `diff.tablesToAlter` and emits every phase of one table before the next table starts. `ALTER` statements validate what they refer to, so the declaration order decides which of them can succeed.

The cause is that one loop. Everything below was run on the memory module through `apply schema` on the build of HEAD 4f4f39621.

### Forward direction: a table refers to something another table is gaining

Starting from `t (id integer primary key, b integer null)` and `u (id integer primary key, y integer null)`:

```sql
declare schema main {
	table u { id integer primary key, y integer null, constraint fu foreign key (y) references t(d) }
	table t { id integer primary key, b integer null, d integer null unique }
}
apply schema main;
```

| what `u` declares | `u` written first | `t` written first |
|---|---|---|
| `constraint fu foreign key (y) references t(d)` | `Referenced column 'd' not found in table 't'` | applies |
| `constraint cu check (y > (select max(d) from t))` | `Column not found: d` | applies |
| `z integer null references t(d)` | `Referenced column 'd' not found in table 't'` | applies |
| `z integer null default ((select max(d) from t))` | `Column not found: d` | applies |
| `constraint fu foreign key (y) references t(b2)`, where `t` renames `b` to `b2` with a `quereus.previous_name` hint | `Referenced column 'b2' not found in table 't'` | not run |

All of the failures above are restored. Two named foreign keys pointing at each other's new columns fail with `t` written first (run). The `u`-first order was not run, but the plan is the mirror image and hits the same missing column, so no declaration order should apply them today.

### Reverse direction: a table gives up something another table still refers to

This direction is not in the original report but comes from the same loop, and it ends worse. Starting from `t (…, d integer null unique)` and `u (…, y integer null, constraint fu foreign key (y) references t(d))`, declaring both without `d` and `fu`:

| what is removed | `t` written first | `u` written first |
|---|---|---|
| `t.d` and the named FK `fu` | `Cannot drop column 'd' from 't': it is referenced by foreign key 'fu'` | applies |
| `t.d` and a named CHECK on `u` reading it | `… referenced by CHECK constraint 'cu'` | not run |
| `t.d` and `u.z`, whose inline FK points at it | `… referenced by foreign key '_fk_u_z'` | applies |
| `t.d` and `u.z`, whose DEFAULT subquery reads it | `… referenced by the DEFAULT of column 'z'` | applies |

Each of these failures reports **"could not be restored"**, because `DROP COLUMN` is marked irreversible before it runs, even though the guard refused it with nothing changed.

## Expected behaviour

A declarative schema applies whichever order its tables are written in, when some order of the plan's steps can reach the end state. `diff schema` and `apply schema` keep showing and running the same order. A plan that alters one table comes out exactly as it does today.

## The fix: this plan order

Split the alter loop into stages that cover all tables. Within a table, relative order stays as it is today.

```
1. RENAME COLUMN, all tables
2. Per table, ordered so a table comes after the tables its new columns refer to:
     ADD COLUMN → ALTER COLUMN → RENAME CONSTRAINT → DROP CONSTRAINT → ALTER PRIMARY KEY
3. ADD CONSTRAINT, all tables, declaration order
4. DROP COLUMN, all tables, a table before the tables its dropped columns' defaults read
5. SET TAGS (table, column, constraint), per table, declaration order
```

The existing early `DROP MAINTAINED` loop and late `SET MAINTAINED` loop do not change.

How this answers each failure:

- Stage 1 first means every later statement sees post-rename names, in any table (the rename row).
- Stage 3 runs after every table's columns exist. That covers named foreign keys and CHECKs, and it makes the two-FK cycle applicable.
- The ordering in stage 2 covers inline foreign keys and DEFAULT subqueries, which arrive inside `ADD COLUMN` and so cannot wait for stage 3.
- Stage 4 runs after every table's `DROP CONSTRAINT`, which clears the guards for named and inline FKs and named CHECKs. Its ordering covers the DEFAULT row, which has no constraint to drop first.
- Stage 5 stays after the structural stages because constraint tags can name constraints added in stage 3.

### Why stage 2 stays per table

Splitting every phase across tables is the obvious design and it regresses working declarations. An `ADD COLUMN` with an inline FK naming the parent's **implicit** key is checked against the parent's primary key as it stands at that moment:

- `t` going from `primary key (a, b)` to `primary key (d)` with `z integer null references t` on `u`, `t` written first: applies today. Run with the `ADD COLUMN` ahead of `ALTER PRIMARY KEY`, it is refused: `1 column(s) reference the primary key of 'main.t', which has 2 column(s)`.
- `t` moving its key to `d` with a row `d = 50`, and `z integer null default 50 references t`, `t` written first: applies today. Run the same way, it is refused: `u (z) has rows referencing a missing 't'`.

A pure dependency sort of whole tables, with no stages, fails the other way: it cannot apply the two-FK cycle or any reverse-direction case where the two tables point in opposite directions.

### What the stages can safely move

Checked by running the statements by hand in the proposed order:

- A child's FK can be added before the parent's named `UNIQUE`, because an FK does not require a unique parent.
- `ALTER PRIMARY KEY` and dropping a parent's `UNIQUE` both succeed while a child FK still refers to the parent, so stage 2's internal order is not constrained by FK guards in other tables.
- `SET DATA TYPE` is not refused by another table's CHECK reading the column, or by a new DEFAULT reading it.
- `SET DEFAULT` does not validate its subquery. `u ALTER COLUMN y SET DEFAULT (select max(d) from t)` applied ahead of `t ADD COLUMN d`. A `SET NOT NULL` backfill would evaluate it, so the stage 2 ordering should also count a `SET DEFAULT` expression.

These were hand-run statements, not a prototype of the planner, and were on memory only. The undo path and the store module were not exercised. Treat them as the design's grounds, and confirm them with the tests below.

### Dependency data

`generateMigrationDDL` passes no catalog, so `diff schema` gets no catalog at plan time and the ordering has to travel on the diff. `computeTableAlterDiff` has both the declared column ASTs and the pre-apply table, so it records two optional, lowercased name lists on `TableAlterDiff` (optional because tests hand-build partial diffs):

- what the table's added columns and `SET DEFAULT` expressions read: `ColumnDef` FK clauses (`ForeignKeyClause.table`, skipping another `schema`) plus `collectTableRefsInAst` over DEFAULT, CHECK and generated expressions with `rowImageContext: true`, the same way `findTableExpressionDependent` reads these expressions;
- what the table's dropped columns' `defaultValue` expressions read, from the pre-apply catalog. These are pre-rename spellings, so resolve them through `diff.renames` before comparing to `alter.tableName`, which is the post-rename name.

A self-reference, a table not in `tablesToAlter`, and another schema create no edge.

Share one stable dependency sort rather than adding a second copy of `orderDropsByFKDependency`. `apply-schema-creates-referenced-tables-first` needs the same thing for table creates and specifies: earliest declared first among those ready, and cycle members keep declaration order. Stage 4 runs the same sort with the edges reversed. With no edges, the output must equal the input, so existing previews do not change for it.

### Undo

No undo arm should change. `UndoRenderer` is told about each rename as its step is pushed and the unwind is the exact reverse, so Rules 1 and 2 in `docs/schema-undo-plan.md` hold for any push order. Every column rename now lands first, so every later step's undo replays all of them, which `replayRenames` already handles across tables.

`DROP COLUMN` steps now run later in multi-table plans, so a failure in another table's earlier stages stays restorable more often. That is a side benefit, and the docs should not promise it.

## Known limits

Each of these still fails, reports its error and is restored. State them in the docs.

- **Inline references that form a cycle.** `t.d … references u(z)` with `u.z … references t(d)` fails in every order, because both refer to each other inside `ADD COLUMN`. The workaround is to declare at least one as a named table-level foreign key, which moves it to stage 3.
- **References through a view.** Edges come from names written directly in the column definition, so a DEFAULT reading a view over `t` gets no edge and keeps declaration order. Add a `NOTE:` tripwire at the edge collection: if this shows up, follow the reach with `reachableObjects`.

## Relationship to other open tickets

- `bug-apply-schema-creates-views-before-added-columns` covers the separate view-create phase and is not fixed by this. If it moves view creates after the alter block, an `ADD COLUMN` whose DEFAULT reads a newly declared view stops working: `create view w …` then `ALTER TABLE u ADD COLUMN z … default (select m from w)` applies today. Whichever ticket lands second needs to keep that case working.
- `apply-schema-creates-referenced-tables-first` orders table creates and should share the sort.
- `bug-apply-undo-refused-when-re-added-constraint-does-not-validate` reproduces by removing a constraint ahead of a failing `ADD CONSTRAINT`. Under this order `DROP CONSTRAINT` still comes first, so its reproduction should still hold.

## TODO

Planner:
- Add a stable dependency sort and move `orderDropsByFKDependency` onto it if that keeps its behaviour.
- Record the two read-name lists on `TableAlterDiff` in `computeTableAlterDiff`.
- Split the alter loop in `generateMigrationPlan` into the five stages, as small helper functions rather than one larger loop, and replace the "Phase order within one table" comment with the stage order.
- Add the view-reach `NOTE:` at the edge collection.

Tests (a new `apply-schema-alter-order.spec.ts` modelled on `apply-schema-index-order.spec.ts`, each case applying and checking that a re-diff is empty):
- The four reference forms, with `u` written first (table-driven), plus the rename form.
- The two named FKs pointing at each other's new columns.
- The reverse direction: named FK, named CHECK, inline FK and DEFAULT subquery, with `t` written first. Assert the apply succeeds, not only that it reports no partial migration.
- The two implicit-key cases above, with `t` written first, as regressions against a phase-only design.
- A forced later failure: over `t` rows `(1, 1), (2, 1)`, `u` written first with `fu`, plus `constraint ub unique (b)` on `t`. Assert the step's own error and an empty difference from the pre-apply catalog, with no "could not be restored".
- Add the forward FK case to `50.4-declare-schema-apply-restore.sqllogic` or a `50.x` sibling so `yarn test:store` covers the store path.

Update existing expectations in `schema-differ.spec.ts`, `differ-undo-plan.spec.ts` and the `50.*` logic files only where a multi-table plan's order legitimately changed. A single-table expectation that changes is a bug in the split.

Docs:
- `docs/schema-declarative.md` § Migration Order: rewrite item 4 as the stages, replace the closing sentence about constraint `ADD`s with the wider rule, and add the known limits.
- `docs/sql-ddl.md` § Order Independence: check whether it makes a claim about declaration order that should now mention this.

Validation:
- `yarn test`, `yarn test:store` and `yarn lint`. The store run matters because the design was only checked on memory.
