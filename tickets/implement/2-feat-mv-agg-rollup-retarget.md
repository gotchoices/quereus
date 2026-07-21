description: Make the read-side query optimizer decide which aggregates it can roll up from a materialized view using each aggregate's declared algebra, instead of a hardcoded list of five aggregate names — giving one source of truth and letting user-defined aggregates roll up for free.
prereq: feat-mv-agg-algebra-schema
files: packages/quereus/src/planner/analysis/query-rewrite-matcher.ts, packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts, packages/quereus/test/optimizer/, docs/mv-maintenance.md, docs/optimizer.md
difficulty: medium
----
## Goal

Retarget the read-side aggregate-rollup matcher onto the `AggregateAlgebra` declarations from
`feat-mv-agg-algebra-schema` and **delete the hardcoded allowlist**: the literal
`'sum' | 'count' | 'min' | 'max' | 'avg'` kind union (`query-rewrite-matcher.ts:162`), the
`ROLLUP_SUM_LIKE` map (`:1173`), and the name-branching in `recipeForRollup` (`:1196`) and its
consumer `buildRollupReplacement` (`rule-materialized-view-rewrite.ts:639,679,683`). After
this, a rollup's soundness is decided by the aggregate's declared `merge`/`decompose`, so any
UDAF that declares algebra rolls up for free and there is exactly one source of truth for "is
this aggregate decomposable."

Behavior must be **preserved** for the existing five aggregates: same rewrites accepted, same
declined. The equivalence + optimizer suites are the backstop.

## Current shape (what to replace)

`matchAggregateFragmentToMv` (`query-rewrite-matcher.ts:546`) builds a per-fragment-aggregate
`AggregateRecipe` via `recipeForExact` / `recipeForRollup`. The recipe's `kind` (a closed
union of 5 names) tells `buildRollupReplacement` how to re-aggregate the backing partials:
- `sum`/`min`/`max` → re-aggregate `f(storedCol)`;
- `count` → `coalesce(sum(storedCol), 0)`;
- `avg` → `sum(sumCol) / sum(countCol)` (needs two stored partials).

Exact-key matches (`recipeForExact`) already pass any aggregate through as a stored-column
passthrough — that path is name-agnostic and **stays as-is**. Only the **rollup** (superset
group-key) path is name-gated; that is what retargets.

## Target design

Drive the rollup recipe off the fragment aggregate's **declared algebra**, resolved from the
function registry by `(funcName, numArgs)`:

- **Directly mergeable** (`algebra.merge` present, no `decompose`) — reconstruct `f(x)` by
  re-merging the stored partial across the rolled-up groups. The re-aggregate operator is the
  *same aggregate function* applied to its own stored partial column (`sum`←`sum`, `min`←`min`,
  `max`←`max`, `count`←`sum`-of-counts). Replace the `kind`-switch with: re-aggregate using
  the fragment aggregate's own function over the stored partial — **except** the identity/empty
  handling that today's `count` `coalesce(...,0)` encodes.
- **Empty-group finalize.** The `count`→`coalesce(...,0)` special case is the aggregate's
  finalize-of-identity showing through: `count` over zero rows is `0`, not NULL. Derive it
  generically from `finalize(cloneInitialValue(schema.initialValue))` — the same trick
  `rule-scalar-agg-decorrelation.ts` already uses. When that finalized-identity value is
  non-NULL and differs from a bare re-aggregate's zero-row result, wrap the re-aggregate in
  `coalesce(<reagg>, <finalized-identity>)`. For `sum` finalized-identity is NULL (no wrap);
  for `count` it is `0` (wrap) — reproducing today's behavior without naming either.
- **Decompose** (`algebra.decompose` present — `avg`) — the recipe recombines onto the named
  partials. Reuse the existing avg two-partial machinery but generalized: for each partial in
  `decompose.partials`, find the sibling stored aggregate (`func`, `arg`), re-aggregate it
  (directly-mergeable, recursively via the rule above), then apply `decompose.combine` as the
  scalar expression over the re-aggregated partials. The current `avg` NULL/0 guard is exactly
  `avg`'s `combine`, so it falls out. A decompose whose partials are not all stored as sibling
  columns ⇒ `aggregate-not-decomposable` (as today).
- **No algebra** (`total`, `group_concat`, `var_*`, distinct-anything) ⇒
  `aggregate-not-decomposable`. `isDistinct` still hard-declines under rollup regardless of
  declared algebra (a distinct aggregate is never a plain merge of partials).

