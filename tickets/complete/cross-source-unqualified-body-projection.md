description: Multi-source view UPDATE resolves an UNQUALIFIED body-projection partner-column reference to its owning join side by unique column ownership inside `stripSideQualifier`, so a cross-source SET value (or an authored-inverse `new.<x>` forward read) reading a partner column projected bare rides the existing captured-read machinery instead of failing at base build with `Column not found`. Reviewed; one major soundness bug (silent wrong-result via scope-unaware bare resolution at depth) found and fixed inline, with a follow-up backlog ticket for full scope-aware nested support.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts        # stripSideQualifier: substituteTop/substituteQualified split (~2496) + routePartnerRead; signature `others`→`allSides`; caller lowerValueOntoSide (~1565)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # uq-1..uq-8 (implement) + uq-9 scope-guard regression (review)
  - docs/view-updateability.md                                   # § Inner Join, cross-source `set` (~149) — unqualified-projection + top-level-only restriction
prereq:
----

# Cross-source reads through unqualified body projections — COMPLETE

## What shipped

A join-view body may project a partner-side column **unqualified** when the name is
unambiguous across the sides (`select c.cid as cid, cval, pv from c join p …` — `pv` lives
only on `p`). `stripSideQualifier`'s leaf substitution now resolves such a bare base-term
reference to its owning side by **unique column ownership** (`resolveColumnSide` — the same
rule join-condition operands use):

- **owning/same-side or unresolvable** → leave bare (resolves in the lowered single-table
  UPDATE, or keeps its pre-existing pass-through);
- **partner-owned** → qualify with that side's alias and route through the identical
  `__vmupd_keys` capture path a qualified `b.y` read rides (`routePartnerRead`), so `a.av`
  and a bare `av` reading the same partner column share one `srcN` capture column.

`stripSideQualifier`'s signature changed `others` → `allSides` (the full index-aligned array,
needed so `resolveColumnSide`'s returned index is comparable to `owningSideIndex`); the sole
caller `lowerValueOntoSide` passes `analysis.sides`. Module-internal — no public surface
changed.

## Review findings

**Diff reviewed first, fresh, before the handoff summary** (`git show 443a599a`).

### Major — found and FIXED inline

**Silent wrong-result via scope-unaware bare resolution at nesting depth.** The implement
pass applied the new unqualified-leaf resolution via the **same** `substitute` closure
threaded through `transformExpr` + `mapQueryExprUniform` at **every** depth. But
`mapQueryExprUniform` is **explicitly NOT scope-aware** (its docstring states the substitution
decides "purely on the column's own qualifier … the enclosing scope is irrelevant"). For
*qualified* refs that is sound (qualifier = syntactic property). For the new *unqualified*
branch it is **not**: a bare column nested inside a value subquery binds to that subquery's
own from-source, not the view sides. When its name collides with a partner base column, the
scope-unaware traversal mis-routed it into the partner's captured value.

Confirmed with a concrete repro (now landed as **uq-9**): `update v set cval = (select
psecret from t where tid = 1)` where the view's partner side also has a `psecret` column.
Correct result `cval = 777` (`t.psecret`); the implement code produced `888` (the joined
parent's `p.psecret`). Verified it is a **regression** — the pre-implement code produced the
correct `777` (ran the repro against `6a887ef7`'s `multi-source.ts`); and the implement code
"supported" the genuine nested case only by luck-of-no-collision while silently corrupting on
collision.

The implementer's own gap (c) ("nested value-subquery unqualified read … routes identically
to the qualified nested path") was the blind spot: it assumed every nested bare ref is a
genuine partner ref, which the scope-unaware traversal cannot verify.

**Fix** (`multi-source.ts` ~2496): split the strip's substitution into
`substituteTop` (top level of the SET value — resolves a bare leaf against the view sides,
sound because a top-level bare leaf originates from the view body's own projection lineage)
and `substituteQualified` (threaded into the scope-unaware subquery descent — qualified
routing only; a bare leaf is left untouched, exactly its pre-ticket behavior). This kills the
silent corruption: a bare leaf inside a value subquery now binds to that subquery's
from-source. All 8 implement cases (uq-1..uq-8) stay green; uq-9 added as the regression
guard.

*Tradeoff documented + filed:* the conservative fix also drops the legitimate
bare-body-projection partner column **correlated into** a nested value subquery (it now
raises a clean `Column not found` instead of routing; workaround: project the body column
**qualified** `p.pv`, which routes at any depth). Restoring that case soundly needs
scope-aware traversal in the strip — filed as backlog
`cross-source-unqualified-nested-subquery-scope` (difficulty: hard). Docs updated with the
top-level-only restriction.

### Checked — no issue

- **Generated subquery not re-routed.** `transformExpr`'s column case returns
  `cloneExpr(replacement)` without recursing, so the emitted `capturedValueSubquery` (whose
  internal bare `<pk>` refs name the owning side's PK) is never re-substituted. Holds for both
  `substituteTop` and the descent. Confirmed.
- **`routePartnerRead` factoring / `srcN` dedup.** Qualified branch passes `col`;
  unqualified passes `{...col, table: <partner alias>}` — same `<table>.<col>` dedup key, same
  capture projection. Sound. (Plan-level dedup-count assertion still not pinned — gap (a)/(b);
  value-equivalence is proven by uq-5; low value, left as-is.)
- **Signature change `others`→`allSides`.** `resolveColumnSide` indexes into `allSides`, so
  the returned index is comparable to `owningSideIndex`. Correct; `otherQuals` still derived by
  skipping `owningSideIndex`. Sole caller updated.
- **Self-joins.** Plain bare base column → owned by both aliases → `resolveColumnSide`
  `undefined` (ambiguous) → left bare; a rename projection exposing one side carries a
  qualified base term → unchanged qualified path. New branch adds no unqualified self-join
  shape. Existing `ax_xs_self`/`ax_self` cover it.
- **Up-front gates.** `gateCrossSourceReads` (walks pre-substitution view term),
  `gateCrossSourceCardinality`, `viewColumnReadSides` all already resolve unqualified refs via
  `resolveColumnSide` — no change needed; confirmed via uq-7 (1:many bare reject) and uq-8
  (computed bare reject).
- **Preference-2 unreachability (gap d).** Body-planning ambiguity rejection is pre-existing;
  not pinned by a new test here. Acceptable — the branch is unreachable by construction and the
  claim is documented inline; not worth a speculative test in this pass.

### Validation

- `93.4-view-mutation.sqllogic` (uq-1..uq-9) → green.
- Full `@quereus/quereus` suite (`node test-runner.mjs`, memory vtab) → **5938 passing, 9
  pending, 0 failing** (the `[property-planner] Rule … never fired` lines are informational).
- `lint` → clean (exit 0). `build` (`tsc`) → exit 0.
- `test:store` (LevelDB) NOT run — change is purely planner-side AST lowering, vtab-agnostic
  (same deferral the implementer noted; a store spot-check remains cheap belt-and-suspenders).

## Follow-ups filed

- backlog `cross-source-unqualified-nested-subquery-scope` — scope-aware strip traversal to
  restore (soundly) the nested-correlated bare-body-projection read, and close the residual
  top-level correlated-outer-name collision edge.
