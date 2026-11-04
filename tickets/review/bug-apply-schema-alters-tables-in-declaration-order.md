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

## What changed

`generateMigrationPlan` used to emit every phase of one table before the next. `pushTableAlters` now emits five stages across all altered tables:

```
1. RENAME COLUMN, all tables
2. Per table, after the tables its new columns refer to:
     ADD COLUMN → ALTER COLUMN → RENAME CONSTRAINT → DROP CONSTRAINT → ALTER PRIMARY KEY
3. ADD CONSTRAINT, all tables, declaration order
4. DROP COLUMN, all tables, a table before the tables its dropped columns' expressions read
5. SET TAGS, all tables, declaration order
```

A table's own steps keep their old relative order, so a one-table plan is unchanged. `diff schema` and `apply schema` still share one plan. No undo arm changed: `UndoRenderer` is told about each rename as its step is pushed, and every later step's undo replays them.

## Where this departs from the fix ticket

Each departure is something I ran and saw. Please check these first.

- **No `SET DEFAULT` edge.** The ticket said stage 2 should count `SET DEFAULT` because a `SET NOT NULL` backfill would evaluate it. It does not: `planTightenNotNull` folds the default to a literal, and a subquery default refuses with `column y contains NULL values`, whatever the order. Nothing in the plan reads what `SET DEFAULT` names, and the edge could create a false cycle (read from the code, not run). The row `a new DEFAULT on an existing column` pins that `SET DEFAULT` still does not validate, so it fails if that ever changes.
- **Generated columns added on the drop side.** Not in the ticket. `t.d` and `u.g` (generated, reading `t.d`) both removed, `t` written first, was refused exactly like the DEFAULT row, while `u` first applied. Fixing it needed `generatedExpr` on `CatalogTable.columns`. It is left out of `renderCatalogForComparison` because the table's `ddl` already renders it, but it is also absent from the restore check, which strips `ddl`, as it was before this change.
- **`orderDropsByFKDependency` not moved onto the shared sort.** The ticket said to move it only if that kept its behaviour. It would not: it reverses unrelated tables and breaks ties and cycles by walk order, so `diff schema` output would change for some inputs. I worked this out by reading the code and tracing examples, not by running a moved version. A comment at the site says so.
- **The ticket's "each known limit is restored" is wrong for drops.** A refused `DROP COLUMN` reports "could not be restored" and leaves earlier steps applied. Run with a `t ADD COLUMN q` ahead of a refused drop, `q` stayed after the failure. The docs state this.

## Known gaps

All are in docs/schema-declarative.md § Migration Order, and the two ordering ones also have `NOTE:` comments at `recordCrossTableReads`.

- **Inline foreign keys forming a cycle** fail in every order and are restored. Workaround: a named table-level foreign key.
- **A cycle that exists only between tables is not in the fix ticket and still depends on declaration order.** `t.d references u(z)` needs the new `u.z`, and `u.z references t(id)` names an existing column. `u` first applies, `t` first fails and is restored. This falls short of the ticket's "applies whichever order" expected behaviour. I left it because edges are per table by design, and the workaround above covers it. The reviewer may want to weigh this one.
- **A reference through a view** gets no edge. Adding fails and is restored when `u` is written first. Dropping is refused when `t` is written first and reports a partial migration.
- **Dropped columns whose defaults read each other** cannot go in either order, and report a partial migration. Removing the defaults in an earlier apply, then dropping, gave an empty re-diff.

Not run:
- The workaround for the two cycle cases (a named table-level foreign key) was not run as such. The named-foreign-key cycle test covers the same mechanism.
- `bug-apply-schema-creates-views-before-added-columns` is still open. Whichever ticket lands second must keep `create view w …` then `ADD COLUMN z … default (select m from w)` working. There is no test for that case here.

## Tests added

`packages/quereus/test/apply-schema-alter-order.spec.ts` (each apply case also checks that a re-diff is empty):

| test | what it verifies |
|---|---|
| `applies` + named foreign key, named CHECK, inline foreign key, DEFAULT subquery, generated column, `u` written first | forward references to a column another table gains |
| `applies a new DEFAULT on an existing column` | `SET DEFAULT` does not validate its subquery, which is why it has no edge |
| `applies a foreign key naming a column the other table renames` | the reported rename failure |
| `applies an inline foreign key naming a renamed column when the tables also refer to each other` | stage 1 specifically; the only test that fails if renames move back into stage 2 |
| `applies two named foreign keys pointing at each other's new columns` | stage 3 resolves a named cycle |
| `applies when …` + named foreign key, named CHECK, inline foreign key, DEFAULT subquery, generated column goes with the column, `t` written first | the reverse direction, asserting the apply succeeds |
| `orders the drops when the table a dropped default reads is also renamed` | catalog names are mapped through table renames |
| `applies an inline foreign key naming the implicit key of a table changing its key width`; `validates an inline foreign key's default against the new key` | stage 2 stays per table; both fail if every phase is split across tables |
| `a failure in a later stage reports its own error and restores the catalog` | undo across stages, with no "could not be restored" |
| `dependency ordering`, three cases | the sort: earliest ready first, an order that already fits does not move, cycles keep input order, reversed edges |

`50.4-declare-schema-apply-restore.sqllogic` section 10 covers the store path: a forward foreign key with a forced failure and restore, then the reverse direction, a dropped DEFAULT, and the implicit-key case.

Against the final spec (21 tests), I removed each stage and edge in turn. Each removal failed at least one test:

| removed | tests failing |
|---|---|
| stage 2 ordering | 3 |
| stage 4 ordering | 3 |
| `ADD CONSTRAINT` as its own stage | 4 |
| `DROP COLUMN` as its own stage | 6 |
| `RENAME COLUMN` as its own stage | 1 |
| per-table stage 2 (every phase split across tables) | 2 |

## Validation

Each ran once. No existing expectation had to change, including the multi-table ones in `schema-differ.spec.ts` and `differ-undo-plan.spec.ts`.

- `yarn workspace @quereus/quereus run test`: 10923 passing, 25 pending.
- `yarn test:store`: 10916 passing, 32 pending. 50.4 is not in the memory-only list, so section 10 ran on LevelDB.
- `yarn workspace @quereus/quereus run lint`: clean. Every other package's lint is a no-op.
- `yarn build`, then every other workspace's tests: all pass.

These runs came before three small final edits: the rename test in the spec, a comment on `orderDropsByFKDependency`, and one docs paragraph. The spec was re-run on its own afterwards. `yarn test:scripts` was not run because no script changed.

The `[TransactionCoordinator] … out of range` lines in the store log are log output, not failures. I did not check whether they also appear without this change.
