description: Review side-alias-qualification of bare lineage leaves at view-column substitution time (multi-source analog of single-source baseQualify) and the revert of stripSideQualifier to a purely qualifier-driven rule.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts        # makeSideQualifyScope (new), substituteViewColumns (sides param + sideQualify), stripSideQualifier (reverted to qualifier-only), 4 call sites
  - packages/quereus/src/planner/mutation/single-source.ts       # docstring-only updates (makeBaseQualifier, makeViewScope, makeViewColumnDescend)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # uq-10..uq-15 added; uq-* section header + uq-9 comment refreshed
  - docs/view-updateability.md                                   # § Inner Join, cross-source `set` — top-level-only restriction replaced with injection-qualification
difficulty: medium
----

# Review: side-alias-qualify bare lineage leaves; strip is qualifier-only again

## What was built

The SET-value/WHERE/RETURNING lowering for join views is two walks: (1) the
scope-aware view-column → base-term substitution (`substituteViewColumns` over
`makeViewColumnDescend`), then (2) the qualifier strip (`stripSideQualifier`).
Previously, a partner column the body projected BARE (`select c.cid as cid, cval,
pv from c join p …`) injected a bare lineage leaf, which walk 2 then resolved
against the view sides — but only at the value's top level, because resolving bare
names inside the scope-unaware strip descent is unsound (it can't tell a lineage
leaf from a user-authored local name).

Now walk 1 **side-alias-qualifies bare lineage leaves at injection time**:

- New `makeSideQualifyScope(sides, view)` (multi-source.ts, next to
  `substituteViewColumns`): a `ScopeContext` whose substitution qualifies a bare,
  non-shadowed leaf with its uniquely-owning side's **alias** (via
  `resolveColumnSide`); a name on no side stays bare (lineage-internal
  correlated/local); a name on 2+ sides is unreachable for genuine lineage (body
  planning rejects ambiguous bare projection). `unresolvableScope: 'reject'`,
  `rejectDmlSubquery` — both `unsupported-subquery-correlation`, mirroring
  single-source `makeBaseQualifyScope`.
- `substituteViewColumns` gained a `sides` param; `sideQualify =
  transformScopedExpr(ctx, scope, repl)` is applied to every replacement — in the
  top-level substitute AND as `makeViewColumnDescend`'s `baseQualify`. All four
  call sites pass `analysis.sides` (non-preserved SET value ~1518,
  `lowerValueOntoSide` ~1581, RETURNING projection ~2210, identifying predicate
  ~2399).
- `stripSideQualifier` reverted to ONE qualifier-only substitute threaded
  uniformly (`substituteTop` and its bare-resolution branch deleted; the
  "Preference 2" rationale moved into `makeSideQualifyScope`'s docstring).
  `routePartnerRead`, both gates (`gateCrossSourceReads`,
  `gateCrossSourceCardinality`), and owning-quals-first self-join ordering are
  unchanged.
- Docstrings updated in both files; docs § Inner Join cross-source `set` rewritten
  (the "top level only … must be projected qualified" restriction is gone).

## Why this shape (vs. resolving bare names in the strip)

- A scope-aware strip could not distinguish a lineage leaf from a user-authored
  bare name post-hoc → encapsulation leak (a hidden partner column like `psecret`
  silently routed through the capture) and a residual silent-wrong (computed
  lineage `(pv * 2)` whose bare `pv` collides with an inner FROM column would be
  "shadowed" and left to rebind). Qualifying at injection keeps every scope
  decision in walk 1, where shadowing/taint is already proven per-reference, and
  the restored case rides the strip's existing, already-tested qualified routing.

## Test surface (93.4-view-mutation.sqllogic)

- **uq-10**: bare-projected partner `pv` read inside a nested value subquery →
  routed through the capture; cval = 250 (sum of tv ≤ joined pv=200).
- **uq-11** (the silent-wrong this fixes): computed `pc = pv * 2` (body wrote `pv`
  bare); the value subquery's FROM also has a `pv` column. Asserts 350 (qualified
  `p.pv`), where a rebind to the inner `pv` would yield null.
- **uq-12**: bare nested view-col ref under a `select *` subquery source →
  structured `unsupported-subquery-correlation` reject ("cannot be proven
  correlated"), the multi-source analog of single-source case (f).
- **uq-13**: uq-7's 1:many shape with the bare partner read nested → still
  rejected `cross-source-ambiguous-cardinality` at plan time (the gate fires at
  the rewrite site, which covers depth).
- **uq-14** (encapsulation): nested bare ref to a hidden partner column
  (`psecret`, absent from the inner FROM) → `Column not found`, NOT silently
  routed.
- **uq-15** (WHERE-path free fix, e1/g analog): renamed bare projection
  (`plabel as label`) referenced inside an EXISTS whose FROM also has `plabel` —
  correlates to the join body (rows joined to P10 take the write); the old code
  would have rebound and updated nothing.
- **uq-9** unchanged assertion (regression guard for the original mis-route);
  comment block rewritten for the new mechanism. uq-1..uq-8 (incl. uq-5 srcN
  dedup and uq-6 authored inverse) pass unchanged.

## Validation done

- `yarn build` (root, all packages), `yarn lint` (quereus), `yarn test` (root,
  all workspaces) — all green: quereus 5977 passing / 9 pending, no failures
  anywhere. Targeted run: `yarn test:single
  "packages/quereus/test/logic.spec.ts" --grep "93.4"`.
- Searched tests for assertions on the legacy `cross-source-assignment` /
  `Column not found` messages for this shape — none exist (the no-carrier-path
  diagnostic improvement is safe).

## Known gaps / reviewer attention

- **Nested computed-partner reads are now reachable for bare-projected lineage**
  (uq-11): `gateCrossSourceReads` (`no-inverse`) only walks TOP-LEVEL refs, so a
  computed partner column read inside a value subquery is admitted via per-leaf
  base capture (the scalar expression applies on read — value-correct since every
  leaf has base lineage). This top-level/nested asymmetry PRE-EXISTS (a
  qualified-projection computed column behaved the same); the change just makes
  it reachable for bare projection. Worth confirming the asymmetry is acceptable
  vs. uq-8's top-level reject.
- **Behavior change, loud-over-silent**: lineage containing a `select *` / TVF
  subquery now REJECTS on substitution (`makeSideQualifyScope`'s reject policy)
  where it previously substituted unqualified (a potential silent mis-bind). No
  existing test covered that shape; no new test pins it (it mirrors
  `makeBaseQualifyScope`'s documented single-source policy).
- **Parked hazards, deliberately not chased** (per the implement ticket): (a) the
  capture subquery's bare owning-PK correlation (`k.k0_0 = cid`) can rebind when
  the user's inner FROM has a same-named column — backlog
  `multi-source-capture-correlation-alias-collision`; uq-10/uq-11 avoid the
  collision. (b) an inner FROM alias colliding with a side alias mis-routes
  qualified refs in the strip's uniform descent — backlog
  `cross-source-strip-side-alias-shadowing`.
- `returning *` still clones lineage WITHOUT substitution/qualification
  (intentional — bare lineage is unambiguous over the join body it projects).
- The double walk (sideQualify inside `substituteViewColumns`'s top-level
  substitute, then `transformExpr`'s clone of the returned replacement) does one
  redundant clone per substitution — negligible, but a reviewer may prefer it
  noted.
