description: Rewrite `insert defaults` clauses (plain views AND materialized views) during ALTER TABLE RENAME COLUMN / RENAME TO propagation — d.column on base-column rename, d.expr subquery refs on table/column rename — and fix the change-gating so a clause-only rewrite still fires view_modified / materialized_view_modified.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts            # propagateTableRenameInSchema view loop (~1345), propagateColumnRenameInSchema view loop (~1463), resolveColumnInSource built at ~1425
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # propagateTableRenameToMaterializedViews (~627), propagateColumnRenameToMaterializedViews (~668), applyMaterializedViewRewrite (~707)
  - packages/quereus/src/schema/rename-rewriter.ts              # add clause rewriters next to renameTableInAst / renameColumnInAst / renameColumnInCheckExpression
  - packages/quereus/src/schema/schema-differ.ts                # collectFromTableNames (~989) — move/export for reuse; reconciledDeclaredViewDefinition (~1049) is the inverse-direction precedent
  - packages/quereus/src/schema/view.ts                         # ViewSchema.insertDefaults / MaterializedViewSchema.insertDefaults (shape: AST.ViewInsertDefault { column, expr })
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts       # RENAME describe blocks at ~550 (views) and ~635 (MVs)
----

# Rewrite `insert defaults` clauses on source rename propagation

## Reproduced failure modes (all verified live, 2026-06-10)

```sql
-- 1. d.column stale after RENAME COLUMN (plain view; dominant projected-away case)
create table t3 (id integer primary key, name text, created integer not null);
create view v3 as select id, name from t3 insert defaults (created = 99);
alter table t3 rename column created to created_at;
insert into v3 values (1, 'x');
-- ✗ cannot write through view 'v3': 'insert defaults (created = …)' names column 'created' …

-- 2. d.expr subquery table ref stale after RENAME TO
create table audit (c integer primary key);
create table t4 (id integer primary key, ts integer not null);
create view v4 as select id from t4 insert defaults (ts = (select max(c) from audit));
alter table audit rename to audit2;
insert into v4 values (10);
-- ✗ Table 'audit' not found in schema path: main

-- 3. MV clause-only skip: body does NOT project the defaulted column, so
--    propagateColumnRenameToMaterializedViews `continue`s before any rewrite
create table t5 (id integer primary key, name text, created integer not null);
create materialized view mv5 as select id, name from t5 insert defaults (created = 55);
alter table t5 rename column created to created_at;
insert into mv5 values (2, 'y');
-- ✗ same tag-target-not-found error; mv5.insertDefaults and regenerated DDL still carry 'created'
```

Failure mode 3 generalizes: BOTH the plain-view loops (`changed` flag derives only
from the body rewrite) and the MV propagations (`continue` when the body AST didn't
change) skip a view whose body never mentions the renamed column — which is exactly
the dominant `insert defaults` use case (defaulting a projected-away NOT NULL
column). So the fix is two-part: rewrite the clause, AND fold clause changes into
each loop's "did anything change" gate.

## Root cause

`propagateTableRenameInSchema` / `propagateColumnRenameInSchema`
(runtime/emit/alter-table.ts) and `propagate{Table,Column}RenameToMaterializedViews`
(runtime/emit/materialized-view-helpers.ts) rewrite only `selectAst`. The
`insertDefaults` clause (`ViewSchema.insertDefaults` /
`MaterializedViewSchema.insertDefaults`, shape `AST.ViewInsertDefault { column:
string; expr: Expression }`) is never touched, so:

