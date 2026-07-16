----
description: Queries with a correlated aggregate subquery in the SELECT list (e.g. a count of child rows per parent) used to re-run the subquery once per parent row; they are now rewritten into a single grouped left join so the child table is scanned once. Review the new optimizer rule for correctness, especially empty-group semantics and the bail conditions.
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/analysis/scalar-subqueries.ts, packages/quereus/src/planner/analysis/equi-correlation.ts, packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/func/registration.ts, packages/quereus/src/runtime/emit/aggregate.ts, packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic, packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts, packages/quereus/test/optimizer/decorrelation-analysis.spec.ts, docs/optimizer-rules.md
difficulty: hard
----

# Review: scalar-aggregate subquery decorrelation into grouped joins

## What was built

New Structural-pass rewrite rule `scalar-agg-decorrelation`
(`rule-scalar-agg-decorrelation.ts`), registered in `optimizer.ts` right after
`fanout-lookup-join` / `join-elimination` and adjacent to
`subquery-decorrelation`, `sideEffectMode: 'aware'`, no cost gate.

Transformation (per recognized subquery, stacked left-deep for multiples):

```
Project[..., ScalarSubquery(Agg(Filter(corr ∧ rest, inner))) ...](outer)
→ Project[..., <guarded read> ...]
    LeftJoin[corr verbatim](outer,
      Aggregate(groupBy=[inner corr cols], agg=[orig agg])(Filter(rest, inner)))
```

Key design points a reviewer should validate:

- **Attribute-id preservation trick**: the grouped `AggregateNode` is built with
  `preserveAttributeIds = [innerCorrAttrs..., originalAggValueAttr]`, i.e. the
  group-by output columns reuse the *inner correlation columns' attribute ids*
  (the same id-preservation `ProjectNode` applies to bare column refs). This
  lets the original correlation conjuncts serve **verbatim** as the join
  condition, and hash-join equi-pair extraction / physical selection see plain
  `colref = colref` pairs. Verified live: plan shows `LEFT HASH JOIN` over
  `HashAggregate GROUP BY`.
- **Empty-group guard ("count bug")**: empty-input value computed at plan time
  via the exact runtime zero-row path
  (`schema.finalizeFunction(cloneInitialValue(schema.initialValue))` — the
  clone helper was MOVED from `runtime/emit/aggregate.ts` to
  `func/registration.ts` and re-exported for the emitters, so the planner
  shares it without a planner→runtime import). NULL empty value (sum/min/max/
  avg/json_group_array/group_concat) → bare column read (join miss is already
  NULL). Non-NULL (count → 0, total → 0.0) →
  `CASE WHEN <group key> IS NULL THEN <literal> ELSE <value> END`.
  **Deviation from the ticket**: no `1 AS __present` marker column/Project —
  the first group key is the miss marker. Soundness: a matched join row's key
  satisfied `outer.a = key` so it is non-NULL; a NULL-keyed inner group can
  never match any outer row; therefore `key IS NULL ⇔ join miss`. Documented in
  the rule header. Reviewer: adversarially check this equivalence.
- **Outer-reference remap**: refs to outer attrs left in the retained subtree
  (aggregate args, deeper source) are replaced by the equated inner colref,
  gated per-pair on `isValueDiscriminatingEquality` (no weak collation) AND
  same `logicalType.name`. Any unremappable outer ref → bail. Backstop:
  `collectExternalReferences(newAggregate)` must be empty or bail.
- **Bail conditions** (subquery stays correlated, per-row plan intact):
  uncorrelated / correlates past immediate outer; side-effecting inner;
  root not a zero-group single-`AggregateFunctionCallNode` `AggregateNode`
  beneath bare Project/Alias wrappers (Sort/LimitOffset wrappers bail;
  the wrapper-chain identity check is `agg.getAttributes()[0].id ===
  subquery.getAttributes()[0].id`, which any aliasing/computing wrapper fails);
  aggregate source not a `FilterNode` directly; no equi-conjunct; residual
  conjunct referencing outer (covers non-equi correlation); non-deterministic
  finalize; empty value not foldable to a primitive literal (throws / Promise /
  native JSON object).

## Shared-helper refactor