`AggregateRecipe.kind` (the closed union) is **removed**; replace it with a structural
descriptor the rule can consume without a name switch — e.g.
`{ reaggFunc: string; backingCols: number[]; emptyFill?: SqlValue }` for the mergeable case and
a `decompose`-carrying variant for the composed case. Keep exact-key passthrough as its own
trivial variant (stored column, no re-aggregate).

The matcher needs a registry probe to resolve a fragment aggregate's schema. It already takes
`isDeterministic: DeterminismProbe`; add a parallel `resolveAggregate(funcName, numArgs) =>
AggregateFunctionSchema | undefined` probe (threaded from the rule, which has the `Database`).
Do **not** import the registry into the analysis module — keep it a probe, matching the
existing `DeterminismProbe` seam.

## TODO

- [ ] Add an aggregate-schema resolver probe param to the aggregate-arm matcher entry points
      (`matchAggregateFragmentToMv`, `matchAggregateMaterializedViewRewrite`); wire it from
      `rule-materialized-view-rewrite.ts` off the live `Database` function registry.
- [ ] Replace `AggregateRecipe.kind` with a structural recipe (mergeable: reaggFunc +
      backingCols + optional emptyFill; decompose: partials + combine + per-partial recipes;
      exact-passthrough). Update the interface + all references.
- [ ] Rewrite `recipeForRollup` to consult declared algebra: directly-mergeable → self-reaggregate
      + finalize-of-identity emptyFill; `decompose` → recurse onto partials + `combine`; else
      decline. Delete `ROLLUP_SUM_LIKE` and the name union.
- [ ] Rewrite `buildRollupReplacement` (`rule-materialized-view-rewrite.ts:~600–690`) to build
      the re-aggregate + optional `coalesce` + `combine` scalar expression from the structural
      recipe. Delete the `recipe.kind` switch (`:639`) and the `avg`/`count` name branches
      (`:679,683`).
- [ ] `count`'s `coalesce(...,0)` must now come from `finalize(identity)`; verify byte-identical
      output to today via the existing optimizer rollup tests.
- [ ] Add a test-registered UDAF that declares `algebra` (e.g. a `bit_xor`-style abelian group,
      or a decompose like geometric-mean → `sum(log)`+`count`) and assert it rolls up through
      an MV — the free-UDAF-rollup proof the retarget unlocks.
- [ ] `docs/mv-maintenance.md` (§ read-side rollup) + `docs/optimizer.md`: replace the "hardcoded
      decomposable allowlist" language with "driven by declared aggregate algebra."
- [ ] `yarn build && yarn test && yarn lint` green; optimizer rollup suite unchanged.

## Edge cases & interactions

- **Exact-key vs rollup divergence.** Exact-key (`recipeForExact`) must stay name-agnostic
  passthrough — a `group_concat`/`count(distinct)` stored column answers an exact-key query
  even though it never rolls up. Don't accidentally route exact-key through the algebra gate.
- **avg count-partial NULL alignment.** The existing `recipeForRollup` avg branch has a subtle
  rule: `count(x)` always qualifies as the divisor, but `count(*)` only when `x` is NOT NULL
  (`:1224`). Preserve this — `decompose.partials` names `count(same-arg)`, so a stored
  `count(x)` matches directly; the `count(*)`-when-NOT-NULL relaxation must be retained as an
  explicit fallback in the partial-resolution step, not lost in the generalization.
- **Finalize-of-identity purity.** `finalize(cloneInitialValue(...))` must be pure and
  side-effect free at plan time; `group_concat`'s initialValue is a thunk — only call it for
  aggregates that reach the mergeable path (which excludes group_concat).
- **Group-key-pinned reorder guard.** The `clausePinsOrEquatesGroupCol` forgo (`:674`) is
  independent of aggregate decomposability — leave it untouched.
- **Residual-on-rollup soundness.** The residual-conjunct-references-only-group-columns gate
  (`:659`) is orthogonal to the recipe change — leave it.
- **Determinism probe still required.** A UDAF that declares algebra but is non-deterministic
  must still be declined by the existing `mvBodyHasNonDeterminism` gate — algebra ≠ determinism.
- **Unknown-arity resolution.** Resolve the aggregate schema by `(funcName, argc)` where
  `count(*)` is argc 0 and `count(x)`/`sum(x)` argc 1 — the same key `getFunctionKey` uses. A
  fragment aggregate whose `(name, argc)` resolves to no schema ⇒ decline (defensive).
