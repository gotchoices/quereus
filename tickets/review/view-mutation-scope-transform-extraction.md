description: Phase A of the derived-backward-walk debt: the triplicated scope-aware column-substitution primitive (single-source.ts / multi-source.ts / lens-enforcement.ts) is now ONE shared module, `planner/mutation/scope-transform.ts`, exposing a `ScopeContext`-driven scope-aware descent. Pure refactor — zero behavior change, proven by the unchanged test suite (4273 passing). Phase B (retire the plan→AST→re-plan round-trip; consume the threaded `UpdateSite` directly incl. inverse profiles; converge the decomposition fan-out) was too large/risky for one pass and is decomposed into three same-stage implement tickets (see "Phase B handoff" below).
files: packages/quereus/src/planner/mutation/scope-transform.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md

## What landed (Phase A — the DRY extraction)

The "rewrite column references X→Y in an expression / query, scope-aware (shadowing,
taint, deep subquery descent)" primitive existed in three near-parallel copies. It is
now **one** module: `planner/mutation/scope-transform.ts`.

`scope-transform.ts` owns:
- **the structural expression walker** — `transformExpr`, `cloneExpr`,
  `cloneQueryExpr`, `mapQueryExprUniform`, and the private `rebuildSelect` /
  `rebuildFrom` (relocated verbatim from `single-source.ts`);
- **FROM-source column-name resolution** — `collectFromColumnNames` and its
  `fromSourceColumnNames` / `tableSourceColumnNames` / `projectionOutputNames`
  helpers (relocated verbatim), which build the shadow set;
- **the scope-aware descent** — `transformScopedExpr(ctx, scope, expr)` and
  `transformScopedQuery(ctx, scope, query, shadowed, tainted)`, parameterized by a
  `ScopeContext` value object: `{ makeSubstitute(shadowed, tainted), unresolvableScope:
  'taint' | 'reject', rejectUnresolvableScope?(), rejectDmlSubquery() }`. The descent
  owns the shared mechanics: shadow accumulation across nested scopes, taint
  propagation, the `unsupported-subquery-correlation` reject path, and sibling-leg
  (compound/union) scoping.

The two scope-aware functions that `single-source.ts` previously hand-wrote
(`transformQueryExpr` for the view-col→base-term descent, and
`qualifyCorrelatedBaseRefs` / `qualifyCorrelatedBaseRefsQuery` for the deep
base-term correlation-qualifier) are now **two `ScopeContext`s** built in
`single-source.ts` (`makeViewScope` + `makeBaseQualifyScope`), each ~30 lines,
differing only in their substitution rule and unresolvable-scope policy:
- **view-descent** (`makeViewScope`): substitutes a view-column reference (qualified by
  the view name, or unqualified-and-not-shadowed) to its base term, applying the
  optional `baseQualify` to a term emitted inside a subquery. `unresolvableScope:
  'taint'` (an unqualified, ambiguous reference is rejected per-reference once tainted).
