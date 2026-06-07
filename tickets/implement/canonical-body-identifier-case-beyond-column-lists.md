description: Case-fold the two remaining identifier-case channels in the schema-differ canonical bodies that still churn a spurious drop+recreate when a reference's case diverges between schema versions — (1) bare column-name references embedded inside CHECK expressions and partial-index WHERE predicates, and (2) the FK *referenced table* name — while leaving string/blob/numeric literals and collation names untouched. Builds on the completed `canonical-body-column-name-case-normalization` (column *lists* already fold).
files:
  - packages/quereus/src/emit/ast-stringify.ts            # NEW lowerExprIdentifiers helper; apply in lowercaseTableConstraintColumnNames (check case ~1410) + createIndexBodyToCanonicalString (~893); fold fk.table in canonicalForeignKeyClause (~1364)
  - packages/quereus/src/schema/ddl-generator.ts          # actual side — NO edit expected (indexToCanonicalDDL / constraintToCanonicalDDL / schemaConstraintToTableConstraint funnel through the shared renderers)
  - packages/quereus/src/schema/catalog.ts                # actual side — NO edit expected
  - packages/quereus/src/schema/schema-differ.ts          # NO edit expected (reconciledDeclaredBody composes: rename-reconcile then fold)
  - packages/quereus/test/declarative-equivalence.spec.ts # +CHECK-expr / partial-WHERE / FK-referenced-table case-divergence no-churn probes; +genuine-edit-still-recreates; +literal-preserved guard
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # +partial-index WHERE mixed-case column no-churn probe
  - docs/schema.md                                          # update the constraint (#438) deferral parenthetical + add FK-referenced-table + CHECK-expr fold note
----

# Canonical-body identifier-case normalization beyond column lists

## Background

The declarative differ detects a "name-matched object whose body changed" by
rendering a **canonical body string** on both the declared-AST side and the
actual-catalog side and comparing byte-equal. Quereus has **no case-sensitive
identifiers** — the AST never records identifier quoting and every resolver folds
via `.toLowerCase()` — so any identifier that renders case-preserving in the
canonical body is a latent spurious-churn channel: when a reference's case diverges
(across re-declares, or between the as-written reference and the stored definition),
the bodies compare unequal and the differ schedules a needless **drop+recreate**
(index / CHECK) or **drop+add** (FK) that never converges.

The completed prereq `canonical-body-column-name-case-normalization` folded bare
column-name identifiers in the canonical **column lists** (index columns; UNIQUE /
PK / FK local + referenced column lists) inside the canonical-only renderers
`createIndexBodyToCanonicalString` and `constraintBodyToCanonicalString`
(`ast-stringify.ts`). Both diff sides funnel through those two functions, so the
fold is automatically symmetric. This ticket closes the **two channels that pass
left explicitly out of scope**:

1. **Bare column-name references inside CHECK expressions and partial-index WHERE
   predicates** — these render via `expressionToString` (`column` / `identifier`
   node → `quoteIdentifier(expr.name)`), which preserves case.
2. **The FK *referenced table* name** (`fk.table` → `references <table>` in
   `foreignKeyClauseTail`) — case-preserving in the canonical FK body.

## Architecture / design (resolved)

### Both sides already funnel through the canonical renderers

Confirmed by reading the actual side: `ddl-generator.ts`'s `indexToCanonicalDDL`
lifts the stored `IndexSchema` into a minimal `CreateIndexStmt` (with
`where: indexSchema.predicate`) and calls `createIndexBodyToCanonicalString`;
`constraintToCanonicalDDL` lifts the stored constraint via
`schemaConstraintToTableConstraint` (CHECK → `expr: c.expr`; FK →
`table: c.referencedTable`) and calls `constraintBodyToCanonicalString`. The
declared side calls the same two functions over the declared AST. Therefore the
**entire fix lives inside those two canonical renderers** in `ast-stringify.ts`;
no edit to `schema-differ.ts` / `ddl-generator.ts` / `catalog.ts` is expected. Any
diff that touches the actual-side files to make a case test pass is a smell — the
fold belongs in the shared renderer so both sides stay symmetric by construction.