- `d.column` (names a base column of the view's FROM table) goes stale on RENAME
  COLUMN and the write-through rewrite errors at
  `resolveDefaultForColumn` (planner/mutation/single-source.ts:740).
- `d.expr` subquery-internal table/column refs go stale on RENAME TO / RENAME
  COLUMN (top-level column refs cannot occur in the expr — it is appended to
  VALUES rows — but subquery refs are legal).
- The regenerated DDL (`generateViewDDL` / `generateMaterializedViewDDL`, both in
  schema/ddl-generator.ts, read `insertDefaults`) re-persists the stale name, and
  `applyMaterializedViewRewrite` hashes `mv.insertDefaults` verbatim into
  `bodyHash` (materialized-view-helpers.ts:724).

## Design

### Shared clause rewriters (schema/rename-rewriter.ts)

Add two helpers next to the existing AST rewriters, mirroring the inverse-direction
logic the differ already hand-rolls in `reconciledDeclaredViewDefinition`
(schema-differ.ts:1072–1090 — read it; it is the semantic spec for scoping):

```ts
/** Table rename: descend into each d.expr (d.column never changes on a table
 *  rename). Mutates exprs in place; returns whether anything changed. */
export function renameTableInInsertDefaults(
	defaults: ReadonlyArray<AST.ViewInsertDefault> | undefined,
	oldName: string, newName: string, defaultSchemaName: string,
): { defaults: ReadonlyArray<AST.ViewInsertDefault>; changed: boolean } | null;  // null when defaults empty/undefined

/** Column rename: rewrite d.column when the renamed table is one of the view's
 *  FROM tables (the clause targets base columns of the FROM table); descend into
 *  d.expr — seeded CHECK-style when the renamed table is a FROM table (the expr
 *  evaluates in base-row context, exactly like a CHECK), plain scope-aware
 *  renameColumnInAst otherwise (catches subquery refs to unrelated tables, e.g.
 *  failure mode 2's column analogue). */
export function renameColumnInInsertDefaults(
	defaults: ReadonlyArray<AST.ViewInsertDefault> | undefined,
	fromTables: ReadonlySet<string>,           // lowercased FROM-table names of the view body
	tableName: string, oldCol: string, newCol: string,
	defaultSchemaName: string,
	resolveColumnInSource?: ResolveColumnInSource,
): { defaults: ReadonlyArray<AST.ViewInsertDefault>; changed: boolean } | null;
```

Per-entry column-rename behavior (forward mirror of the differ's inverse):
- `d.column`: if `tableName` (lowercased; same-schema gate is the caller's) ∈
  `fromTables` and `d.column` equals `oldCol` case-insensitively → replace entry
  with `{ ...d, column: newCol }`.
- `d.expr`: if `tableName` ∈ `fromTables` →
  `renameColumnInCheckExpression(d.expr, tableName, oldCol, newCol, defaultSchemaName, resolveColumnInSource)`
  (the seed binding mirrors the differ and CHECK/index-predicate handling); else →
  `renameColumnInAst(d.expr, tableName, oldCol, newCol, defaultSchemaName)`.

Exprs are mutated in place (consistent with the body `selectAst` handling and the
existing event-payload comments — `oldObject` shares the rewritten AST); the
returned array is fresh only so changed `column` strings can be swapped without
mutating the frozen entries.

`fromTables` comes from `collectFromTableNames` (schema-differ.ts:989) — currently
module-private; export it from schema-differ.ts or move it into rename-rewriter.ts
(better: move — it is a rename-scoping concern; update the differ's import). No
ordering hazard on the forward path: a column rename never changes table names, so
it can be collected before or after the body rewrite (the differ's inverse path
needed it collected first; keep its semantics intact).

### Call sites

1. **Plain views, table rename** — `propagateTableRenameInSchema` view loop
   (alter-table.ts:1345): `const bodyChanged = renameTableInAst(view.selectAst, …)`;
   clause via `renameTableInInsertDefaults`. When either changed, build
   `updatedView = { ...view, insertDefaults: <new array if clause changed>, sql: astToString(view.selectAst) }`,
   `schema.addView`, fire the existing single `view_modified` (do NOT add a second
   event).
2. **Plain views, column rename** — `propagateColumnRenameInSchema` view loop
   (alter-table.ts:1463): same shape with `renameColumnInInsertDefaults`;
   `resolveColumnInSource` is already built in `propagateColumnRename`
   (alter-table.ts:1425) and threaded into this function — pass it through.
   `fromTables` is computed per view from its `selectAst`.
3. **MVs, table rename** — `propagateTableRenameToMaterializedViews`
   (materialized-view-helpers.ts:627): clause rewrite alongside the body rewrite;
   extend the processed gate to
   `if (!bodyChanged && !clauseChanged && !mv.sourceTables.includes(oldBase)) continue;`
   pass the rewritten defaults to `applyMaterializedViewRewrite` via `overrides`.
4. **MVs, column rename** — `propagateColumnRenameToMaterializedViews`
   (materialized-view-helpers.ts:668): replace the
   `if (!renameColumnInAst(…)) continue` early-out with separate `bodyChanged` /
   `clauseChanged` flags; continue only when neither. Call
   `applyMaterializedViewRewrite(…, { insertDefaults }, preStale, /*renamedColumns*/ bodyChanged)`
   — a clause-only change cannot shift backing output names, so
   `renameShiftedBackingColumns` must not run for it. Thread
   `resolveColumnInSource` down from the alter-table caller (or rebuild it from
   `db.schemaManager` locally — match however the plain-view loop ends up getting
   it; keep it one construction if practical).
5. **`applyMaterializedViewRewrite`** (materialized-view-helpers.ts:707): widen
   `overrides` to `Partial<Pick<MaterializedViewSchema, 'sourceTables' | 'covers' | 'insertDefaults'>>`
   and compute `bodyHash` from the POST-override clause (today line 724 reads
   `mv.insertDefaults`; it must read the updated value or the hash and the
   regenerated DDL disagree). `generateMaterializedViewDDL(updated)` (line 726)
   then picks the rewritten clause up automatically. Update the function's
   doc-comment (it documents the override set).

### What falls out for free once the catalog object is updated

- Store re-persistence: the `view_modified` / `materialized_view_modified`
  listeners regenerate DDL via `generateViewDDL` / `generateMaterializedViewDDL`,
  which read `insertDefaults` from the updated object.
- `view_info` insertability/defaultable derivation (func/builtins/schema.ts:861)
  reads `view.insertDefaults` from the catalog.
- Write-through (`single-source.ts:740`) reads `view.insertDefaults` per plan.
- The differ's `reconciledDeclaredViewDefinition` (inverse direction, for
  declarative diffs against a not-yet-renamed catalog) already handles the clause
  — no differ change needed; optionally refactor it onto the new helpers
  (inverse args, clones instead of in-place) ONLY if it stays behavior-identical —
  its expr handling pre-clones and its column scoping must collect `fromTables`
  before the inverse table pass. Skip the refactor if it gets awkward.

## Expected behavior (acceptance)

- Failure modes 1–3 above all succeed after the rename: the insert lands, the
  default value arrives in the renamed base column.
- Column rename descends into `d.expr` subqueries (e.g.
  `insert defaults (ts = (select max(c) from audit))` + `alter table audit rename column c to c2`).
- A clause-only rewrite (body untouched) fires exactly one `view_modified` /
  `materialized_view_modified` and the regenerated DDL carries the new name.
- MV `bodyHash` after a clause rewrite equals
  `computeBodyHash(viewDefinitionToCanonicalString(columns, selectAst, rewrittenDefaults))`
  — i.e. matches what the differ recomputes from the post-rename declared form.
- `view_info` insertability for the affected view stays `YES` and the defaulted
  column resolves (no silent skip).
- Pre-existing staleness discipline unchanged: a pre-stale MV still gets its
  clause/sql/hash rewritten but is not re-registered (existing
  `applyMaterializedViewRewrite` structure already does this — keep it).

## TODO

- Move (or export) `collectFromTableNames` from schema-differ.ts for reuse; keep
  the differ compiling and behavior-identical.
- Add `renameTableInInsertDefaults` / `renameColumnInInsertDefaults` to
  schema/rename-rewriter.ts per the design above.
- Wire call sites 1–4 (plain-view loops in alter-table.ts; MV propagations in
  materialized-view-helpers.ts), folding clause changes into each change gate.
- Widen `applyMaterializedViewRewrite` overrides with `insertDefaults`; hash and
  DDL-generate from the post-override clause; pass `renamedColumns: bodyChanged`.
- Logic tests in 41.3-alter-rename-propagation.sqllogic (plain views): rename the
  defaulted projected-away base column → insert through view succeeds with the
  default landing; RENAME TO of a table inside `d.expr` subquery → insert
  succeeds; column rename inside a `d.expr` subquery; `view_info` insertability
  stays `YES` after the rename.
- Logic tests in 53.2-materialized-view-rename-propagation.sqllogic: the MV
  clause-only case (body does not project the defaulted column) — rename column,
  insert through MV succeeds; MV body+clause combined case.
- Spec tests in view-mv-ddl-persistence.spec.ts RENAME describe blocks (~550
  plain views, ~635 MVs): clause-only rename fires the modified event once and
  the re-persisted DDL carries the new name (cover both RENAME COLUMN on
  `d.column` and RENAME TO inside `d.expr`).
- Run `yarn test` (root) + `yarn workspace @quereus/quereus lint`; update
  docs/view-updateability.md § View insert defaults (and/or docs/schema.md rename
  propagation notes) to state the clause rides rename propagation.
