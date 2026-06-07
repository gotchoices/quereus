description: Case-fold the two remaining identifier-case channels in the schema-differ canonical bodies — (1) bare column refs inside CHECK expressions + partial-index WHERE predicates, and (2) the FK referenced (parent) TABLE name — so a case-only divergence no longer churns a spurious drop+recreate (index/CHECK) or drop+add (FK). String/blob/numeric/JSON literals and collation names stay byte-exact. Builds on the merged `canonical-body-column-name-case-normalization` (column *lists* already fold). Implemented; build + tests green; ready for adversarial review.
files:
  - packages/quereus/src/emit/ast-stringify.ts            # NEW lowerExprIdentifiers (~450) + window-fold helpers; applied in lowercaseTableConstraintColumnNames check case (~1523) and createIndexBodyToCanonicalString where render (~997); fk.table.toLowerCase() in canonicalForeignKeyClause (~1474)
  - packages/quereus/src/schema/ddl-generator.ts          # actual side — UNCHANGED (indexToCanonicalDDL / constraintToCanonicalDDL / schemaConstraintToTableConstraint funnel through the shared renderers)
  - packages/quereus/src/schema/catalog.ts                # actual side — UNCHANGED
  - packages/quereus/src/schema/schema-differ.ts          # UNCHANGED (reconciledDeclaredBody composes: rename-reconcile then fold)
  - packages/quereus/src/schema/constraint-builder.ts     # reference only — referencedTable: fk.table stored AS-WRITTEN (confirms the FK-table channel is between-versions)
  - packages/quereus/test/declarative-equivalence.spec.ts # +7 tests in the "named-constraint body change (drop+recreate)" describe (~line 2208 onward)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # +1 partial-WHERE column-case no-churn probe (~line 430)
  - docs/schema.md                                         # constraint (#438) + index (#440) body-change fold notes updated
----

# Canonical-body identifier-case normalization beyond column lists — review handoff

## What shipped (one idea)

The declarative differ decides "name-matched object whose body changed" by rendering a
**canonical body string** on both the declared-AST side and the actual-catalog side and
comparing byte-equal. Quereus has no case-sensitive identifiers (the AST never records
quoting; every resolver folds via `.toLowerCase()`), so any identifier that renders
case-preserving in the canonical body is a latent spurious-churn channel. The merged prereq
folded the canonical **column lists**. This ticket closes the two channels it left out of
scope, entirely inside the **shared canonical renderers** in `ast-stringify.ts`:

1. **Bare column refs inside CHECK expressions and partial-index WHERE predicates.** New
   self-contained `lowerExprIdentifiers(expr)` returns a structural clone with `column` /
   `identifier` node `name` / `table` / `schema` lowercased and everything else byte-exact —
   literals (`value` / `lexeme`), parameters, `cast.targetType`, `function.name`,
   `collate.collation` all untouched. It mirrors `expressionToString`'s full node enumeration
   (binary / unary / function / cast / collate / case / in / between / windowFunction /
   windowDefinition + frame bounds). Applied at the CHECK channel via
   `lowercaseTableConstraintColumnNames`'s new `check` case, and at the partial-WHERE channel
   via `createIndexBodyToCanonicalString`'s `where` render.
2. **FK referenced (parent) TABLE name.** `canonicalForeignKeyClause` now lowercases
   `fk.table`. `quoteIdentifier` still runs after, so a reserved-word parent name re-quotes
   correctly on both sides.

Persistence renderers (`tableConstraintsToString`, `foreignKeyClauseTail`,
`generateTableDDL`, `createIndexToString`, `generateIndexDDL`) are **untouched** — stored DDL
keeps its declared casing. Both diff sides funnel through the two canonical renderers, so the
fold is symmetric by construction; **no edit to `ddl-generator.ts` / `catalog.ts` /
`schema-differ.ts`** (verify this in review — an actual-side edit to pass a case test is a smell).

## Why a pre-pass clone (not a render-time flag / not cloneExpr)

A `lowerIdentifiers` flag on `expressionToString` would have to thread through the **shared**
`tableConstraintsToString`, which is also the persistence renderer — widening the blast radius
into the persistence path. The pre-pass clone localizes the fold to the two canonical entry
points. `cloneExpr` / `transformExpr` live in `planner/mutation/scope-transform`, which
imports back into `emit` would cycle (`emit/ast-stringify.ts` is imported by ~15 planner
modules), so the walk is implemented locally, co-located with `expressionToString`.

## Mutation safety (the critical invariant — please scrutinize)

`lowerExprIdentifiers` MUST never mutate its input: on the declared side the CHECK `tc.expr`
is `DeclaredNamedConstraint.bodyAst.expr` (backs `d.ddl` / `d.definition`); on the actual side
it is the stored schema's `c.expr`; the partial-WHERE input is the live
`indexSchema.predicate`. Every folded node is rebuilt as a fresh object (`{ ...node,
...recursed }`); identifier-free / pass-through nodes (`literal` / `parameter` / `subquery` /
`exists`) are returned **as-is** (read-only at render, never mutated, so aliasing the input
subtree is safe) — a `literal.value` (possibly-shared `Uint8Array` / JSON / Promise) is never
recursed into or copied.

