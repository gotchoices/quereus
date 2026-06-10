description: Hint-matched view AND index renames (quereus.previous_name / quereus.id) diff empty and apply as silent no-ops. Fix by resolving a body-unchanged hinted rename to drop(old) + recreate(declared) emitted from the views/indexes blocks, excluded from the require-hint counts. Recreate DDL must inverse-apply in-diff COLUMN renames (creates precede RENAME COLUMN in migration order) while keeping declared table names (table renames run first).
files:
  - packages/quereus/src/schema/schema-differ.ts            # views block ~429-453, indexes block ~513-557, require-hint guard ~570-577, reconciledDeclaredViewDefinition ~1025, declaredIndexCanonicalBody helpers ~897+, generateMigrationDDL renames comment ~1813-1826
  - packages/quereus/src/schema/rename-rewriter.ts          # renameColumnInAst / renameColumnInCheckExpression / renameColumnInInsertDefaults / collectFromTableNames — inverse rewriters to reuse
  - packages/quereus/src/emit/ast-stringify.ts              # createViewToString / createIndexToString (recreate DDL render; carries declared tags)
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic  # add view/index hinted-rename sections
  - docs/schema.md                                          # § Migration Order item 1 and § Rename Detection both state the (false-for-hinted) "fall back to drop+recreate via the standard buckets" claim
----

# Hinted view/index rename → drop+recreate (was: silent no-op)

## Verified reproduction (live engine, 2026-06-10 — all five confirmed)

1. **View hint rename, body unchanged** → `diff schema` = `[]`; after apply only
   `v_old` exists, `v_new` never materializes.