### Channel 2 — FK referenced table (trivial)

In `canonicalForeignKeyClause` (the canonical-only FK normalizer, called *only*
from `constraintBodyToCanonicalString`), lowercase the table:
`table: fk.table` → `table: fk.table.toLowerCase()`. The persistence FK render
path (`foreignKeyClauseTail` reached directly via `tableConstraintsToString` /
`columnConstraintsToString` in `generateTableDDL`) does **not** route through
`canonicalForeignKeyClause`, so stored DDL keeps original case. `quoteIdentifier`
still runs after the lowercase, so a reserved-word parent name re-quotes correctly
on both sides. Column-level FKs are lifted to table constraints (declared:
`columnConstraintToTableConstraint`; actual: `schemaConstraintToTableConstraint`)
before reaching here, so they are covered too. Self-referential FKs fold harmlessly.

### Channel 1 — column refs in CHECK / partial-WHERE expressions (clone + fold)

Add a **self-contained** `lowerExprIdentifiers(expr: AST.Expression):
AST.Expression` helper to `ast-stringify.ts` that returns a **structural clone**
with `column` and `identifier` node `name` / `table` / `schema` lowercased and
**everything else left exactly as-is** — `literal` (string / blob / number / JSON /
NULL `lexeme`), `parameter`, `cast.targetType`, `function.name`, `collate.collation`
all untouched. Mirror `expressionToString`'s node enumeration so every nested shape
(`binary` / `unary` / `function` / `cast` / `collate` / `case` / `in` / `between` /
`windowFunction` / `windowDefinition`) recurses and folds its inner column refs.

Apply it at the two canonical entry points only:

- **CHECK:** in `lowercaseTableConstraintColumnNames`, the `check` case currently
  returns `tc` unchanged — change it to
  `return tc.expr ? { ...tc, expr: lowerExprIdentifiers(tc.expr) } : tc;` so the
  fold happens inside `constraintBodyToCanonicalString` (which calls
  `lowercaseTableConstraintColumnNames` first, before the FK/CHECK default-form
  normalization). The subsequent `tableConstraintsToString([normalized])` then
  renders the *folded* expr via `expressionToString`.
- **Partial-index WHERE:** in `createIndexBodyToCanonicalString`, change
  `expressionToString(stmt.where)` → `expressionToString(lowerExprIdentifiers(stmt.where))`.

### Why a pre-pass clone, not a render-time flag