- **base-qualify** (`makeBaseQualifyScope`): qualifies an unqualified, unshadowed
  base-table column with the base table name. `unresolvableScope: 'reject'` (shadowing
  can't be proven → reject rather than risk an over/under-qualify silent wrong write).

`makeViewColumnDescend` / `makeBaseQualifier` survive as thin wrappers
(`transformScopedQuery` / `transformScopedExpr` over the relevant `ScopeContext`), so
their public signatures — and every caller — are unchanged.

`multi-source.ts`, `decomposition.ts`, and `lens-enforcement.ts` now import the
structural walkers from `scope-transform.js` (not `single-source.js`):
- `multi-source.ts` `substituteViewColumns` already delegated to `transformExpr` +
  `makeViewColumnDescend` (the shared scope-transform); `stripSideQualifier` to
  `transformExpr` + `mapQueryExprUniform` (the uniform, non-scope-aware variant). Both
  now ride the shared module.
- `lens-enforcement.ts` `rewriteToBasisTerms` is a top-level-only `transformExpr`
  rewrite over the shared walker.
- `decomposition.ts` `substituteViewColumns` / `stripAnchorQualifier` /
  `rewriteAssignedValue` ride the shared `transformExpr` / `cloneExpr`.

## The load-bearing invariant the reviewer should attack

**This is a pure refactor — behavior must be byte-for-byte identical.** Every
diagnostic message (`unsupported-subquery-correlation` for a tainted view-col ref, for
an unresolvable lineage subquery, and for an embedded DML subquery) was preserved
verbatim in the `ScopeContext` reject callbacks. The faithfulness claim that most
deserves adversarial scrutiny is the **generalization of the two hand-walks into one
descent**:

- The original `transformQueryExpr` computed `scopeTainted = tainted || unresolvable`
  and `innerShadow = unresolvable ? shadowed : shadowed ∪ local`. The generalized
  descent does the same: `local === null` (and policy `'taint'`) → `innerShadow =
  shadowed`, `scopeTainted = true`; else → `innerShadow = shadowed ∪ local`,
  `scopeTainted = tainted`. Confirm the `values` branch, the `onNested` (inherits
  inner) vs `onLeg` (keeps incoming) split, and the entry-at-∅-shadow/false-taint are
  all preserved.
- The original `qualifyCorrelatedBaseRefsQuery` **rejected** on `local === null`; the
  generalized descent does this via `unresolvableScope: 'reject'` →
  `rejectUnresolvableScope!()`. Confirm the base-qualify substitute still ignores the
  `tainted` arg (it rejects before taint can arise) and still gates on
  `baseCols.has(name) && !shadowed.has(name)`.
- The known **self-reference corner** documented in `docs/view-updateability.md`
  § Selection (a subquery FROM naming the *same* base table) is unchanged — this
  refactor touches *whether/how* refs are qualified, not *which name*.

## Tests / validation (the floor, not the ceiling)

- `yarn workspace @quereus/quereus run build` — green.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus test` — **4273 passing, 9 pending**, including:
  - `test/property.spec.ts` § View Round-Trip Laws (Tier A single-source + Family B
    multi-source inner join + Family C decomposition) — the acceptance gate for the
    backward walk;
  - the `93.x-view-mutation*.sqllogic` suites and `lens-enforcement.spec`.
- Grep gate met: `transformQueryExpr` / `makeViewSubstitute` /
  `qualifyCorrelatedBaseRefs(Query)` return **nothing** in `src/` (the retired helpers
  are gone; the scope-aware logic lives only in `scope-transform.ts` + its two
  `ScopeContext`s).

**Reviewer suggestions (this test surface is a floor):** the existing harness exercises
the scope-aware *taint/shadow* paths only indirectly. High-value spots to probe by hand
or with a targeted test: (a) a nested predicate subquery whose FROM is a `select *` /
TVF (taint → reject for an unqualified view-col ref); (b) a computed view-column lineage
that is itself a correlated scalar subquery (`note = (select x from oth where fk = id)`)
written through a single-source UPDATE WHERE-subquery (the deep base-qualify path); (c)
the multi-source `substituteViewColumns` descent into an `exists (...)` predicate. These
were correct before; the refactor must not have perturbed them.

## Phase B handoff (deferred — decomposed into same-stage implement tickets)

Phase A deliberately stands alone and **de-risks** Phase B by giving it one substitution
primitive to thread. Phase B — consume the threaded `updateLineage` / `attributeDefaults`
/ `viewComplement` off the planned operator tree directly, retire the lossy
plan→AST→re-plan round-trip, unlock inverse-profile column writes, and converge the
decomposition fan-out — is a deep, high-risk change to the well-tested multi-source
substrate (`analyzeJoinView` + `decomposeUpdate/Delete` + the identity capture + the
RETURNING re-query). It was **too large for one safe pass**; a half-migrated substrate is
worse than a clean handoff. Per the ticket's own guidance it is decomposed into three
`prereq:`-chained `implement/` tickets, each gated by the View Round-Trip Law harness:

1. `view-mutation-multisource-threaded-updatesite` — consume the full `UpdateSite`
   (incl. `inverse` / `domain`) in `analyzeJoinView`; route + invert assignments to an
   `inverse`-profile column through a join body; add Family-B law coverage. (Headline
   feature unlock; still lowers to AST.)
2. `view-mutation-retire-ast-roundtrip` (prereq: #1) — build the per-side base writes +
   identifying predicate from the already-planned body node, retiring the
   lower-to-AST-and-re-plan double-plan for multi-source update/delete.
3. `view-mutation-decomposition-plan-node-consumer` (prereq: #2) — converge the
   `decomposition.ts` fan-out onto the same plan-node consumer.

The `docs/view-updateability.md` § Implementation Surface "Forward note" / "Surface
authority" callout updates (which operators still degrade lineage) belong with #2 (when
the substrate actually consumes the plan-node walk), not Phase A — Phase A changed no
consumption behavior, so the doc's current statements remain accurate.