2. **Index hint rename, body unchanged** → same: `[]`, only `ix_old` survives.
   (The fix ticket's "indexes likely share the gap" is now verified.)
3. **View hint rename + non-hint tag drift** → also fully silent (the in-place
   `SET TAGS` branch requires a *name* match: `schema-differ.ts:446`, and for
   indexes `:550`).
4. **View hint rename + in-diff source COLUMN rename** → only the
   `RENAME COLUMN` emits; the view keeps its old name (its live body is rewritten
   to the new column by the rename propagation — correct, but the name never
   converges).
5. **Index hint rename + in-diff column rename** → same as 4.

## Mechanism (confirmed in code)

`resolveRenames` pairs the declared new name with the actual old object: the
declared side is matched (no create), the actual is consumed (no drop), and a
`RenameOp` with `kind: 'view' | 'index'` lands in `diff.renames` — but
`generateMigrationDDL` emits rename DDL only for `kind === 'table'`
(schema-differ.ts:1820-1826). The comment there ("caller emits drop+recreate via
the standard buckets") is true only for UNHINTED renames. With a hint, the
matched pair produces nothing anywhere. Body-CHANGED hinted renames already
resolve correctly to drop+recreate inside the views/indexes blocks; this ticket
makes the body-UNCHANGED case take the same shape.

## Design

In the views block (`schema-differ.ts` ~429) and indexes block (~513), after the
definition/body compare concludes "unchanged", detect the rename match
(`matchedActual.name.toLowerCase() !== name` — same discriminator the table path
uses at :377) and emit:

- `diff.viewsToDrop.push(matchedActual.name)` / `diff.indexesToDrop.push(...)`
  (drops run in the drop block, before creates — correct order), and
- a create of the declared object, rendered as described below, and
- increment the require-hint exclusion counter (`viewBodyRecreates` /
  `indexBodyRecreates` — consider renaming to `viewRecreates`/`indexRecreates`
  since they now cover rename recreates too). A hinted rename's drop+create pair
  is deliberate, not an ambiguous unhinted rename, so it must not trip
  `enforceRequireHint`.

This supersedes-into-one-shape with the existing body-change path, carries the
declared tags on the recreate (so repro case 3 falls out for free — and the
existing name-match-only condition on the `viewTagsChanges`/`indexTagsChanges`
branches stays correct: no double-emit), and keeps the `deny` policy untouched
(hints skipped ⇒ standard buckets already work). The no-op `kind:'view'/'index'`
ops remain in `diff.renames` as metadata; `generateMigrationDDL` ignores them
(leave a corrected comment there).

### The recreate render — ordering is load-bearing

`generateMigrationDDL` order: table renames → drops → creates (tables, views,
MVs, indexes) → table alters (where `RENAME COLUMN` lives). `CREATE VIEW` and
`CREATE INDEX` plan/validate their bodies at create time. Therefore the recreate
DDL must reference:

- **Declared (new) table names** — `ALTER TABLE … RENAME TO` has already run by
  the time creates execute; and
- **Actual (old) column names** for any column renamed in this same diff —
  `RENAME COLUMN` has NOT yet run; a body naming the new column fails to plan.
  After the create, the live column-rename propagation
  (`propagateColumnRename` in `runtime/emit/alter-table.ts` — rewrites dependent
  view/MV bodies, partial-index predicates, and indexed columns) rewrites the
  freshly created object's body, so the post-apply state and a re-diff converge.

So the render is a *column-only* inverse reconciliation of the declared stmt —
NOT the full `reconciledDeclaredViewDefinition` (that one also inverse-applies
table renames, which would name a table that no longer exists at create time).
Write small helpers near the existing reconcilers, e.g.:

```ts
/** Declared CreateViewStmt with in-diff COLUMN renames inverse-applied
 *  (NEW→OLD); table references untouched (renames-first ordering). */
function columnReconciledViewStmt(
	stmt: AST.CreateViewStmt,
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
): AST.CreateViewStmt
// clone select via cloneQueryExpr; for each [declTable, renames] call
// renameColumnInAst(clone, declTable, r.newName, r.oldName, schemaName) —
// seed with the DECLARED table name (qualifiers in the body are declared/new,
// unlike reconciledDeclaredViewDefinition where the table pass pre-normalized
// them to OLD). insertDefaults clause: inverse-map each entry's `column` via
// the FROM-table-scoped lookup and rewrite its expr, mirroring
// reconciledDeclaredViewDefinition's clause handling minus the table pass.

function columnReconciledIndexStmt(
	stmt: AST.CreateIndexStmt,
	colRenames: readonly ColumnRenameOp[],   // the index's own table's renames
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
): AST.CreateIndexStmt
// indexed-column bare names inverse-mapped NEW→OLD; partial WHERE expr cloned
// and inverse column-renamed (CHECK-expression entry point seeded with the
// declared table name) — reuse the walk shape of declaredIndexCanonicalBody
// but producing a stmt for createIndexToString (via applyIndexDefaults), not a
// canonical body string.
```

When no in-diff column renames touch the object, both helpers are identity —
the common case emits plain `createViewToString(stmt)` /
`createIndexToString(applyIndexDefaults(stmt, …))`. Fine to short-circuit on
`columnRenamesByTable.size === 0`.

Combined table+column rename sanity (all verified against migration order):
`ALTER TABLE t_old RENAME TO t_new` → `DROP VIEW v_old` →
`CREATE VIEW v_new AS select old_col from t_new` →
`ALTER TABLE t_new RENAME COLUMN old_col TO new_col` (propagation rewrites
v_new's body) → re-diff empty.

### Alternative considered and rejected (for now)

Adding `ALTER VIEW … RENAME TO` / `ALTER INDEX … RENAME TO` primitives (the
constraint-rename precedent) would avoid the render question entirely and, for
indexes, preserve the built structure instead of rebuilding. Rejected here:
much larger surface (parser → AST → planner → emit → schema manager → dependent
propagation for renamed views), and the differ already resolves the
body-CHANGED hinted rename to drop+recreate — one uniform shape is simpler.
The index-rebuild cost on a pure rename is the documented tradeoff; a future
primitive can replace the recreate without changing diff semantics.

## Expected behavior after fix

```sql
-- view: diff renders the convergence, apply leaves exactly the new name
diff schema main;   -- → DROP VIEW IF EXISTS v_old; CREATE VIEW v_new AS ...
apply schema main;  -- schema() lists v_new only; v_new queryable
diff schema main;   -- → []  (idempotent; hint tags stored verbatim are inert:
                    --        name match wins before hint resolution, and
                    --        tagsForDriftCompare strips the hint keys)
```

Same for indexes. Under `rename_policy = 'require-hint'`, a hinted view/index
rename applies cleanly (excluded counts). Hint via `quereus.id` behaves the same
(shared resolver).

## TODO

- Views block: rename-matched + body-unchanged → drop + column-reconciled
  recreate; count into the require-hint exclusion; update the block comment
  (its "tags ride the drop+recreate the standard buckets already drive" claim
  is the bug).
- Indexes block: same shape, using the index helper.
- Add `columnReconciledViewStmt` / `columnReconciledIndexStmt` helpers (reuse
  rename-rewriter walkers; clone — never mutate the declared stmt, it backs the
  declared-schema store).
- Correct the stale comment in `generateMigrationDDL`'s renames loop
  (non-table rename ops are metadata; the convergence DDL now comes from the
  view/index buckets even when hinted).
- sqllogic coverage in `50.2-declare-schema-renames.sqllogic` (new sections):
  view hint rename (diff DDL shape, apply, schema() shows new name only,
  re-diff empty); index hint rename (same, e.g. via index existence /
  still-used-in-plan or schema() type 'index'); view rename + non-hint tag
  drift (recreate carries tags, re-diff empty); view rename + in-diff column
  rename (apply succeeds, select through new view works, re-diff empty); index
  rename + in-diff column rename (apply succeeds, re-diff empty); hinted
  view+index rename under `options (rename_policy = 'require-hint')` applies
  without tripping the guard.
- docs/schema.md: fix § Migration Order item 1 and the § Rename Detection
  sentence "View and index renames … still fall back to drop+recreate via the
  standard buckets" to describe the hinted-rename recreate (and the
  column-reconciled render / propagation interplay in one line).
- Run `yarn test` (quereus package at minimum) + `yarn workspace @quereus/quereus run typecheck`.