## Bounded limitation (documented, intentional)

Subquery bodies inside CHECK / partial-WHERE (`subquery` / `exists` / `in (select …)`) pass
through **structurally** — the inner query is not descended into. Symmetric on both diff sides
(no NEW churn vs today); CHECK/partial-WHERE subqueries are rare. The helper's doc comment
states the bound; it does not imply full coverage.

## Use cases / acceptance (all covered by tests)

- A CHECK whose embedded column ref case changes across re-declares (`check (QTY>0)` →
  `check (qty>0)`) ⇒ empty diff (no constraint drop/add).
- A partial-index WHERE whose column ref case changes across versions (`where Active=1` →
  `where active=1`) ⇒ empty diff (no index drop/create).
- An FK whose referenced-TABLE case changes across re-declares (`references Parent(pid)` →
  `references parent(pid)`, parent table named `parent`) ⇒ child FK does not churn.
- String/numeric literals and collation names in CHECK/WHERE preserved byte-exact — a
  literal-VALUE change (`'Active'` → `'active'`) is NOT folded and still drops+recreates.
- A reserved-word column ref (`"Order"`) folds → `"order"` identically on both sides.
- Genuine body edits (changed predicate `1`→`0`; FK retarget to a different table
  `parent`→`other`) still drop+recreate.
- End-to-end: a case-divergent CHECK applies once, enforces, and a verbatim re-declare yields
  neither a diff nor any `generateMigrationDDL` output.

## Tests — what they pin, and the negative-control evidence

Added 7 tests to `declarative-equivalence.spec.ts` (in the
`named-constraint body change (drop+recreate)` block) and 1 to `index-ddl-roundtrip.spec.ts`.

**Confirmed-fail-without-fix (negative control run).** I temporarily reverted the three fold
application sites and ran the two specs **without** `--bail`: exactly the 4 fold-dependent
probes failed — the CHECK column-ref case change, the reserved-word CHECK ref, the FK
referenced-TABLE case change, and the partial-WHERE column-ref case change — while the
literal-preserved, verbatim-re-declare, genuine-retarget, and convergence probes stayed green
(they don't depend on the fold). Sites restored; full suite re-run green.

**Subtlety worth re-checking in review:** the CHECK expr and FK referenced-table are stored
**as-written** (not lifted to the column/table *definition* case, unlike the prereq's column
lists where the actual side lifts the definition). So the fold-exercising divergence for these
channels is **between-versions** (two different declares), NOT a verbatim re-declare of a
definition-divergent ref. The tests are written accordingly; a verbatim-re-declare probe is
included too but is a trivial-pass sanity check, labeled as such.

## Validation run

- `yarn workspace @quereus/quereus test` — **5208 passing, 9 pending, 0 failing** (9 pending
  pre-existing).
- `tsc --noEmit` (typecheck) — clean.
- `eslint` on the three changed files — clean.
- `yarn test:store` — **deferred** (per ticket, optional): this change touches only the
  in-memory canonical-comparison renderers, not the persistence DDL path (store rehydration
  uses the untouched `tableConstraintsToString` / `generateIndexDDL` / `foreignKeyClauseTail`).
  Persistence round-trip stays guarded by the green emit-roundtrip specs. A store spot-check
  would be belt-and-suspenders only.

## Known gaps / things to probe (treat tests as a floor)

- **Window-fold helpers are dead-path today.** `lowerWindowDefinitionIdentifiers` and the
  frame-bound fold exist for renderer-family symmetry (the ticket asked to mirror the full
  `expressionToString` enumeration), but window functions never appear in a CHECK / partial-
  WHERE, so they are not exercised by any test. Harmless consistency; flag if you'd rather
  they were dropped.
- **`identifier` vs `column` node.** A bare ref may parse as either; both are folded
  (`name`+`schema` on identifier; `name`+`table`+`schema` on column). The tests only exercise
  `column`-shaped refs through the apply path — an adversarial `identifier`-shaped probe (if
  one is reachable) would strengthen coverage.
- **Qualified CHECK refs** (`t.qty`, `main.t.qty`) fold the qualifier(s) too; no test exercises
  a qualified CHECK ref (CHECK refs are normally unqualified). Low risk; worth a probe.
- **`constraintBodyToCanonicalString` doc** still describes the column-list fold generically
  (it now also routes the CHECK expr fold through `lowercaseTableConstraintColumnNames`); the
  per-function doc on `lowercaseTableConstraintColumnNames` was updated, but a reviewer may
  want a one-line cross-reference added to `constraintBodyToCanonicalString`'s comment.
- **No new tests on the persistence path** — by design (the fold is canonical-only). Confirm
  the `emit-roundtrip-property` / `emit-roundtrip-positions` specs stayed green (they did, in
  the full run) as the guard that persistence casing is unchanged.
