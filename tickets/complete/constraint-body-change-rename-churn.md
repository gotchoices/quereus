description: COMPLETE — the declarative differ no longer emits a spurious named-constraint DROP+ADD when a CHECK/UNIQUE/FK body is unchanged except for an identifier renamed in the same diff. `computeTableAlterDiff` reconciles the declared body back to its pre-rename form (`reconciledDeclaredBody`) before deciding a body changed; equal-after-reconcile ⇒ pure rename ⇒ no churn. Reviewed, validated, one coverage gap filled inline, one narrow follow-up filed to backlog.
files:
  - packages/quereus/src/schema/schema-differ.ts            # reconciledDeclaredBody + body-comparison short-circuit + thread-through (tableRenames, schemaName)
  - packages/quereus/src/emit/ast-stringify.ts              # constraintBodyToCanonicalString — shared canonical renderer (both sides)
  - packages/quereus/src/schema/ddl-generator.ts            # constraintToCanonicalDDL → lifts schema constraint → calls constraintBodyToCanonicalString
  - packages/quereus/src/schema/catalog.ts                  # CatalogTable.namedConstraints[].definition (actual-side body, pre-rename names)
  - packages/quereus/src/schema/rename-rewriter.ts          # renameColumnInCheckExpression (reused inverse-direction for CHECK)
  - packages/quereus/src/planner/mutation/scope-transform.ts # cloneExpr (deep clone — protects the cached declared AST)
  - packages/quereus/test/declarative-equivalence.spec.ts   # 'rename without constraint churn' describe (5 tests: +1 added in review)
  - docs/schema.md                                          # "Rename reconciliation" section
  - tickets/backlog/fk-parent-referenced-column-rename-churn.md # follow-up filed for the documented limitation
----

# Suppress redundant constraint drop+recreate on a rename-only identifier change

## Summary

