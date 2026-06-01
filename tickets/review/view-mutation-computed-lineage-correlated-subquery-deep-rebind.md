description: Review the fix for the silent wrong-write when a single-source updateable view's COMPUTED column lineage contains a correlated scalar subquery and that view column is referenced inside a user UPDATE/DELETE subquery operand. The substituted-term qualifier was shallow (top-level refs only); it is now scope-aware and DEEP — it descends into a nested subquery within the replacement and qualifies only base-table columns not shadowed by the lineage subquery's own FROM, rejecting on an unresolvable nested FROM.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What changed

The bug: `single-source.ts`'s substituted-term qualifier (`qualifyUnqualifiedRefs`)
was **shallow** — `transformExpr(expr, col => qualify-if-unqualified)` with no
`descend` argument. For a `base`-kind lineage (a bare `column` node) that was fine,
but a COMPUTED column whose lineage is a correlated scalar subquery
(`(select x from oth where fk = id) as note`) has its correlation ref (`id`) one
level down — never reached. Emitted inside a user subquery whose FROM introduces a
same-named column (`exists (select 1 from src where tag = note)`, `src` having an
`id`), the unqualified `id` re-bound to the innermost local source by ordinary SQL
scoping → `note` evaluated wrong (NULL) → silent no-op / wrong write.

The fix, all in `single-source.ts`:

- **Replaced** the shallow `qualifyUnqualifiedRefs(expr, qualifier: string)` with
  `makeBaseQualifier(ctx, baseTable) → (repl) => AST.Expression`, built at the
  call site where `analysis.baseTable` is in scope.
- **Added** `qualifyCorrelatedBaseRefs` (scalar) + `qualifyCorrelatedBaseRefsQuery`
  (query) — a scope-aware DEEP qualifier that mirrors `transformQueryExpr`'s
  `collectFromColumnNames` / `shadowed` logic, reusing `collectFromColumnNames` and
  `rebuildSelect` verbatim. The only difference from `transformQueryExpr`'s
  substitute is the predicate: qualify an **unqualified base-table column not in
  `shadowed`** (vs. substitute-a-view-column). At each nested `select` the lineage
  subquery's FROM column names join `shadowed`; a compound/union leg keeps the
  incoming `shadowed`; a `values` body keeps the incoming `shadowed`.
- **Taint reject:** if a nested FROM is unresolvable (`collectFromColumnNames`
  returns `null` — `select *` / TVF / CTE), shadowing can't be proven →
  `raiseMutationDiagnostic({ reason: 'unsupported-subquery-correlation', … })`.
  Unreachable for base/g-h-i-j shapes (no nested FROM in the replacement).
- **Threading:** `baseQualifier?: string` → `baseQualify?: (repl) => AST.Expression`
  closure through `makeViewColumnDescend` → `transformQueryExpr` →
  `makeViewSubstitute.resolve`. The three single-source rewriters
  (`rewriteViewUpdate` / `rewriteViewDelete` / `rewriteViewReturning`) build the
  closure via `makeBaseQualifier(ctx, analysis.baseTable)`; the multi-source spine
  (`substituteViewColumns` in `multi-source.ts`) still passes nothing (`undefined`)
  — its terms are alias-qualified (`p.label`) and there's no single base-table
  correlation name.

Restricting to **base columns** is the principled gate: a `normalizeBaseRefs`-
normalized lineage's top-level refs are all base columns, so it's a no-op there,
and it guarantees a genuinely-local lineage column (`fk` / `x` owned by the nested
FROM) is never qualified.

## Decisions / scope

- **Optional alias-on-target NOT taken.** The deep fix does not need it for this
  reproduction (the user subquery FROM is never the base table here). The
  documented self-reference corner (`update p1_v … where exists (select 1 from
  p1_t …)` — same base table named in the subquery FROM) remains **unfixed**; the
  "Known corner (unfixed)" note in `docs/view-updateability.md` § Selection is kept
  and amended to note the deep qualification is orthogonal to it. This keeps the
  change focused and avoids touching the base-statement lowering.

## Use cases for testing / validation

Added to `93.4-view-mutation.sqllogic` after block (j):

- **(k) the repro** — computed lineage `(select x from cv_oth where fk = id) as
  note`, referenced inside `update cv_v set lbl='CHANGED' where exists (select 1
  from cv_src where tag = note)` where `cv_src` ALSO has an `id` (shadows the
  lineage's correlation). Asserts `[{id:1,lbl:'CHANGED'},{id:2,lbl:'B'}]`. **This
  fails before the fix** (verified in the fix stage: silent no-op, row 1 stays 'A').
- **(l) negative control — no over-qualify** — same view, user subquery FROM
  (`cv_ok(tag)`) does NOT shadow `id`. Guards against the fix wrongly deep-
  qualifying the lineage-local `fk`/`x` to `cv_base.fk`/`cv_base.x` (which would
  error — `cv_base` has no such columns). Passes pre- AND post-fix; regression guard.
- **(m) DELETE variant** — the repro shape on `delete from cd_v …`, confirming the
  qualifier is threaded through `rewriteViewDelete`. Asserts only row 1 deletes.

Existing guards that must stay green (and do): blocks (g)/(h)/(i)/(j) — the
base-term shallow case (a bare `column` replacement still qualifies correctly,
since the deep qualifier's top-level substitute handles it), and (i) specifically
guards that a genuinely-local bare base-name ref stays local.

## Validation performed

- `yarn typecheck` (quereus) — clean.
- `yarn workspace @quereus/quereus test` — **4243 passing, 9 pending** (full memory
  suite, includes 93.4 + the bx-roundtrip-law parity harness + MV write-through +
  view-info/column-info).
- `yarn lint` (quereus) — clean.

## Known gaps / things for the reviewer to probe (tests are a floor, not a ceiling)

- **Store mode not run.** `yarn test:store` was NOT run (per AGENTS.md, store mode
  is for store-specific diagnosis). The change is purely in the AST-rewrite planner
  layer with no store interaction, so memory coverage should suffice — but a
  reviewer wanting belt-and-suspenders could spot-run 93.4 under store mode.
- **Self-reference corner still unfixed** (see Decisions). Confirm the doc note is
  accurate and the decision to defer is acceptable; if not, the optional
  alias-on-target hardening is the follow-up (synthesise an alias on the lowered
  single-source target and qualify with it).
- **Alias inside the lineage subquery.** A pre-existing, out-of-scope corner: if a
  view author qualifies the lineage subquery's correlation ref with the base
  *alias* (`(select x from oth where fk = b.id)` over `from base b`),
  `normalizeBaseRefs` does not descend into the subquery, so the columnMap entry
  keeps `b.id`; the new deep qualifier (which only touches *unqualified* refs)
  leaves it, and `b` won't resolve in the lowered statement. This is no worse than
  the pre-fix behavior (the shallow qualifier also didn't descend) and is not
  exercised by any test. Worth a reviewer eye on whether to widen the deep
  qualifier's substitute to also re-qualify base-alias refs, or leave as a separate
  ticket.
- **Two-level correlation depth.** The repro relies on `cv_base.id` resolving from
  two subquery levels out (user EXISTS → lineage scalar subquery → outer UPDATE
  target). The (k)/(m) tests confirm it resolves; the reviewer may want an even
  deeper nesting case if paranoid.
- **Taint reject path** (`unsupported-subquery-correlation` from a `select *` / TVF
  nested FROM *inside the lineage*) is exercised only by reasoning, not a dedicated
  test — it's unreachable for normal lineage shapes, but a reviewer could add a
  view whose computed lineage subquery sources a `select *` to lock the diagnostic.
