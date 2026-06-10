<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-10T14:21:46.385Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\view-insert-defaults-declarative-drift-undetected.implement.2026-06-10T14-21-46-385Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Declarative differ misses view definition drift — a name-matched plain view's body or `insert defaults` clause change diffs empty (stale defaults survive apply silently), and an MV's clause/explicit-columns change diffs empty (bodyHash covers `stmt.select` only). Fix: canonical view-definition compare (mirroring the index `definition` pattern) with in-diff rename reconciliation, and fold clause+columns into the MV canonical body.
files:
  - packages/quereus/src/schema/schema-differ.ts        # views block (~408-423), MV block (~425-450), require-hint (~512-516); precedents: index body loop (~452-506), reconciledDeclaredBody (~1084)
  - packages/quereus/src/schema/catalog.ts              # CatalogView (~51) gains `definition`; viewSchemaToCatalog (~282); CatalogIndex.definition doc (~65) is the model
  - packages/quereus/src/emit/ast-stringify.ts          # insertDefaultsClauseToString (~1066, currently private); createViewToString (~1072); new exported canonical view-definition renderer
  - packages/quereus/src/schema/view.ts                 # ViewSchema { selectAst, columns, insertDefaults } / MaterializedViewSchema.bodyHash; computeBodyHash doc (~149)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # bodyHash stamping at creation (~311) and applyMaterializedViewRewrite (~715)
  - packages/quereus/src/schema/rename-rewriter.ts      # renameTableInAst (~70), renameColumnInAst (~269) — reuse for inverse reconciliation (read-only)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic      # round-trip clause case ~1052-1093; name-matched view cases ~284-390
  - packages/quereus/test/schema-differ.spec.ts         # hand-built SchemaCatalog literals (views: [] today)
  - packages/quereus/test/declarative-equivalence.spec.ts          # bodyHash relative-behavior assertions ~1272, ~1430
  - docs/schema.md                                      # §~549 constraint body drift / §~553 index body drift (the prose model); §~561 currently says views get tag drift only
----

# Detect view body / `insert defaults` drift in the declarative differ

## Verified reproduction (live engine, 2026-06-10)

All three axes confirmed by direct run:

- **View clause change** (`insert defaults (created = 111)` → `222` on a name-matched
  view): `diff schema` → `[]`; after `apply`, an insert through the view still writes
  the OLD default 111 — silent.
- **View body change** (added `where id > 0`, same name): `diff schema` → `[]`.
- **MV clause change** (same body, clause `111` → `222`): `diff schema` → `[]` —
  `bodyHash` is computed over `astToString(stmt.select)` only, so the clause is
  invisible to the hash and `tagsDrifted` (the clause is not a tag).

Soft regression: the deprecated `quereus.update.default_for.<col>` view-DDL tag this
clause replaces WAS part of `tags`, so its drift was caught by `tagsDrifted` → in-place
`SET TAGS`. Migrating tag → clause (the documented direction) loses drift detection.

## Mechanism

- Views block (`schema-differ.ts` ~408-423): name-matched views check only
  `tagsDrifted`. `CatalogView` is `{ name, ddl, tags }` — no comparable body.
- MV block (~431-447): `computeBodyHash(astToString(declaredMv.viewStmt.select))` vs
  live `bodyHash` — clause and explicit column list (`mv(a, b)`) are both outside the
  hashed text (an explicit-columns-only change is equally undetected, and it renames
  the backing-table columns, so it is definitional).

The live side already has everything needed without re-parsing DDL: `ViewSchema` and
`MaterializedViewSchema` both carry `selectAst`, `columns`, and `insertDefaults`
(parsed clause), and `collectSchemaCatalog` builds catalog entries straight from them.

## Design (mirror the index `definition` pattern — docs/schema.md §index-body-changes)

### Canonical view definition (one shared renderer)

Export from `ast-stringify.ts` a canonical view-definition renderer covering the three
definitional parts, name/schema/tags excluded:

```
viewDefinitionToCanonicalString(
	columns: ReadonlyArray<string> | undefined,      // explicit column list, e.g. v(a, b)
	select: AST.QueryExpr,                            // astToString(select)
	insertDefaults: ReadonlyArray<AST.ViewInsertDefault> | undefined,  // reuse the private insertDefaultsClauseToString
): string
```

Both diff sides funnel through it: the actual side from live schema fields, the
declared side from `viewStmt` fields. Both ASTs come from the same parser and render
through the same emitter, so keyword case/whitespace cannot churn. **No identifier
case-folding** (deliberate asymmetry vs the constraint/index canonical bodies, which
fold because their recreates re-validate/rebuild): a case-only edit recreates a plain
view (free — data-less) and rebuilds an MV (pre-existing behavior of the select-only
hash; no regression). Document the asymmetry next to the constraint/index case-folding
prose in docs/schema.md.

