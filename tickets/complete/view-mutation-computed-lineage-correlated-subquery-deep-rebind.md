description: Fix (and review) the silent wrong-write when a single-source updateable view's COMPUTED column lineage contains a correlated scalar subquery and that view column is referenced inside a user UPDATE/DELETE subquery operand. The substituted-term qualifier, formerly shallow (top-level refs only), is now scope-aware and DEEP — it descends into a nested subquery within the replacement and qualifies only base-table columns not shadowed by the lineage subquery's own FROM, rejecting on an unresolvable nested FROM.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What shipped

`single-source.ts`'s substituted-term qualifier was **shallow**
(`transformExpr(expr, qualify-if-unqualified)`, no `descend`). For a `base`-kind
lineage (a bare `column` node) that sufficed, but a COMPUTED column whose lineage is
a correlated scalar subquery (`(select x from oth where fk = id) as note`) has its
correlation ref (`id`) one level down — never reached. Emitted inside a user
subquery whose FROM introduces a same-named column, the unqualified `id` re-bound to
the innermost local source by ordinary SQL scoping → `note` evaluated NULL → silent
no-op / wrong write.

The fix (all in `single-source.ts`):

- Replaced the shallow `qualifyUnqualifiedRefs(expr, qualifier)` with
  `makeBaseQualifier(ctx, baseTable) → (repl) => AST.Expression`, built at the call
  site where `analysis.baseTable` is in scope.
- Added `qualifyCorrelatedBaseRefs` (scalar) + `qualifyCorrelatedBaseRefsQuery`
  (query): a scope-aware DEEP qualifier mirroring `transformQueryExpr`'s
  `collectFromColumnNames` / `shadowed` logic (reusing `collectFromColumnNames` and
  `rebuildSelect` verbatim). Predicate: qualify an **unqualified base-table column
  not in `shadowed`**. At each nested `select` the lineage subquery's FROM column
  names join `shadowed`; a compound/union leg keeps the incoming `shadowed`; a
  `values` body keeps the incoming `shadowed`.
- Taint reject: an unresolvable nested FROM (`collectFromColumnNames` → `null`:
  `select *` / TVF / CTE) raises `unsupported-subquery-correlation`.
- Threaded `baseQualify?: (repl) => AST.Expression` through `makeViewColumnDescend`
  → `transformQueryExpr` → `makeViewSubstitute.resolve`. The three single-source
  rewriters build it via `makeBaseQualifier(ctx, analysis.baseTable)`; the
  multi-source spine still passes `undefined` (alias-qualified terms, no single
  base-table correlation name).

Restricting to **base columns** is the principled gate: a `normalizeBaseRefs`-
normalized lineage's top-level refs are all base columns (so it's a no-op there), and
a genuinely-local lineage column owned by the nested FROM is never qualified.

Docs: `docs/view-updateability.md` § Selection updated with the deep scope-aware
qualification, the base-column gate, the taint reject, and the amended "Known corner
(unfixed)" self-reference note.

## Review findings

**Method.** Read the implement diff (`dd9bd14e`) with fresh eyes before the handoff.
Traced the qualifier logic by hand (`makeBaseQualifier` → `qualifyCorrelatedBaseRefs`
→ `qualifyCorrelatedBaseRefsQuery`), confirmed `transformExpr`'s
substitute-then-clone semantics, and verified `baseQualify` runs **only** on the
subquery-descent path (top-level user WHERE/SET use `remapper`, not
`makeViewSubstitute`) — so the new taint-reject can only fire for a lineage that
itself contains a subquery, never for a plain reference. Confirmed
`collectFromColumnNames` / `rebuildSelect` are reused verbatim (DRY). Confirmed no
dangling references to the removed `qualifyUnqualifiedRefs` / `baseQualifier`.

