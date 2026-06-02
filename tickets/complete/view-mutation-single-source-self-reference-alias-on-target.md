description: Closed the same-base-table self-reference corner in single-source view-mutation. The lowered single-source UPDATE/DELETE target carries a synthesised collision-proof correlation alias (`__vm_self`); substituted subquery-descent base terms are qualified with that alias instead of the bare base table name, so a correlation-qualified base term binds the outer target row even when the user subquery FROM names the same base table the view lowers to. Previously de-correlated into a silent wrong write. UPDATE/DELETE only.
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/scopes/aliased.ts, packages/quereus/src/emit/ast-stringify.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic

## Summary

The single-source view-mutation rewriter qualified a substituted base term emitted inside
a subquery operand with the **base table name** (`p1_t.lbl`), because the lowered
single-source statement named its target by the bare base table with no alias. When the
user subquery FROM named the *same* base table the view lowers to, innermost-scope SQL
bound the qualified term to the **inner** source, not the outer UPDATE/DELETE target row —
the correlated subquery silently de-correlated into a wrong write.

The implementation synthesises a reserved, `__`-prefixed correlation alias (`__vm_self`) on
the lowered UPDATE/DELETE target (`alias?` on `UpdateStmt`/`DeleteStmt`, set only by the
single-source rewriter — the parser never produces it). The base builders register that
alias on the target's `AliasedScope`, and the single-source qualifier
(`makeBaseQualifier` / `makeBaseQualifyScope`, now parameterised on the qualifier name)
emits `__vm_self.col` for substituted subquery-descent terms — including those threaded
into a RETURNING subquery. INSERT and the multi-source spine keep the bare base-table-name
qualifier (no target-row scan to collide with). Ordinary non-view UPDATE/DELETE never set
the alias, so `correlationName === tableName` and the `AliasedScope` is byte-identical to
before.

The reviewer verified the implementation, exercised the two threaded-but-untested seams
the implementer flagged, fixed a contradicted doc sentence, and ran the full suite green.

## Review findings

### Verified (correct as implemented)

- **Invariant #1 — no stringify→reparse of the lowered alias-bearing op.** Traced the
  lowering path: `propagate()` → `BaseOp.statement` (an AST) → `buildBaseOp` →
  `buildUpdateStmt` / `buildDeleteStmt`. The lowered op is never serialised to SQL text and
  reparsed, so the synthesised `update t as __vm_self` (which the parser has no production
  for) never hits the parser. The two text-bridge calls in `single-source.ts`
  (`parseExpressionString` at L650, `expressionToString` at L832) are the INSERT tag-default
  path and RETURNING-name derivation respectively — neither round-trips the lowered op. The
  `emit-roundtrip-property` suite stays green (its arbitraries never set `alias`).
- **Invariant #4 — inert outside view-mutation.** Read `scopes/aliased.ts`: with
  `alias === parentName` a 2-part `t.col` resolves `col` against the parent exactly as
  before, and unqualified `col` always delegates to the parent. The new line collapses to
  the prior `new AliasedScope(tableColumnScope, tableName, tableName)` byte-for-byte when
  `stmt.alias` is unset. Full suite confirms no non-view UPDATE/DELETE regression.
- **RETURNING seam threading.** Confirmed the base UPDATE/DELETE builder builds RETURNING in
  a scope chained to the target's `AliasedScope` (`returningScope = new
  RegisteredScope(updateCtx.scope)`), so a RETURNING subquery's `__vm_self.col` binds the
  outer target row. Also verified empirically (see added block (r): correlated count is 2,
  vs 1 if de-correlated).
- **Invariant #3 — qualifies the lineage, not the user FROM.** Confirmed against block (p)'s
  rewrite and empirically: the base-qualify runs over the replacement expression
  independent of the user subquery FROM, so a renamed base column (`note` → `lbl`) becomes
  `__vm_self.lbl` and binds the outer row.
- **INSERT path unchanged.** `rewriteViewInsert` passes no qualifier override, so its
  descent and RETURNING default to the bare base-table name (correct — no target-row scan).
- Build, lint, and the full `@quereus/quereus` suite are green: **4330 passing, 9 pending,
  0 failing**.

### Minor — fixed inline this pass

- **Added the two threaded-but-untested seams as regression blocks** in
  `93.4-view-mutation.sqllogic`:
  - **(r)** RETURNING-subquery same-base-table correlation. Mutates a *non-correlation*
    column so the asserted correlated count (`2`) is unambiguous and does not depend on the
    OLD/NEW asymmetry noted below; de-correlation would yield `1`.
  - **(s)** the `in (select … where <correlation>)` descent form (blocks (p)/(q) used
    `exists`). De-correlation would change *both* rows; the correct correlated result
    changes only the matching row.
  Both were verified empirically with a throwaway probe (the de-correlated outcome is
  observably different) before being committed as assertions; the file and full suite pass.
- **Doc contradiction in `docs/view-updateability.md` § Selection.** The deep-qualification
  narrative asserted the substituted term is qualified with "the base table name
  (`p1_t.lbl`) … **(no synthesised alias)**" — directly contradicted by the fix (the same
  passage's own "same-base-table self-reference (fixed)" note introduces `__vm_self`).
  Reworded the earlier sentence to forward-reference *which* name is used, leaving the
  mechanism description intact.

### Observations — not blocking, not filed

- **`__vm_self` collision-proofness is convention-only.** Nothing rejects user identifiers
  that start with `__`, so an adversarial user subquery `… from foo as __vm_self …` would
  shadow the synthesised target alias and re-break correlation. This is the *same risk
  class* as the existing `__vmupd_keys` / `__shared_key` internal names and is consistent
  with the established convention, so it is not filed as a defect. If the project ever wants
  to harden this, the fix belongs at the layer that would also protect the other internal
  names (a reserved-prefix guard on user FROM aliases), not in this ticket.
- **OLD/NEW asymmetry in RETURNING subqueries.** Empirically, a top-level RETURNING
  reference to a view column binds the NEW value while a correlated subquery reference binds
  the OLD value (the `AliasedScope` wraps the pre-update source node). This is pre-existing
  and orthogonal to this ticket — block (r) was deliberately designed to mutate a
  non-correlation column so its assertion does not depend on it.
- **Multi-source analogue out of scope.** The multi-source spine correlates via the
  `__vmupd_keys` identity-capture CTE, a different mechanism than the single-source
  correlation-qualifier; whether it has an analogous corner was not investigated, per the
  ticket's UPDATE/DELETE single-source scope.

### Categories with nothing found

- **Major findings:** none — no new fix/plan/backlog ticket was filed.
- **Pre-existing failures:** none observed; `tickets/.pre-existing-error.md` was not written.
  The full suite was green at HEAD-with-this-diff.
