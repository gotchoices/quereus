description: Single-source view-DML descent re-qualifies a substituted base term (`note` → `lbl`) with the base table name (`p1_t.lbl`) when it is emitted inside a lowered subquery operand, so it correlates to the outer UPDATE/DELETE target row instead of silently re-binding to a same-named subquery-local source (a confirmed silent wrong write). Multi-source is unaffected (its terms are already alias-qualified).
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What shipped

A single-source updateable view renames a base column to a view column
(`select lbl as note from p1_t`). The view-mutation descent substitutes a
view-column reference nested inside a `subquery` / `exists` / `in`-subquery
operand of the user predicate (or SET value) with its base-term lineage. That
lineage was an *unqualified* bare base name (`lbl`); emitted inside the lowered
subquery it re-bound by innermost-scope SQL rules to a same-named source the
subquery's own FROM introduced, instead of correlating to the outer
(UPDATE/DELETE target) base row — a silent wrong write.

The fix threads an optional `baseQualifier` through `makeViewColumnDescend →
transformQueryExpr → makeViewSubstitute`. When set (single-source rewriters pass
`analysis.baseTable.name`), a substituted replacement is passed through the new
`qualifyUnqualifiedRefs(expr, qualifier)`, which qualifies each top-level
unqualified base term with the base table name so it correlates to the outer row.
Applied **only** on the subquery-descent path; the top-level user WHERE / SET and
the RETURNING projection columns continue to use the unqualified remapper. The
multi-source spine passes `undefined` (its terms are already alias-qualified —
`p.label`), so its behaviour is byte-identical (the only multi-source change is a
doc comment).

## Review findings

**Diff reviewed:** `2bd4f41c` (implement) — `single-source.ts` (+60/-… the
`qualifyUnqualifiedRefs` helper + `baseQualifier` threading), `multi-source.ts`
(doc comment only — behaviour provably unchanged), `93.4-view-mutation.sqllogic`
(cases g/h/i), `docs/view-updateability.md`.

**Correctness — fix logic:** Verified sound for the targeted `base`-lineage case.
`columnMap` entries are always normalized to *unqualified* base terms
(`single-source.ts:649-655`), so `qualifyUnqualifiedRefs` reliably qualifies them;
already-qualified refs (none, in practice) would be left untouched. The
`resolve` closure short-circuits when `baseQualifier === undefined`, making the
multi-source path byte-identical. `transformExpr` without a `descend` argument
genuinely does not recurse into subquery operands, so the helper is shallow as
documented. Top-level vs. descent separation confirmed — no top-level / RETURNING
regression.

**Tests — regression guards independently verified.** Reverted the source to the
pre-fix parent and re-ran 93.4: case (g) fails pre-fix (row 2 wrongly written —
the documented silent wrong write), confirming the new cases are real guards, not
green-by-construction. Negative control (i) confirmed to distinguish
over-qualification.

**Coverage gap fixed inline (minor):** the fix threads `baseQualifier` into
`rewriteViewDelete`, but the new cases were UPDATE-only. Added case **(j)** — the
collision-on-delete mirror of (g). Verified it passes with the fix and fails
pre-fix in isolation (deletes all rows instead of one — a silent wrong delete).

**Major finding → new ticket filed:** the implementer flagged (honestly) that a
COMPUTED view column whose lineage *contains a correlated subquery*, referenced
inside a user subquery operand, was an untested combination ("likely fine, but
unverified"). Review **verified it is NOT fine** — it is a reachable silent wrong
write of the same class, one nesting level deeper:
`qualifyUnqualifiedRefs`'s shallowness leaves the lineage subquery's own
correlation ref (`id`) unqualified, so it re-binds to a same-named column the
user subquery's FROM introduces. Concrete repro confirmed (row left unchanged
when it should be updated). The fix is non-trivial (requires scope-aware
qualification — local lineage refs must stay, only the correlated ref qualified —
or the alias-on-target alternative), so it is filed as
`tickets/fix/view-mutation-computed-lineage-correlated-subquery-deep-rebind.md`
rather than fixed in this pass.

**Documented, not fixed (acceptable):**
- *Same-base-table self-reference corner* (`update p1_v … where exists (select 1
  from p1_t …)`) — the `p1_t.lbl` qualifier binds the innermost local `p1_t`. An
  inherent SQL self-reference ambiguity; no worse than pre-fix; documented in
  `docs/view-updateability.md`. No test added (the sqllogic format has no xfail
  mechanism and asserting a known-wrong result is an anti-pattern). The filed fix
  ticket notes the alias-on-target approach could close this corner too.
- *`No row context found for column lbl` surface* — the source ticket mentioned a
  variant raising this; neither the fix-stage probe nor this review could pin an
  exact raising query. Believed same root cause; no positive raising test exists.
  Left as-is (not reproducible).

**Docs:** `docs/view-updateability.md` § Selection updated by the implementer and
verified accurate against the shipped code (the correlation-qualified-term
paragraph and the self-reference known-corner note both match reality).

**Lint / full suite:** `yarn workspace @quereus/quereus run lint` → clean.
`yarn workspace @quereus/quereus run test` → **4235 passing, 9 pending** (the
sqllogic file is one Mocha test, so adding case (j) does not change the count).

**Aspect sweep:** SPP/DRY — `qualifyUnqualifiedRefs` mirrors `normalizeBaseRefs`,
small and single-purpose, no duplication. Resource cleanup / async — N/A (pure AST
transform). Type safety — no `any`; optional `baseQualifier?: string` threaded
explicitly. Error handling — the `tainted` / unresolved-source rejection path is
preserved (rejects loudly rather than mis-binding). No performance concern (one
extra shallow tree walk per substituted descent term).