**Validation re-run (all green):**
- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn workspace @quereus/quereus test` — **4243 passing, 9 pending** (full memory
  suite; count unchanged because the new assertions live inside the single 93.4 `it`).
- `yarn lint` (quereus) — clean.

**Bug-still-fixed verification:** reverted only `single-source.ts` to its parent and
re-ran 93.4 — block (k) fails exactly as documented (`{id:1,lbl:'A'}` instead of
`'CHANGED'`, a silent no-op), proving (k) is a genuine pre-fix regression guard, not
a vacuous assertion. Restored the source (byte-identical, confirmed via empty diff).

**Correctness:** No defects found in the shipped logic. The scope-aware descent, the
base-column gate, the `shadowed` accumulation (FROM names joining for clauses /
nested subqueries, incoming-`shadowed` kept for union legs and `values`), and the
taint-reject are all sound. The `cloneExpr`-on-replacement path does not
re-substitute, so no double-qualification.

**Test gaps found and fixed inline (minor):** the implementer's tests (k)/(l)/(m)
covered the happy path, the negative control, and the DELETE path — but two distinct
parts of the new machinery had **no deciding test**:

- *(n) lineage-subquery taint reject.* The existing taint tests (93.4 blocks
  (e)/(f)) taint the **user** subquery; nothing exercised
  `qualifyCorrelatedBaseRefsQuery`'s own reject when the unresolvable FROM is **inside
  the lineage term**. Added block (n) — a computed lineage
  `(select x from (select * from cn_oth) as s where s.fk = id)` referenced inside a
  user subquery. Verified the raised message is the lineage-path diagnostic
  specifically (expected substring tightened to `not statically resolvable`, unique
  to that message), so the test cannot pass on an unrelated earlier rejection.

- *(o) the `shadowed`-set logic, isolated from the base-column gate.* In (k)/(l)/(m)
  the lineage-local columns (`cv_oth.fk`/`.x`) are excluded by the base-column gate
  alone (they are not base columns), so the `shadowed` accumulation is never the
  deciding factor — it could be removed entirely and every prior test would still
  pass. Added block (o): the lineage subquery's own FROM (`so_oth`) introduces an
  `id` that **collides** with the base column `so_base.id`, used as a genuinely-local
  filter (`... and id = 1`). Only the shadow set keeps that `id` bound to `so_oth.id`;
  without it the base-column gate would wrongly qualify it to `so_base.id`. Verified
  by mutation: deleting `...local` from `innerShadow` makes (o) fail with
  `Scalar subquery returned more than one row` (the local filter vanishes), confirming
  (o) locks the shadow logic.

  Both new blocks pass against the shipped code; the full suite stays at 4243 passing.

**Major finding filed (not fixed here):** the **same-base-table self-reference
corner** — when the user subquery FROM names the *same* base table the view lowers
to, the base-table-**name** qualifier (`p1_t.lbl`) binds the innermost local `p1_t`
rather than the outer target, a silent wrong write. This was deliberately deferred by
both this ticket and its predecessor (`...subquery-base-term-local-rebind`) and lived
only in doc prose with **no tracking ticket**. Filed
`tickets/backlog/view-mutation-single-source-self-reference-alias-on-target.md` to
track the alias-on-target hardening (synthesise a collision-proof alias on the lowered
target, or reject loudly). It is orthogonal to the deep qualification and out of scope
for an AST-rewrite-confined change. Doc note confirmed accurate.

**Observation (no action):** this implement commit (`dd9bd14e`) also carries
**comment-only** additions to `packages/quereus/src/planner/analysis/coverage-prover.ts`
(two `COMPLETENESS LIMITATION` notes about bushy-lookup-side / single-IND-match
two-hop cover) that belong to a *different*, now-deleted ticket
(`coverage-prover-ind-two-hop-completeness`) bundled into this commit. They are
accurate documentation, touch no logic, and do not affect this fix — noted for the
record only (mild violation of "don't combine unrelated tickets", not worth a
revert). The `multi-source.ts` change is a one-word comment rename
(`baseQualifier` → `baseQualify`) consistent with this fix.

**Docs:** read `docs/view-updateability.md` § Selection against the shipped code — the
deep-qualification paragraph, the base-column-gate rationale, the taint-reject, and
the self-reference known-corner note all match reality.

## Deferred / known limitations

- *Same-base-table self-reference corner* — tracked in
  `tickets/backlog/view-mutation-single-source-self-reference-alias-on-target.md`.
- *Base-alias-qualified lineage correlation ref* (`(select x from oth where fk = b.id)`
  over `from base b`) — `normalizeBaseRefs` keeps `b.id` and the deep qualifier only
  touches *unqualified* refs, so `b` won't resolve in the lowered statement. No worse
  than pre-fix; not exercised by any test; not filed (a separate widening, lower value
  than the self-reference corner). Recorded here so it is not lost.
- Store mode not run (per AGENTS.md; the change is purely AST-rewrite planner layer
  with no store interaction).
