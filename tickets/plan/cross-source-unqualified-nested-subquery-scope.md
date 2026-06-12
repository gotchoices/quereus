description: Restore routing of an UNQUALIFIED partner-column read that is a genuine view-body projection but correlated INTO a nested value subquery of a cross-source `set`. The review of `cross-source-unqualified-body-projection` narrowed the unqualified-leaf resolution in `stripSideQualifier` to the TOP LEVEL of the SET value (to kill a silent wrong-result hazard), which also dropped the legitimate nested case. Re-enabling it soundly needs scope-aware traversal in the strip — distinguishing a bare leaf that binds to the embedded subquery's own from-source from one that correlates out to the view body.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts        # stripSideQualifier (~2454): substituteTop vs substituteQualified split; routePartnerRead; resolveColumnSide (~2809)
  - packages/quereus/src/planner/mutation/scope-transform.ts      # transformExpr / mapQueryExprUniform (scope-UNAWARE descent); makeViewColumnDescend is the scope-AWARE analog
  - packages/quereus/src/planner/mutation/single-source.ts        # makeViewColumnDescend (the scope-aware view-column descent to mirror)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic       # uq-1..uq-9; add nested-correlated bare-body-projection cases here
  - docs/view-updateability.md                                    # § Inner Join, cross-source `set` (~149) — the top-level-only restriction paragraph
difficulty: hard
----

# Scope-aware unqualified cross-source reads through nested value subqueries

## Background

`stripSideQualifier` lowers a join-view cross-source `set` value by rewriting partner-side
column references into correlated reads of the up-front `__vmupd_keys` capture. The
ticket `cross-source-unqualified-body-projection` added handling for a partner column
projected **unqualified** in the view body (e.g. `select c.cid as cid, cval, pv from c
join p …`, where `pv` lives only on `p`): the leftover bare base-term leaf is resolved to
its owning side by **unique column ownership** (`resolveColumnSide`) and, when partner-owned,
qualified + routed through the capture.

The implement pass applied that bare-leaf resolution via the **same** `substitute` closure
threaded through `transformExpr` + `mapQueryExprUniform` at **every** nesting depth. But
`mapQueryExprUniform` is **explicitly NOT scope-aware** (see its docstring) — it applies the
substitution to every column at every depth purely on the column's own qualifier. For
*qualified* refs that is sound (the qualifier is a syntactic property). For the new
*unqualified* branch it is **not**: a bare column nested inside a value subquery binds to
that subquery's own from-source, not the view sides. If its name collides with a partner
base column, the scope-unaware traversal mis-routed it into the partner's captured value —
a **silent wrong result**.

Repro that produced the wrong value (`cval` became the joined parent's `psecret` instead of
the inner table's): see review-findings case **uq-9** in `93.4-view-mutation.sqllogic`.

## What the review did (the narrowing this ticket reverses)

To eliminate the silent-corruption hazard, the review split the strip's substitution:

- **`substituteTop`** (top-level of the SET value): resolves an unqualified base-term leaf
  against the view sides. Sound here because a bare leaf at the top level originates from the
  view body's own projection lineage (injected by `substituteViewColumns`).
- **`substituteQualified`** (threaded into the scope-unaware subquery descent): qualified
  routing only; a bare leaf is **left untouched** (its pre-ticket behavior).

Consequence: a partner column projected **unqualified** in the body and referenced (as the
view column) **inside a nested value subquery** of the SET value — e.g.
`update v set cval = (select count(*) from t where x > pv)` where `pv` is the bare-projected
partner column — is no longer routed. It now raises `Column not found: pv` at build. The
**workaround** is to project the body column **qualified** (`select p.pv as pv …`), which
the qualified path routes correctly at any depth.

The qualified nested case already works and is unaffected; only the *bare-body-projection +
nested-correlated* combination regressed to an explicit error (from "works, or silently
corrupts on name collision").

## Goal

Make the strip distinguish, for a bare leaf at any depth, whether it:
- **correlates out** to the view body (a genuine partner/owning view-body projection) → resolve
  against the view sides and route as today; or
- **binds locally** to an embedded subquery's from-source → leave untouched.

This is precisely the scope question `mapQueryExprUniform` refuses to answer. The likely
shape is a scope-aware descent analogous to `makeViewColumnDescend` (single-source.ts),
which already threads from-source scope to decide whether a bare name is shadowed by an inner
source before substituting a view-column reference. The strip needs the same shadowing test
before applying `resolveColumnSide` to a bare leaf inside a subquery.

## Notes / scope

- Also covers the residual top-level edge the review left open: a bare **correlated outer**
  reference at the top level of the SET value whose name happens to collide with a partner
  base column would still be resolved against the sides by `substituteTop`. A fully
  scope-aware strip removes that theoretical mis-route too (it is far less reachable than the
  nested case — there is no from-source at the top level of an UPDATE SET value — but should
  fall out of the same fix).
- Add `93.4-view-mutation.sqllogic` cases: (i) bare-body-projection partner column correlated
  into a nested value subquery → routes correctly (the case this ticket restores); (ii) the
  uq-9 collision case must still resolve to the inner-scope column (regression guard — the fix
  must not reintroduce the silent mis-route).
- Keep `resolveColumnSide`'s ambiguity contract: a name owned by 2+ sides stays `undefined`
  (rejected at body planning today); the fix is about *scope*, not side-ambiguity.
