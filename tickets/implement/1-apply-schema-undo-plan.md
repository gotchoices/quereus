description: When the engine works out the steps needed to bring a database in line with a declared schema, it should also work out how to take each step back again, so a later change can restore the database when a migration fails partway.
architecture: docs/schema.md#declarative-schema
files:
  - packages/quereus/src/schema/schema-differ.ts            # MigrationStep, generateMigrationPlan, generateMigrationDDL
  - packages/quereus/src/schema/catalog.ts                  # SchemaCatalog / CatalogTable / CatalogView / CatalogIndex / CatalogAssertion — the pre-apply state the undo is rendered from
  - packages/quereus/src/schema/ddl-generator.ts            # generateTableDDL / generateViewDDL / indexToCanonicalDDL / constraintToCanonicalDDL / tagsBodyToString — the renderers to reuse
  - packages/quereus/src/runtime/emit/alter-table.ts        # renameTableInAst / renameColumnInAst — the forward rename rewriters the undo bodies need
  - packages/quereus/src/runtime/emit/schema-declarative.ts # emitApplySchema — already holds `actualCatalog`; the caller that will pass it in (ticket 2 wires the executor)
difficulty: hard
----
# Record how to undo each migration step

## Why

`apply schema` turns the difference between a declared schema and the live catalog into an ordered list of DDL statements and runs them one at a time. Today a failure on statement N leaves statements 1 to N-1 applied with no way back. The sibling ticket `apply-schema-rollback-journal` makes the executor put the catalog back; it needs to be told *how*, and the only component that knows both what each step does and what the catalog looked like beforehand is the migration planner.

This ticket adds that knowledge to the plan. It changes no behaviour on its own — nothing reads the new fields until ticket 2 lands.

## Shape

`generateMigrationPlan` gains an optional third argument: the pre-apply `SchemaCatalog` (exactly the `actualCatalog` that `computeSchemaDiff` was handed, which `emitApplySchema` already has in scope). When it is supplied, every step also carries either the statements that undo it or a reason it cannot be undone.

```ts
export interface MigrationStep {
	readonly sql: string;
	readonly ast?: AST.Statement;
	/**
	 * DDL that puts the catalog back the way it was before this step ran, in the order it must
	 * be executed. An empty array means the step changed nothing to undo (an `IF EXISTS` drop
	 * whose target was already absent). Absent means undo was not requested — no pre-apply
	 * catalog was passed.
	 */
	readonly undo?: readonly string[];
	/**
	 * Set instead of `undo` when the step destroys something no DDL can put back. The string is
	 * the human-readable reason, used verbatim in the executor's diagnostic.
	 */
	readonly irreversible?: string;
}

export function generateMigrationPlan(
	diff: SchemaDiff,
	schemaName?: string,
	actual?: SchemaCatalog,
): MigrationStep[];
```

`generateMigrationDDL` keeps calling `generateMigrationPlan(diff, schemaName)` with no catalog and keeps mapping to `sql`, so **`diff schema` output is byte-identical**. That is a hard requirement, not a nicety: the preview text and the text an execution error names must not move.

Undo is plain SQL text rather than an AST. It runs on the failure path only, where re-parsing a handful of short statements costs nothing, and text keeps the arm table below readable.

## The two rules that make the undo correct

These are the subtle part of the ticket. Both must be honoured at every arm and pinned by tests.

**Rule 1 — spell the target the way the forward step spelled it.** The executor unwinds in reverse order, so when step K's undo runs, every step after K has already been taken back and the catalog is in the state step K left it in. The forward step's own spelling of its target is therefore the right spelling for the undo. Concretely: table renames are the first steps in the plan, so a later `ALTER TABLE t ...` step already names the post-rename table, and its undo must too.