### Plain views

- `CatalogView` gains `definition: string` (doc-comment modeled on
  `CatalogIndex.definition`), populated in `viewSchemaToCatalog` via the shared
  renderer over `viewSchema.columns / selectAst / insertDefaults`.
- Views block: for every **matched** view (name-matched AND rename-matched — mirroring
  the index loop), compare the declared canonical definition against
  `matchedActual.definition`:
  - equal → existing behavior (tag drift → `SET TAGS`, pure name match only);
  - differs → re-compare a **rename-reconciled** declared definition (below); still
    differs → `viewsToDrop.push(matchedActual.name)` +
    `viewsToCreate.push(createViewToString(declaredView.viewStmt))`, increment
    `viewBodyRecreates`, and **skip** the `SET TAGS` push (the recreate carries the
    declared tags — same mutual exclusion as MV/index).
- `enforceRequireHint('view', creates - viewBodyRecreates, drops - viewBodyRecreates)`
  — a body recreate is a deliberate drop+create, not an ambiguous rename (exactly the
  `indexBodyRecreates` exclusion).
- A body-changed rename-matched view resolves to drop(actual old name) +
  create(declared new name) — strictly better than today (a hint-matched view rename is
  currently a silent no-op at apply; see backlog `view-rename-hint-silent-noop`).

### In-diff rename reconciliation (correctness-critical, not just churn)

`CREATE VIEW` **plans its body at create time** (`planViewBody` → `buildSelectStmt`),
and `generateMigrationDDL` emits creates (~1710) BEFORE the table-alter block (~1727)
where `RENAME COLUMN` lives. So without reconciliation, a diff containing a hinted
column rename plus a name-matched dependent view would emit a view recreate whose body
references the NEW column name — and the CREATE VIEW fails at apply because the rename
has not run yet. (Whole-TABLE renames are safe — they emit first, ~1675.)

Mirror `reconciledDeclaredBody` (constraints, ~1084) / `declaredIndexCanonicalBody`:
short-circuit the raw-equal compare; only on mismatch, clone the declared view
definition AST and inverse-apply the in-diff renames (new → old), then re-render and
re-compare:

- table renames: `renameTableInAst(cloneSelect, r.newName, r.oldName, schemaName)` for
  ALL `tableRenames.renames` (clone the select first — the rewriters mutate in place;
  see `cloneExpr` usage in the constraint path; a QueryExpr needs a structural clone,
  e.g. `structuredClone`-style helper or JSON-free deep clone consistent with codebase
  conventions);
- column renames: `renameColumnInAst(cloneSelect, tableName, r.newName, r.oldName,
  schemaName)` per entry of `columnRenamesByTable` (already built in scope, keyed by
  declared/new table name) — apply table-rename inversion FIRST, then seed the column
  rewrites with the OLD table name (resolve via `tableRenames`), exactly the ordering
  `reconciledDeclaredBody` documents;
- the `insert defaults` clause: `d.column` names a **base-table column** (often
  projected away, so the select rewrite cannot catch it) — inverse-rename it via the
  base table's column renames (the view's FROM table); `d.expr` may embed table refs /
  columns — run the same expression-level inverse rewriters over a cloned expr.
  (Sibling fix ticket `view-insert-defaults-not-rewritten-on-source-rename` is the
  forward/live-rename analogue; no prereq — the differ reconcile compares declared
  against the actual catalog as it stands either way.)

When the reconciled definition matches the actual, emit only the rename ops (no
recreate). A genuine body edit layered on a rename still recreates.

Known residual hazard (document, don't solve): a **genuine** view-body edit that also
references a column renamed in the same diff still emits CREATE VIEW before the RENAME
COLUMN and fails at apply — same create-before-alter ordering MV rebuilds already have.
Note it in docs/schema.md; if trivial to fix by emitting view/MV creates after the
table-alter block, that may be considered, but it is NOT required here.

### Materialized views

Redefine the MV canonical body as the SAME shared renderer output
(`viewDefinitionToCanonicalString(columns, select, insertDefaults)`) and hash THAT at
all three `bodyHash` sites so they cannot drift:

- creation stamping (`materialized-view-helpers.ts` ~311) — keep `def.bodySql`
  (executable select-only SQL) for `collectBodyRows` / `linkCoveredUniqueConstraints`;
  hash the canonical definition separately;
- `applyMaterializedViewRewrite` (~715) — likewise, `bodySql` still feeds
  `renameShiftedBackingColumns`;
- the differ's declared side (~436).

Consequences (all acceptable — project explicitly defers back-compat):

- a clause-only or explicit-columns-only change now hashes differently → drop+recreate
  (re-materialize), exactly as a body change does today; tag-only drift keeps the
  in-place `SET TAGS` path untouched;
- persisted MVs whose stored `bodyHash` predates the formula change re-hash differently
  IF they carry a clause or explicit columns → one-time rebuild on next apply;
- `bodyHash` is consumed ONLY by the differ path plus relative-behavior test
  assertions (changes on body rewrite — `mv-rename-propagation.spec.ts`; stable under
  tag mutation — `schema-manager.spec.ts` ~411/~508, `declarative-equivalence.spec.ts`
  ~1430) — all still hold under the new formula. Update the `computeBodyHash` /
  `MaterializedViewSchema.bodyHash` doc-comments (view.ts ~88, ~149) and the
  `docs/schema.md` ~46 mention to say "canonical definition (columns + body +
  insert-defaults clause)".

