----
description: Review the new aggregate-argument match site that lets aggregate subqueries nested inside other aggregate subqueries become set-based (grouped joins) instead of only the outermost level.
prereq: quereus-decorrelate-scalar-agg-subquery-project
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts, packages/quereus/test/logic/07.7.2-scalar-agg-decorrelation-nested.sqllogic, docs/optimizer-rules.md
----

# Review: nested scalar-aggregate subquery decorrelation (aggregate-argument site)

## What was built

A second match site for the existing scalar-aggregate decorrelation rewrite,
registered as `scalar-agg-decorrelation-aggregate` on `PlanNodeType.Aggregate`
in the Structural pass (adjacent to the Project-site entry in
`optimizer.ts`). It fires when an `AggregateNode`'s aggregate-argument or
group-by expressions contain a correlated scalar-aggregate subquery — the
shape a nested subquery takes after the Project-site rule rewrites its
enclosing level (that rewrite's outer-reference remap turns
`qv.entry_id = e.id` into `qv.entry_id = lei.entry_id`, making the two-level
correlation local).

Implementation is a thin wrapper over the prerequisite's machinery:
- `decorrelateOne` (recognition, gates, remap, empty-group CASE marker) is
  reused verbatim; the shared driver loop was factored into `decorrelateAll`
  and candidate collection into `collectCandidates` (pure refactor — the
  Project-site behavior is unchanged, its 10 pre-existing spec tests still
  pass untouched).
- New `rebuildAggregate` rebuilds the enclosing `AggregateNode` over the
  join-stacked source with `preserveAttributeIds = agg.getAttributes()`, so
  group-by references, HAVING (a Filter above the aggregate), and everything
  upstream resolve unchanged by attribute id.

Cardinality safety for placing a LEFT join *below* an aggregate: the grouped
subtree's GROUP BY keys are a unique key on its output, so the join matches
at most one row per source row — group row count and multiplicity (hence
DISTINCT-aggregate sets) are preserved exactly.

**Multi-level convergence needed no new driver**: the Structural pass is
top-down with rules firing *before* descent (`pass.ts` `traverseTopDown`), so
the grouped aggregate built by one level's rewrite is visited later in the
same traversal and the aggregate site fires on the next level. Verified
empirically to 3 levels.

## Use cases to validate against

- **Motivating 2-level query** (entries → items → quantifier values,
  `json_group_array(json_object(...))` at both levels): plan has zero
  `ScalarSubquery` nodes, two grouped `HashAggregate`s (one a descendant of
  the other), hash joins throughout. Covered in both the spec and sqllogic.
- **3-level nesting** converges fully (three grouped aggregates).
- **Empty groups at each level**: entry with no items → NULL at level 1;
  item with no quantifier values → NULL at level 2 (engine's
  `json_group_array` over a zero-row scalar subquery yields NULL — the ticket
  text assumed `'[]'`, but NULL is the *correlated baseline's* behavior and
  the rewrite reproduces it exactly; equivalence is asserted mechanically).
  Nested `count` inside `sum` exercises the non-NULL empty-value CASE marker
  below an aggregate.
- **Top-level (user-written) GROUP BY aggregate** with a correlated subquery
  in its argument decorrelates too — nesting is the motivation, not a
  precondition. HAVING evaluated against preserved attribute ids is
  undisturbed.
- **Group-by-expression site** (correlated subquery as a GROUP BY key) fell
  out for free and is pinned by a sqllogic case.
- **Sibling subqueries in one aggregate argument** each get their own stacked
  join; result equality vs baseline asserted.
- **Remap-bailed level 1** (NOCASE correlation + outer ref in the aggregate
  argument): level 1 stays correlated, both levels stay correct (spec asserts
  deep-equality against a Database with both rule ids disabled).
- **DML gate**: a write-bearing branch is refused at *every* level containing
  it (any level's rewrite would change the write's firing count — the ticket's
  "blocks only its own rewrite" reading holds for *siblings*: a pure sibling
  subquery still rewrites; test covers this).

## How correctness is checked

- `test/plan/scalar-agg-decorrelation.spec.ts` — new describe block (7 tests):
  plan-shape golden assertions (no ScalarSubquery, ≥2 grouped aggregates with
  the nesting relationship, ≥2 physical hash/merge joins) plus
  **baseline-equivalence** tests that run the same query on a second Database
  with `disabledRules: {'scalar-agg-decorrelation',
  'scalar-agg-decorrelation-aggregate'}` and deep-equal the results — the
  "byte-identical to the correlated baseline" requirement, enforced
  mechanically rather than by hand-written expectations.
- `test/logic/07.7.2-scalar-agg-decorrelation-nested.sqllogic` — 9 queries
  over the full 5-table hierarchy per the ticket.
- Full package suite: 7019 passing, 0 failing; `yarn lint` (eslint + test
  tsc) clean; `yarn build` clean.

## Known gaps / notes for reviewer

- **Cost tripwire (NOTE in code, at `ruleScalarAggDecorrelationAggregate`)**:
  the aggregate site can fire on an aggregate *inside* a still-correlated
  subquery (enclosing remap bailed, nested correlation local). Correct, but
  the grouped subtree then re-executes per outer row — whether that beats the
  per-inner-row correlated plan is data-dependent. Parked under the existing
  `backlog/feat-decorrelation-cost-model`.
- **sqllogic array-order sensitivity**: `json_group_array` expectations encode
  element order, which follows source scan/join order. The pre-existing 07.7
  file already does this (precedent), and `yarn test` is green, but
  `yarn test:store` (LevelDB path) was not run here per AGENTS.md guidance —
  if store iteration order ever differs, these expectations would surface it.
- **No serialized golden-snapshot file** was added; the "golden plan" guard is
  the spec's structural plan assertions (same approach the prerequisite took).
  The existing golden corpus is unaffected (full suite green).
- Docs extended in `docs/optimizer-rules.md` (the prerequisite's rule bullet);
  the ticket named `packages/quereus/docs/optimizer.md`, which does not exist —
  rule docs live at repo-root `docs/`.
- Stream-vs-hash physical selection: the grouped subtrees select
  `HashAggregate` (join output carries no useful ordering), confirmed in plan
  probes/spec — no ordering-requirement interaction observed.
