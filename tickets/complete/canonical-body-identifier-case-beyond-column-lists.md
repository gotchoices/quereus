description: Case-fold the two remaining identifier-case channels in the schema-differ canonical bodies — (1) bare column refs inside CHECK expressions + partial-index WHERE predicates, and (2) the FK referenced (parent) TABLE name — so a case-only divergence no longer churns a spurious drop+recreate (index/CHECK) or drop+add (FK). String/blob/numeric/JSON literals and collation names stay byte-exact. Builds on the merged `canonical-body-column-name-case-normalization`. Implemented and reviewed; build + full test suite + lint green.
files:
  - packages/quereus/src/emit/ast-stringify.ts            # lowerExprIdentifiers + window-fold helpers; applied in CHECK case, partial-WHERE render, fk.table.toLowerCase()
  - packages/quereus/test/declarative-equivalence.spec.ts # +9 tests in the named-constraint body-change describe (7 from implement + 2 from review)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # +1 partial-WHERE column-case no-churn probe
  - docs/schema.md                                         # constraint + index body-change fold notes updated
----

# Canonical-body identifier-case normalization beyond column lists — COMPLETE

## Summary

The declarative differ decides "name-matched object whose body changed" by rendering a
canonical body string on both the declared-AST side and the actual-catalog side and comparing
byte-equal. Quereus has no case-sensitive identifiers (the AST never records quoting; every
resolver folds via `.toLowerCase()`), so any identifier that renders case-preserving in the
canonical body is a latent spurious-churn channel. The merged prereq folded canonical column
*lists*; this ticket closed the two remaining channels, entirely inside the shared canonical
renderers in `ast-stringify.ts`:

1. **Bare column refs inside CHECK expressions and partial-index WHERE predicates** — a new
   self-contained `lowerExprIdentifiers(expr)` returns a structural clone with `column` /
   `identifier` node `name` / `table` / `schema` lowercased and everything else byte-exact
   (literals, parameters, `cast.targetType`, `function.name`, `collate.collation` untouched —
   the latter two already lowercase at render). Applied at the CHECK channel via
   `lowercaseTableConstraintColumnNames`'s `check` case and at the partial-WHERE channel via
   `createIndexBodyToCanonicalString`'s `where` render.
2. **FK referenced (parent) TABLE name** — `canonicalForeignKeyClause` lowercases `fk.table`;
   `quoteIdentifier` still runs after, so a reserved-word parent name re-quotes correctly on
   both sides.

Persistence renderers are untouched; `ddl-generator.ts` / `catalog.ts` / `schema-differ.ts`
unchanged. Both diff sides funnel through the two canonical renderers, so the fold is symmetric
by construction.

## Review findings

**Scope of review.** Read the implement-stage diff (`git show 0c51b00a`) with fresh eyes before
the handoff: `ast-stringify.ts` (+141), the two test specs (+167), `docs/schema.md`. Scrutinized
across correctness, symmetry, mutation safety, type safety, DRY/modularity, and docs. Ran full
suite + tsc + eslint.

### Checked — and found sound

- **Node enumeration completeness.** `lowerExprIdentifiers`'s switch mirrors `expressionToString`
  and the full `AST.Expression` union (16 members — `LiteralExpr … BetweenExpr`). `FunctionSource`
  falls to the default pass-through, exactly as `expressionToString` routes it to its `[unknown_expr]`
  default — symmetric. `CaseExprWhenThenClause` is `{when, then}` only, so the clause rebuild loses
  nothing; the `WindowDefinition` / `WindowFrame` / `WindowFrameBound` shapes match the fold helpers.
- **Mutation safety (the critical invariant).** Every folded node is rebuilt fresh
  (`{...node, ...recursed}`); pass-through nodes (`literal` / `parameter` / `subquery` / `exists`)
  are returned by reference but only read at render, never mutated. Confirmed the actual side passes
  the **live** stored `c.expr` (`ddl-generator.ts:214`) and `c.referencedTable` (`:237`) into the
  canonical path and neither is mutated — the input subtree is safe to alias.
- **Symmetry.** Both diff sides funnel through `constraintBodyToCanonicalString` /
  `createIndexBodyToCanonicalString` (verified call sites in `schema-differ.ts` and
  `ddl-generator.ts`). `git show --stat` confirms the diff touches only `ast-stringify.ts` + tests
  + docs — no actual-side edit smell.
- **Rename-reconcile interaction.** `reconciledDeclaredBody`'s FK path (`schema-differ.ts:957`)
  sets `foreignKey.table = tr.oldName` (pre-rename parent), then the downstream
  `canonicalForeignKeyClause` lowercases it — symmetric with the actual side, which stores the old
  name and lowercases identically.
- **Switch exhaustiveness.** `TableConstraint.type` is exactly the 4 handled by
  `lowercaseTableConstraintColumnNames`; the dropped `default` is safe (tsc would flag a future
  member). tsc `--noEmit` clean.
- **No real change masked.** Literal-value edits, FK retargets, and predicate edits still differ
  after folding (identifier-only) and still drop+recreate — pinned by the implementer's
  negative-control tests (reverting the 3 fold sites failed exactly the 4 fold-dependent probes).

### Minor — fixed inline this pass

- **Coverage gaps (the implement handoff's own flagged untested-but-reachable paths).** Added 2
  tests to `declarative-equivalence.spec.ts`, both green:
  - a **table-qualified** CHECK ref (`t.QTY` → `t.qty`) — folds the qualifier too, no churn;
  - a CHECK with refs **nested in `length(case when … then … else … end)`** — exercises the
    fold's `function` / `case` / `binary` recursion via the apply path (the implementer's CHECK
    tests reached only `binary`), with a `'x'` literal held byte-exact.
- **Stale docstring.** `constraintBodyToCanonicalString`'s comment described the fold as
  column-list-only; updated to enumerate all three identifier channels (UNIQUE/PK/FK lists, CHECK
  expr, FK parent-table) and cross-reference `lowerExprIdentifiers`.

### Considered — deliberately left as-is

- **Window-fold helpers are dead-path** (`lowerWindowDefinitionIdentifiers` et al.). Window
  functions cannot appear in a CHECK / partial-WHERE, so these are unreachable. **Kept**: they
  preserve the renderer-family symmetry the ticket asked to mirror with `expressionToString`'s full
  enumeration; dropping them would create an asymmetry (`windowFunction.function` folded but its
  `over (…)` clause not). Not a defect, and harmless.
- **Subquery bodies inside CHECK / partial-WHERE** (`subquery` / `exists` / `in (select …)`) pass
  through structurally — documented bounded limitation, symmetric on both sides, no new churn vs
  today. Correct as designed.

### Empty categories (explicit)

- **Major findings: none.** No new `fix/` / `plan/` / `backlog/` tickets spawned — the change is
  small, symmetric by construction, and the canonical-only blast radius is confined to the two
  shared renderers.
- **Pre-existing failures: none.** `tickets/.pre-existing-error.md` not written.

## Validation

- `yarn workspace @quereus/quereus test` — **5210 passing, 9 pending, 0 failing** (was 5208 at
  implement; +2 review tests; the 9 pending are pre-existing).
- `tsc --noEmit` — clean.
- `eslint` on the 3 changed files — clean.
- `yarn test:store` — not run (deferred per ticket: change touches only the in-memory canonical
  comparison renderers, not the persistence DDL path; persistence casing stays guarded by the green
  emit-roundtrip specs).

## End