Optionally reuse the same reconcile helper before hashing the declared MV side so an
in-diff source rename stops churning a spurious MV rebuild (pre-existing churn,
hash-compare has never reconciled) — include if it falls out of the shared helper
naturally; otherwise leave and note.

## Pitfalls / references

- `insertDefaultsClauseToString` (ast-stringify ~1066) is module-private today —
  export it or wrap it inside the new canonical renderer.
- Hand-built `SchemaCatalog` literals in tests use `views: []` almost everywhere
  (`schema-differ.spec.ts` ~21/~217, `test/schema/differ-alter-column.spec.ts` ~37,
  `view-mv-ddl-persistence.spec.ts` ~402 builds a `CatalogMaterializedView` with
  `bodyHash: ''`) — adding a required `CatalogView.definition` field should compile
  clean, but verify.
- Existing name-matched-view sqllogic cases must keep diffing empty under the new
  compare: 50-declarative-schema.sqllogic ~284-390 (views over `users`/`posts`,
  explicit-columns view `user_summary`), ~908-982 (compound-select bodies in non-main
  schema), ~1052-1093 (clause round-trip + converged re-diff `[]`). Both sides render
  from parser ASTs through one emitter, so they should — run the full suite.
- The index canonical-body collation/case lessons (docs/schema.md §~553) do NOT apply
  to view bodies: views have no inherited per-column collation to resolve, and no
  case-folding is performed (see Design).
- `test/util/schema-equivalence.ts` (~239-252) compares `bodyHash` between direct-DDL
  and applied-declarative MVs — both sides go through the same new formula, stays green.

## TODO

Phase 1 — canonical definition + plain-view drift
- Export the canonical view-definition renderer from ast-stringify (columns + select +
  insert-defaults clause; name/schema/tags excluded); reuse `insertDefaultsClauseToString`.
- Add `CatalogView.definition`, populated in `viewSchemaToCatalog`; doc-comment
  modeled on `CatalogIndex.definition`.
- Views block: matched-view definition compare → reconcile → drop+recreate; track
  `viewBodyRecreates`; suppress `SET TAGS` on recreate; subtract recreates in
  `enforceRequireHint('view', …)`.
- Reconcile helper: inverse table renames + per-table inverse column renames over a
  cloned declared select, plus the insert-defaults clause (`d.column` via the base
  table's renames, `d.expr` via the expression rewriters).

Phase 2 — MV canonical body
- Hash the shared canonical definition at all three bodyHash sites; keep executable
  `bodySql` separate where it feeds execution/backing-column derivation.
- Update bodyHash doc-comments (view.ts, catalog.ts) and docs/schema.md ~46.

Tests (50-declarative-schema.sqllogic unless noted)
- View drift: clause changed / clause added / clause removed / body changed — each
  asserting the diff renders DROP VIEW + CREATE VIEW and a post-apply write-through
  uses the NEW default (clause cases) / new body filters (body case); converged
  re-diff `[]`.
- MV drift: clause changed → diff renders DROP MATERIALIZED VIEW + CREATE; post-apply
  write-through uses the NEW default; tag-only change still takes SET TAGS (existing
  case must stay green).
- Reconciliation: hinted in-diff column rename + name-matched dependent view whose
  body (and/or clause) references the renamed column → diff emits ONLY the rename
  ops, no view recreate, and apply succeeds; same for a hinted table rename. (Use
  50.2-declare-schema-renames.sqllogic if a better fit.)
- require-hint: a view body recreate under `rename_policy = 'require-hint'` does not
  trip the unhinted-rename guard.
- Unit coverage in schema-differ.spec.ts for the new views-block branches if the
  sqllogic cases leave gaps.

Wrap-up
- Update docs/schema.md: view/MV body-drift subsection parallel to the constraint
  (§~549) / index (§~553) prose; correct §~561 ("views: tag drift only"); note the
  no-case-folding asymmetry and the create-before-alter residual hazard.
- `yarn test`, `yarn workspace @quereus/quereus run lint`, `yarn workspace
  @quereus/quereus run typecheck`.