**Rule 2 — forward-apply this diff's renames to anything taken from the pre-apply catalog.** Values that come from `actual` (a constraint body, a restored view or assertion body, a column default) are spelled with pre-rename table and column names. By Rule 1 those renames are still in force when the undo runs, so every such body must have this diff's table renames (`diff.renames`) and column renames (`TableAlterDiff.columnsToRename`) applied **forward** before it is emitted — using the same `renameTableInAst` / `renameColumnInAst` rewriters the live rename propagation uses, so the undo and the forward path cannot drift. The differ already runs these rewriters *inverse*-applied for its rename-reconciled body comparison (`reconciledDeclaredBody`, see `docs/schema-rename-detection.md` § Constraint body-change detection); this is the same machinery pointed the other way.

## Arm table

`t`, `v`, `i`, `a`, `c` below stand for the step's own target, spelled per Rule 1. "from actual" means read out of the pre-apply `SchemaCatalog` and passed through Rule 2.

| forward step | undo |
|---|---|
| `ALTER TABLE a RENAME TO b` | `ALTER TABLE b RENAME TO a` |
| `DROP ASSERTION IF EXISTS a` | the assertion's `CatalogAssertion` DDL, from actual |
| `ALTER TABLE t DROP MAINTAINED` | `ALTER TABLE t SET MAINTAINED [(cols)] AS <body>`, from actual's `maintained` descriptor |
| `DROP TABLE IF EXISTS t` | **irreversible** — the rows go with it, and re-creating a maintained table mints a new incarnation |
| `DROP VIEW IF EXISTS v` | the view's `CatalogView` DDL, from actual |
| `DROP INDEX IF EXISTS i` | the index's `CatalogIndex` DDL, from actual |
| `CREATE TABLE t ...` (plain or the maintained sugar) | `DROP TABLE IF EXISTS t` |
| `CREATE VIEW v ...` | `DROP VIEW IF EXISTS v` |
| `CREATE INDEX i ...` | `DROP INDEX IF EXISTS i` |
| `CREATE ASSERTION a ...` | `DROP ASSERTION IF EXISTS a` |
| `ALTER TABLE t RENAME COLUMN a TO b` | `ALTER TABLE t RENAME COLUMN b TO a` |
| `ALTER TABLE t ADD COLUMN c ...` | `ALTER TABLE t DROP COLUMN c` |
| `ALTER COLUMN c DROP DEFAULT` | `ALTER COLUMN c SET DEFAULT <expr>` from actual, or nothing when the column had none |
| `ALTER COLUMN c SET DEFAULT e` | restore actual's default, or `DROP DEFAULT` when it had none |
| `ALTER COLUMN c SET DATA TYPE T` | **irreversible** — the conversion can lose values |
| `ALTER COLUMN c SET COLLATE X` | `ALTER COLUMN c SET COLLATE <collation>` from actual |
| `ALTER COLUMN c SET NOT NULL` | `ALTER COLUMN c DROP NOT NULL` |
| `ALTER COLUMN c DROP NOT NULL` | `ALTER COLUMN c SET NOT NULL` |
| `ALTER TABLE t RENAME CONSTRAINT a TO b` | `ALTER TABLE t RENAME CONSTRAINT b TO a` |
| `ALTER TABLE t DROP CONSTRAINT c` | `ALTER TABLE t ADD constraint c <definition> [tags]`, from actual's `namedConstraints` entry |
| `ALTER TABLE t ALTER PRIMARY KEY (new)` | `ALTER TABLE t ALTER PRIMARY KEY (old)` — column names and directions from actual's `primaryKey` |
| `ALTER TABLE t ADD <fragment>` | `ALTER TABLE t DROP CONSTRAINT <name>` — the name the differ put in the fragment |
| `ALTER TABLE t DROP COLUMN c` | **irreversible** — the column's values go with it |
| any `SET TAGS` arm (table, column, constraint, view, index; `ALTER TABLE` or `ALTER MATERIALIZED VIEW`) | the same verb with actual's tag set, rendered by `tagsBodyToString`; the empty set restores "no tags" |
| `ALTER TABLE t SET MAINTAINED [(cols)] AS ...` | actual maintained: the prior `SET MAINTAINED ... AS <body>`. actual plain: `ALTER TABLE t DROP MAINTAINED` |