Threading a `lowerIdentifiers` flag through `expressionToString` was considered and
rejected: the CHECK render flows through the **shared** `tableConstraintsToString`,
which is *also* the persistence renderer (`generateTableDDL`,
`collectDeclaredNamedConstraints`'s `ddl`), so a flag would have to thread through
it too — widening the blast radius into the persistence path. The pre-pass clone
localizes the fold to the two canonical entry points and mirrors the prereq's
existing `lowercaseTableConstraintColumnNames` column-list cloning idiom.

### Why a self-contained walk, not `cloneExpr` / `transformExpr`

`emit/ast-stringify.ts` is imported by ~15 `planner/*` modules; importing
`planner/mutation/scope-transform` (`cloneExpr` / `transformExpr`) back into emit
would create a **module cycle**. So `lowerExprIdentifiers` is implemented locally in
`ast-stringify.ts`, co-located with `expressionToString` whose switch is the
authoritative node enumeration to mirror.

### Mutation safety (critical)

`lowerExprIdentifiers` MUST return a fresh clone and never mutate its input. On the
declared side the CHECK `tc.expr` is `DeclaredNamedConstraint.bodyAst.expr`, which
backs `d.ddl` / `d.definition`; on the actual side it is the stored schema's
`c.expr`; the partial-WHERE input is the live `indexSchema.predicate`. Building new
node objects on every recursion (`{ ...node, ...recursed }`) — and only overriding
`name`/`table`/`schema` on column/identifier nodes — guarantees no aliasing back to
the input. `literal.value` (a shared `Uint8Array` / JSON object / possible Promise)
is never recursed into or copied — the literal node is shallow-cloned and its
`value` passes through by reference (read-only at render), avoiding any corruption.

### Rename reconciliation composes

`reconciledDeclaredBody` (CHECK case) clones the expr, runs the case-insensitive
`renameColumnInCheckExpression` rewriter, then calls
`constraintBodyToCanonicalString(clone)` — which now folds afterward. Fold-after-
rename is correct: the rewriter matches on `.toLowerCase()` regardless of eventual
fold, and both sides end up lowercased, so a pure rename still reconciles to a
matching body and a genuine edit still differs. The FK case sets
`clone.foreignKey.table = tr.oldName` (actual catalog name); the downstream
`canonicalForeignKeyClause` lowercases it on both reconciled and non-reconciled
paths, so the comparison stays symmetric.

## Edge cases & interactions

- **`identifier` vs `column` node.** A bare ref may parse as either; fold both
  (mirror how `predicate-shape.ts`'s `columnIndexFromExpr` and `expressionToString`
  both handle the two). Fold `name` + `schema` on `identifier`; `name` + `table` +
  `schema` on `column`.
- **Qualified refs in CHECK** (`t.qty`, `main.t.qty`). Fold the qualifier(s) too —
  resolution is case-insensitive on every part, consistent with the rename
  rewriter's qualifier handling.
- **String / blob / numeric / JSON literals.** Must pass through byte-exact:
  `check (status = 'Active')` keeps `'Active'`; a literal-VALUE case change is NOT a
  body-change channel here but must NOT be corrupted into one either.
- **Collation names** (`col COLLATE NOCASE = …`). Already lowercased by the existing
  `collate` render (`quoteIdentifier(expr.collation.toLowerCase())`); the fold must
  not double-handle or alter the collation — leave `collate` nodes' `collation`
  alone and let the existing render lowercase it.
- **Function / cast.** `quoteFunctionName` / `cast` already lowercase the
  name/targetType; the fold leaves them untouched (no regression).
- **Subqueries in CHECK / partial-WHERE** (`subquery` / `exists` / `in (select …)`).
  Bounded limitation: pass the inner query through structurally (shallow clone, do
  NOT descend into `astToString`). This is symmetric on both diff sides (no NEW
  churn vs today) and CHECK/partial-WHERE subqueries are rare. Document the bound in
  the helper's doc comment; do not silently imply full coverage.
- **Reserved-word column in a CHECK/WHERE ref** (`"Order"`). Fold → `order` →
  `quoteIdentifier` → `"order"` identically on both sides.
- **FK referenced-table between-versions case change.** `referencedTable` is stored
  as-written (`constraint-builder` `referencedTable: fk.table`); a v2 re-declare
  with a different parent-name case converges after the fold.
- **Genuine body edits still recreate.** A changed predicate, a *different* FK
  target table (not just case), or a changed literal value must still differ → the
  fold collapses case only, never identity.
- **Persistence fixed-point unchanged.** `generateTableDDL`, `generateIndexDDL`,
  `tableConstraintsToString`, `foreignKeyClauseTail`, `createIndexToString`,
  `createTableToString` keep original case (the fold is confined to
  `constraintBodyToCanonicalString` / `createIndexBodyToCanonicalString`). The
  `emit-roundtrip-property` and `emit-roundtrip-positions` specs MUST stay green.

## Acceptance

- A CHECK constraint whose embedded column reference differs only in case from the
  column definition (and across re-declares) produces an empty diff (no
  `constraintsToDrop` / `constraintsToAdd` on that table).
- A partial-index WHERE whose column reference differs only in case from the column
  definition produces an empty diff (no `indexesToDrop` / `indexesToCreate`).
- An FK whose referenced-table reference differs only in case from the parent
  table's stored name produces an empty diff.
- String / numeric / blob literals and collation names in CHECK / WHERE bodies are
  preserved exactly (a literal-case change is not corrupted and not folded).
- Genuine body edits (changed predicate, changed FK target table, changed literal
  value) still drop+recreate.
- Canonical-comparison only: user-facing / persistence DDL keeps original case; the
  emit-roundtrip specs and persistence fixed-point tests stay green.

## Key tests (TDD — author confirmed-fail-without-fix where practical)

Mirror the prereq's case-fold block in `declarative-equivalence.spec.ts` (~line
2118 onward, `diffOf` + apply-then-rediff shape) and the partial-WHERE cases in
`index-ddl-roundtrip.spec.ts` (`diffIndexEdit` helper):

