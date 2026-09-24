# Undo Plan

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

How the declarative migration planner records, on every step of a plan, the statements that take that step back — so an executor can unwind a partially applied `apply schema` (see `apply-schema-rollback-journal`) — and the two rules that make an undo correct under renames. A satellite of [Schema Management](schema.md); the plan ordering it unwinds is described there under [Declarative Schema](schema.md#declarative-schema).

`generateMigrationPlan(diff, schemaName, actual)` — given the same pre-apply `SchemaCatalog` that `computeSchemaDiff` was handed — also records, on every step, how to take that step back: `undo`, the DDL statements (in execution order) that return the catalog to the state the step found it in, or `irreversible`, a user-readable reason why no statement can. An empty `undo` means the step changed nothing (an `IF EXISTS` drop of an object that was already absent). `generateMigrationDDL` never passes a catalog, so `diff schema` output and cost are untouched; without the catalog nothing about the undo is computed. The undo is plain SQL text, not an AST: it only ever runs on an executor's failure path, where re-parsing a handful of short statements costs nothing.

Two rules make an undo correct, and every arm of the planner honours both:

1. **Spell the target the way the forward step spelled it.** The unwind runs in reverse, so when a step's undo runs every later step has already been taken back and the catalog is in the state the step itself left behind. Table renames are the plan's first steps, so a later `ALTER TABLE t …` step — and its undo — name the post-rename table, and the planner finds the pre-apply table under its old name.
2. **Forward-apply the renames in force to anything taken from the pre-apply catalog.** A restored constraint, view, assertion or derivation body, a column default and the old primary key are all spelled with pre-rename names in the catalog. The renames whose steps *precede* the step are still in force when its undo runs, so the planner applies them to the body forward — through the same `renameTableInAst` / `renameColumnInAst` walkers the live rename propagation uses, so the two cannot drift. This is the differ's rename-reconciled comparison (`reconciledDeclaredBody`, [Rename Detection § Constraint body-change detection](schema-rename-detection.md#constraint-body-change-detection-droprecreate)) pointed the other way. Only *preceding* renames count: a view dropped before the column-rename phase is restored with the old column names, because by the time its undo runs the column rename has already been reversed.

The planner tracks the renames in force as it pushes the plan (`UndoRenderer` in `schema-differ.ts`), so every catalog lookup and every body rewrite goes through exactly the renames whose steps came before. Undo per step:

| forward step | undo |
|---|---|
| `ALTER TABLE a RENAME TO b` | `ALTER TABLE b RENAME TO a` |
| `DROP ASSERTION IF EXISTS a` / `DROP VIEW IF EXISTS v` | the `create assertion` / `create view` rendered from the catalog's body AST (`CatalogAssertion.check`, `CatalogView.select` + `columns`) through the same renderers the create buckets use |
| `DROP INDEX IF EXISTS i` | the catalog's index DDL re-parsed, re-targeted at the table's current name, re-rendered |
| `ALTER TABLE t DROP MAINTAINED` | `alter table t set maintained [(cols)] as <body>` from the catalog's derivation body and recorded column list |
| `CREATE TABLE` / `VIEW` / `INDEX` / `ASSERTION` (incl. the materialized-view sugar) | `DROP … IF EXISTS` of the object the statement names |
| `RENAME COLUMN a TO b` / `RENAME CONSTRAINT a TO b` | the reverse rename |
| `ADD COLUMN c …` / `ADD constraint c …` | `DROP COLUMN c` / `DROP CONSTRAINT c` (the name parsed from the fragment) |
| `DROP DEFAULT` / `SET DEFAULT e` / `SET COLLATE x` / `SET NOT NULL` / `DROP NOT NULL` | restore the catalog's default (or `DROP DEFAULT` when there was none — and after a `dropStaleDefaultFirst` clear, the column reaches `SET DEFAULT` with no default, so that undo is `DROP DEFAULT`), collation, or the opposite nullability |
| `DROP CONSTRAINT c` | `ADD constraint c <body> [with tags]` from the catalog's full-fidelity constraint lift (`namedConstraints[].bodyAst` — deferrability survives; the canonical `definition` has dropped it) |
| `ALTER PRIMARY KEY (new)` | `ALTER PRIMARY KEY (old)` from the catalog's `primaryKey`, column names spelled through the renames in force |
| any `SET TAGS` (table, column, constraint, view, index; either verb) | the same verb with the catalog's tag set; the empty set restores "no tags" |
| `SET MAINTAINED … AS <new>` | the prior `set maintained … as <old>` when the table was maintained at that step; `DROP MAINTAINED` when it was plain — including the re-attach reshape leg, where this same plan detached it earlier, so the pair composes back to the original derivation |
| `DROP TABLE IF EXISTS t` / `DROP COLUMN c` / `ALTER COLUMN c SET DATA TYPE T` | **irreversible** |


Exactly three steps are irreversible, and they are the data-destroying ones: no catalog bookkeeping restores rows or values the storage module already threw away, and restoring the *catalog* alone would be worse than a partial apply (the apply would be reported as fully undone while the table sits emptied). A step whose target the pre-apply catalog does not mention — including a name a rename in force has vacated, since whatever sits under it now this plan created — undoes to nothing rather than being marked irreversible (its forward statement is a no-op or fails before changing anything); a catalog entry that lacks what its restore needs — a hand-built catalog with no body AST, an index whose recorded DDL does not parse — is reported as `irreversible` with the reason, never thrown, so a partial diff literal in a test cannot break the planner.