Three arms are irreversible, and they are exactly the data-destroying ones: `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN ... SET DATA TYPE`. That is not an accident of this design — no amount of catalog bookkeeping restores rows the storage module already threw away, and restoring the *catalog* alone would be worse than a partial apply (the user would be told the apply failed and the schema is untouched while sitting on an emptied table). Anything else that turns out not to round-trip should be marked `irreversible` with an honest reason rather than given a lossy undo.

`maintainedModuleMigrations` needs no special handling here: its drop rides `tablesToDrop`, so it is already covered by the `DROP TABLE` arm, and it is separately gated at apply time on `allow_destructive`.

## Edge cases & interactions

- **`IF EXISTS` steps whose target is absent from `actual`.** The forward step is a no-op, so `undo` is the empty array and the step is **not** irreversible. A `DROP TABLE IF EXISTS` for a table that was never there must not poison a later unwind.
- **A step whose undo needs several statements** returns them in the order they must run. The executor reverses whole steps, not the statements inside one.
- **Schema qualification.** Undo DDL carries the same `schemaPrefix` the forward step used; a non-`main` target must round-trip.
- **A constraint dropped after a column it names was renamed in the same diff.** Rule 2's case in chief: the restored `ADD constraint` body must name the post-rename column, or the undo fails. Test this directly with a diff that both renames a column and drops a named CHECK over it.
- **A view or assertion dropped in a diff that also renames one of its source tables.** Same shape as above, through the table-rename rewriter.
- **A table renamed and then altered in the same diff.** Rule 1's case in chief: the alter's undo names the new table name.
- **Both a `dropMaintained` and a `setMaintained` on one table** (the re-attach-with-reshape leg). Each step gets its own undo; together they must compose back to actual's derivation.
- **Tag clearing.** A forward `SET TAGS ()` that cleared a tag set must undo to the full prior set; a forward set onto a previously untagged object must undo to the empty set, not to "leave alone".
- **Hand-built partial `SchemaDiff` literals in tests.** Several existing tests construct partial diffs; the undo code must tolerate missing buckets the same way the forward code's `?? []` does, and must tolerate an `actual` that does not mention an object the diff touches (emit no undo for it rather than throwing — a plan generator that throws would break `diff schema` for those tests).
- **`diff schema` must not move.** A snapshot test over `generateMigrationDDL` for a broad diff, asserting the text is unchanged by this ticket, is the cheapest guard.

## TODO

- Add `undo` and `irreversible` to `MigrationStep`; document both fields with the two rules above.
- Add the optional `actual: SchemaCatalog` parameter to `generateMigrationPlan`; leave `generateMigrationDDL` calling it without one.
- Add a small internal helper that renders a catalog-sourced body with this diff's renames forward-applied (Rule 2), built on `renameTableInAst` / `renameColumnInAst`, and route every catalog-sourced arm through it.
- Add helpers that render, from `SchemaCatalog` alone: a table's named-constraint `ADD` fragment (name + `definition` + tags), a column's `SET DEFAULT` / `SET COLLATE` / nullability restore, an object's `SET TAGS` restore, and a maintained table's `SET MAINTAINED` restore. Reuse `ddl-generator.ts` renderers rather than hand-writing text.
- Fill in every arm of the table above at its existing push site in `generateMigrationPlan`, so a reader sees the forward step and its undo together.
- Mark the three irreversible arms with reasons written for a user, not for a maintainer.
- Unit tests: one per arm, asserting the exact undo text; the absent-target, rename-interaction, qualification, tag-clearing and partial-diff cases above; and the `diff schema` no-movement guard.
- Run `yarn test` and `yarn lint` (the lint script type-checks the spec files too).
