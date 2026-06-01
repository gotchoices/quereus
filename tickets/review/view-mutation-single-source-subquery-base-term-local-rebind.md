description: Single-source view-DML descent re-qualifies a substituted base term (`note` → `lbl`) with the base table name (`p1_t.lbl`) when it is emitted inside a lowered subquery operand, so it correlates to the outer UPDATE/DELETE target row instead of silently re-binding to a same-named subquery-local source (a confirmed silent wrong write). Multi-source is unaffected (its terms are already alias-qualified).
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What changed (implement summary)

A single-source updateable view renames a base column to a view column
(`select lbl as note from p1_t`). The view-mutation descent substitutes a
view-column reference nested inside a `subquery` / `exists` / `in`-subquery
operand of the user predicate (or SET value) with its **base-term lineage** —
but that lineage was an *unqualified* bare base name (`lbl`). Emitted inside the
lowered subquery, an unqualified `lbl` re-binds by ordinary innermost-scope SQL
rules to a same-named source the subquery's own FROM introduces, instead of
correlating to the outer (UPDATE/DELETE target) base row — a **silent wrong
write**.

Fix (surgical, subquery-descent path only): thread an optional
`baseQualifier?: string` through `makeViewColumnDescend` → `transformQueryExpr`
→ `makeViewSubstitute`. When set, a substituted replacement is passed through
the new `qualifyUnqualifiedRefs(expr, qualifier)` (shallow — mirrors
`normalizeBaseRefs`, does NOT descend into a nested subquery inside the
replacement), which qualifies each unqualified base term with the base table
name (`analysis.baseTable.name` = exactly the table the lowered statement
targets, no synthesised alias). The single-source rewriters
(`rewriteViewUpdate` / `rewriteViewDelete` / `rewriteViewReturning`) pass
`analysis.baseTable.name`; the multi-source `substituteViewColumns` omits it
(passes `undefined`) because its terms are already alias-qualified (`p.label`)
and there is no single base-table correlation name.

Crucially this is **only** on the subquery-descent (`descend`) path. The
top-level user WHERE / SET and the RETURNING projection columns continue to use
the unqualified `remapper`, so the single-source lowered statement (one source)
resolves them unqualified as before — no top-level / RETURNING-projection
regression.

## Why it's correct

- Only a *substituted* term (a view column, a `columnMap` key) is ever
  qualified. A bare base-name reference (`lbl`) is never a view column, so it is
  never substituted nor qualified — a subquery-local source that genuinely
  defines `lbl` keeps binding locally.
- `qualifyUnqualifiedRefs` returns a fresh tree; it does not mutate the shared
  `columnMap` entry.
- `baseQualifier === undefined` makes `makeViewSubstitute` byte-identical to its
  prior behaviour (the multi-source path is unchanged).

## Validation / use cases for the reviewer

Targeted run (passes):
`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "93.4-view-mutation"` (from repo root).

Three new cases added to `93.4-view-mutation.sqllogic` in the § "View-column
references nested inside subquery…" block:

- **(g) shape 1 — substituted term collides with a subquery-local source.**
  `update p1_v set note='CHANGED' where exists (select 1 from p1_aux where k = note)`
  where `p1_aux` has its own `lbl`. Pre-fix: `note`→bare `lbl` re-binds to
  `p1_aux.lbl`, predicate becomes uncorrelated `p1_aux.k = p1_aux.lbl`, true for
  the `('Q','Q')` row → both rows wrongly written. Post-fix: `p1_aux.k = p1_t.lbl`
  → only row 1. Expect `[{id:1,lbl:'CHANGED'},{id:2,lbl:'B'}]`.
- **(h) shape 2 — `where lbl = note`, both the literal and the substituted term
  are base-named.** Literal `lbl` binds subquery-local `p2_aux.lbl` (not a view
  column → untouched); `note`→`p2_t.lbl`. Pre-fix both collapse to `p2_aux.lbl`
  (always-true). Post-fix `p2_aux.lbl = p2_t.lbl` → only row 1.
- **(i) negative control on the BASE name.** `nc_src` genuinely defines `lbl`
  plus an `ok` flag; `where exists (select 1 from nc_src where lbl = note and
  ok = 1)`. The bare `lbl` must STAY local (nc_src.lbl) while `note`→correlated
  `nc_t.lbl`. If the fix wrongly qualified the local `lbl` to `nc_t.lbl` the
  predicate would degrade to the always-true `nc_t.lbl = nc_t.lbl and ok = 1`
  → both rows write; the expected `[{id:1,lbl:'CHANGED'},{id:2,lbl:'L2'}]` would
  fail. (This is the data-distinguished guard the reviewer should sanity-check.)

Existing 93.4 cases (a)–(f), the multi-source (e1/e2) cases, and the whole
single-/multi-source suite still pass.

Full suite: `yarn workspace @quereus/quereus run test` → **4235 passing, 9
pending**. `yarn workspace @quereus/quereus run lint` → clean.

## Honest gaps / review angles

- **Self-reference corner (out of scope, documented).** If the subquery FROM
  names the *same base table* (`update p1_v … where exists (select 1 from p1_t
  where …)`), the `p1_t.lbl` qualifier binds the innermost local `p1_t`, not the
  outer target — an inherent SQL self-reference ambiguity the single-source
  lowering (no alias on the target) cannot disambiguate. No worse than pre-fix.
  Documented in `docs/view-updateability.md` § Selection as a known limit; a
  future hardening could synthesise an alias on the lowered target. **No test
  asserts this corner** — reviewer may want a documenting test (xfail-style or
  a comment) so the limitation is visible in the suite, not just the doc.
- **`No row context found for column lbl` surface.** The source ticket mentioned
  a variant that raises this; the fix-stage probe could not pin an exact raising
  query (variants either correlated correctly or silently mis-wrote as above).
  Believed same root cause, addressed by the same fix, but **not covered by a
  positive raising test**. If the reviewer can pin a precise raising shape, add
  it; otherwise the two confirmed shapes (g/h) are the floor.
- **`qualifyUnqualifiedRefs` is shallow by design.** It does not descend into a
  nested subquery *inside* a replacement lineage term. This is correct for a
  computed view column whose own scalar subquery has its own scope, but the
  current tests only exercise `base`-lineage replacements (bare column). A
  computed view column referenced inside a user subquery operand — whose lineage
  expr itself contains a correlated subquery referencing the base — is an
  untested combination worth a reviewer's eye (likely fine, but unverified).
- Only `update`/`delete`/`returning` single-source paths thread the qualifier;
  INSERT does not descend view columns into subqueries (no `descend` on the
  insert source rewrite), so it is unaffected by design.