A named CHECK/UNIQUE/FK whose body differs from the catalog **only** because an
identifier (a column, or an FK's parent table) was renamed in the **same** diff
now emits only the rename — not a redundant `DROP CONSTRAINT` + `ADD CONSTRAINT`
on top of it. The fix lives entirely in `computeTableAlterDiff`: it first compares
the raw canonical body strings (the common no-rename case short-circuits) and, on
a mismatch, re-compares a **rename-reconciled** declared body
(`reconciledDeclaredBody`) built by inverse-applying the in-diff renames (new name
→ old name) to a surgical clone of the declared constraint AST. Equal after
reconciliation ⇒ pure rename ⇒ skip the drop+recreate. A genuine body edit layered
on a rename still differs ⇒ drop+recreate (and its RENAME suppression) preserved.

Both comparison sides funnel through one renderer: `constraintBodyToCanonicalString`
(the actual-catalog side reaches it via `ddl-generator`'s `constraintToCanonicalDDL`,
which lifts the stored schema constraint back to an AST first), so the strings are
byte-comparable. The CHECK reconciliation reuses the runtime
`renameColumnInCheckExpression` rewriter over a `cloneExpr` deep clone; UNIQUE/FK
reconcile their column lists (and an FK its parent `table`) directly.

## Review findings

### Verdict
Implementation is correct, sound, and matches its documented design. Validation
gate is green. One test-coverage gap was filled inline; one narrow documented
limitation was filed to backlog. No blocking issues.

### What was checked

- **Correctness of the reconciliation logic.** The inverse rewrite maps only the
  renamed identifiers exactly (new → old), so `reconciled == actual` holds **iff**
  the sole difference was the rename. A genuine body change cannot be masked
  (false-suppressed) because the inverse rewrite touches nothing but the renamed
  identifiers — verified by the REGRESSION test (body edit + rename still
  drops+recreates) and by reasoning over the comparison.
- **No corruption of the cached declared AST.** `bodyAst` backs `ddl`/`definition`
  and must not be mutated. `cloneExpr` was confirmed to be a *deep* structural
  clone (`transformExpr` rebuilds every node via spreads), and the UNIQUE/FK paths
  clone their column arrays / FK clause before mutating. The in-place CHECK
  rewriter therefore only touches the fresh clone. Safe across repeated diffs.
- **Renderer parity (byte-comparability).** Both sides ultimately call
  `constraintBodyToCanonicalString`; the actual side goes
  `constraintToCanonicalDDL → schemaConstraintToTableConstraint → constraintBodyToCanonicalString`.
  The reconciliation reuses the same renderer, and the pre-existing idempotency
  tests prove the two paths agree byte-for-byte on the unchanged case.
- **Call-site / signature integrity.** `computeTableAlterDiff` gained two required
  params (`tableRenames`, `schemaName`); its sole caller in `computeSchemaDiff` was
  updated. `tableRenames.renames` are all `kind:'table'` (confirmed at the
  resolver). `diff.columnsToRename` is populated (line ~899) before the body
  comparison consumes it (line ~993) — no ordering hazard.
- **Precedence / counting preserved.** A suppressed pseudo-body-change is a matched
  constraint, so `renamesSuppressedByBodyChange` / `bodyChangedNames` and the
  `require-hint` `pureCreate/pureDrop` counts are unaffected (a real body edit on a
  rename still suppresses the RENAME and does drop+add).
- **Documentation.** `docs/schema.md` "Rename reconciliation" section accurately
  describes `reconciledDeclaredBody`, the inverse rewrite, and the FK
  referenced-parent-column limitation. `docs/sql.md` rename section is consistent
  (renames propagate through CHECK/FK/view references) and carries no stale churn
  caveat. No other docs reference the old behavior.
- **Lint + typecheck + tests.** All green (see below).

### Findings — bugs / correctness
None. The reconciliation is one-directional (only renamed identifiers are mapped),
so the safety property "never false-suppress a real change" holds.

### Findings — test coverage (MINOR — fixed inline)
The implementer's 4 tests covered: CHECK over a renamed column, UNIQUE over a
renamed column, FK whose **parent table** is renamed, and the REGRESSION
(body-edit + rename). The **FK local (child) column rename** branch
(`inverseRenameConstraintColumns(clone.columns, …)` in the foreignKey case) was
implemented but **untested**. Added a 5th test —
*"an FK whose LOCAL (child) column is renamed emits ONLY the column rename"* — which
asserts the column rename is detected, no FK drop/add churns, the FK still enforces
under the renamed local column, and re-apply is idempotent. **Passes.** Spec is now
60 passing; full suite 4848 passing (+1).

### Findings — known limitation (MAJOR-ish scope → filed to backlog, NOT a regression)
An FK whose **referenced column on the parent table** is renamed still churns a
drop+recreate on the child — the parent's column renames live in the parent's own
per-table diff and aren't visible cross-table in the single-pass differ. This is
**not a regression** (it churned before this ticket too; the fix simply did not
extend to it) and is documented inline (`reconciledDeclaredBody` JSDoc) and in
`docs/schema.md`. Filed `tickets/backlog/fk-parent-referenced-column-rename-churn.md`
with a two-pass fix sketch and acceptance criteria so it is tracked beyond the
inline note.

### Findings — corners considered, no action (documented, harmless)
- **Subquery-shadow in a CHECK** (`renameColumnInCheckExpression` without the
  optional `resolveColumnInSource` callback): an inner unqualified ref that
  legitimately binds to a subquery source could be over-rewritten. Analysis: this
  errs toward **churn** (reconciled ≠ actual → drop+recreate), never toward
  false-suppression — safe direction. Same latent property as the forward rewriter.
- **Table-qualified self-reference inside a CHECK when both the table AND a column
  are renamed**: the column rewriter does not rewrite the table qualifier, so
  neither side fully reconciles → harmless churn, not false-suppression.
- **Column-name cycle/swap in one diff** (`a→b` and `c→a`): could mis-reconcile,
  but the forward rename rewriter has the same property and such cycles are not a
  supported scenario.

### Findings — resource cleanup / error handling / type safety
- No resources to clean up (pure string/AST computation). `reconciledDeclaredBody`
  and `cloneExpr` run only on a body mismatch (short-circuit), so the hot
  no-rename path is unchanged.
- The rewriter's boolean return is intentionally ignored (we re-render and compare
  regardless) — not a swallowed error.
- Types are precise; `typecheck` clean, no `any`.

### Empty categories
- **Performance regressions:** none — reconciliation is gated behind the raw-string
  short-circuit; common diffs never reach it.
- **Security / injection:** N/A — identifiers are rewritten structurally in the
  AST, then rendered through the canonical quoting path; no string concatenation of
  user input into DDL beyond the existing canonical renderer.

### Commands run (all green)
- `yarn workspace @quereus/quereus run typecheck` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0
- `yarn workspace @quereus/quereus run test:single …/declarative-equivalence.spec.ts` → **60 passing**
- `yarn workspace @quereus/quereus test` (full suite) → **4848 passing, 9 pending**, exit 0
- `test:store` not run (out of scope; the fix is backend-agnostic *diff* logic — the
  apply-side RENAME rewriters in `runtime/emit/alter-table.ts` are unchanged). A
  store run remains available to a human/CI if desired.