- **CHECK column-case divergence, no churn** — column declared `Qty`, CHECK
  `check (qty > 0)`; apply; re-diff ⇒ `tablesToAlter` empty. Expected: empty.
- **CHECK column-case change across re-declares, no churn** — apply
  `check (QTY > 0)`, re-declare `check (qty > 0)`; re-diff ⇒ no constraint
  drop/add. Expected: `constraintsToDrop`/`constraintsToAdd` absent.
- **CHECK literal preserved** — `check (status = 'Active')` re-declared verbatim ⇒
  no churn; AND a genuine literal-value edit (`'Active'` → `'active'`) DOES
  drop+recreate (proves the literal is compared, not folded). Expected: first
  empty, second one drop + one add.
- **Partial-index WHERE column-case divergence, no churn** — column `Active`,
  `index ix on t (id) where active = 1`; apply; re-diff ⇒ `indexesToDrop` /
  `indexesToCreate` empty. Expected: empty.
- **Partial-index WHERE genuine predicate edit still recreates** — guard the fold
  didn't over-collapse (`where active = 1` → `where active = 0`). Expected: drop +
  recreate (this case already exists for non-case edits — extend/confirm).
- **FK referenced-table case change across re-declares, no churn** — apply
  `references Parent(pid)`, re-declare `references parent(pid)` (parent table named
  `parent`); re-diff ⇒ child `tablesToAlter` has no FK drop/add. Expected: child
  alter undefined / no constraint churn.
- **FK referenced-table genuine retarget still recreates** — `references parent(...)`
  → `references other(...)` (a real different table). Expected: drop old FK + add new.
- **End-to-end apply convergence** — a CHECK with a case-divergent ref applies once,
  enforces, and a verbatim re-declare yields neither a diff nor any
  `generateMigrationDDL` output (mirror the prereq's "no spurious migration DDL
  executes" probe).
- **Reserved-word column ref in CHECK/WHERE** — `check ("Order" > 0)` (or partial
  WHERE) re-quotes to `"order"` on both sides, no churn.

## TODO

- Add `lowerExprIdentifiers(expr)` to `ast-stringify.ts`: self-contained structural
  clone folding `column`/`identifier` `name`/`table`/`schema`; literals/params/
  collation/cast/function untouched; subqueries passed through structurally
  (documented bound); never mutates input.
- Apply `lowerExprIdentifiers` in `lowercaseTableConstraintColumnNames` `check` case
  and in `createIndexBodyToCanonicalString`'s `where` render.
- Lowercase `fk.table` in `canonicalForeignKeyClause`.
- Add the CHECK / partial-WHERE / FK-referenced-table / literal-preserved /
  genuine-edit / reserved-word / end-to-end tests above.
- Update `docs/schema.md`: remove the "(Column references inside CHECK *expressions*
  are not yet folded …)" deferral in the constraint section (#438), add the
  CHECK-expr + FK-referenced-table fold note, and note the index partial-WHERE fold
  in the index section (#440).
- Run `yarn workspace @quereus/quereus test` (stream with `Tee-Object`), then
  `tsc --noEmit` and `eslint` on changed files. If a failure is plainly unrelated /
  pre-existing, follow the `.pre-existing-error.md` flag protocol rather than chasing
  it. `yarn test:store` is optional (this change touches only in-memory canonical
  comparison renderers, not the persistence DDL path) — note the deferral in the
  handoff if skipped.