- `analysis/scalar-subqueries.ts`: `collectScalarSubqueries` +
  `substituteSubqueries` (generalized to `ReadonlyMap<ScalarSubqueryNode,
  ScalarPlanNode>`) factored out of `rule-fanout-lookup-join.ts`.
- `analysis/equi-correlation.ts`: `isEquiCorrelation`, `collectDefinedAttrIds`,
  `referencesAnyAttr` factored out of `rule-subquery-decorrelation.ts`.
  Both source rules now import; behavior unchanged.

## Validation performed

- `yarn lint` (eslint + tsc test typecheck) clean.
- Full workspace `yarn test` green: quereus 7011 passing / 0 failing (was 6995
  before the 16 new tests), all other packages green. Existing correlated
  scalar subquery tests (07.6-subqueries.sqllogic), golden plans, and
  `parallel-fanout.spec.ts` unchanged and green with the rule ACTIVE — the
  rule fires on those pre-existing correlated-aggregate queries and produces
  identical results.
- New tests:
  - `test/logic/07.7-scalar-agg-decorrelation.sqllogic` — count(*)/count(col)/
    sum/min/max/avg/total/group_concat/json_group_array; empty groups; NULL
    outer and inner keys; duplicate outer keys; composite correlation; residual
    predicates; wrapped (`coalesce`) and expression-embedded subqueries;
    multiple subqueries per SELECT; remapped outer ref in aggregate arg;
    DISTINCT aggregate; rejected shapes (LIMIT-1, multi-row error preserved,
    non-equi, uncorrelated, NOCASE remap bail) still correct.
  - `test/plan/scalar-agg-decorrelation.spec.ts` — asserts ScalarSubquery
    dissolved, grouped Hash/StreamAggregate under a Hash/Merge join, stacked
    joins for multiple subqueries, and ScalarSubquery RETAINED for every bail
    shape.
  - `test/optimizer/decorrelation-analysis.spec.ts` — unit tests for the shared
    helpers.

## Known gaps / notes for reviewer (starting points, not a finish line)

- **Filter must sit directly under the Aggregate.** A pass-through
  Project/Alias between them, or a correlated conjunct that pushdown relocated
  into a join branch inside the subquery (multi-table inner `FROM x JOIN y`
  where the correlation lands on a branch filter), bails — correct but
  unoptimized. The ticket's headline example (`from lei join i on … where
  lei.entry_id = e.id`) decorrelates only if the correlated conjunct stays in
  the top Filter; worth verifying against a real multi-join inner shape and
  filing a follow-up if pushdown strands it lower.
- **GROUP BY inner subquery is unreachable**: the builder rejects it earlier
  ("Scalar subquery must return exactly one column" — group cols are exposed
  alongside the aggregate). The rule still guards `groupBy.length !== 0`
  defensively; the sqllogic pins the build-time error.
- **`json_group_array` empty-group value is NULL in this engine** (finalize of
  an empty native array returns null), not `'[]'` as the ticket sketch assumed.
  Consistency with the correlated path holds by construction (same finalize
  path); the sqllogic pins `j: null` for empty groups.
- **ORDER BY inside an aggregate call** is rejected by the parser
  (see 07.2-aggregate-order-by.sqllogic), so the order-sensitive-aggregate
  wrapper concern reduces to: Sort wrappers bail. No ordering can be silently
  dropped.
- **Remote-latency interaction**: `fanout-lookup-join` (earlier in manifest
  order) consumes these subqueries when its latency/branch gates pass; when it
  declines (e.g. a single subquery below `minBranches`), this rule now fires on
  remote plans too — that changes plans that previously stayed correlated.
  `parallel-fanout.spec.ts` is green, but a reviewer with remote-vtab context
  should confirm no fixture asserts "stays correlated" for a shape this rule
  now claims.
- **No golden-plan snapshot added** — plan shape is asserted structurally in
  the plan spec instead. Add a golden under `test/plan/` corpora if the
  reviewer wants byte-stable coverage.
- **No cost gate** (per ticket): tiny-outer/huge-inner regressions are
  possible and explicitly parked in `backlog/feat-decorrelation-cost-model`.
- The ticket's `files:` header referenced `packages/quereus/docs/optimizer.md`;
  the actual doc surface is repo-root `docs/optimizer-rules.md` (rule catalog)
  — a detailed entry was added there next to `ruleSubqueryDecorrelation`.
