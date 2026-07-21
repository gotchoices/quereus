description: The query optimizer now decides which aggregates it can roll up from a materialized view by reading each aggregate's own declared algebra, instead of a hardcoded list of five aggregate names — so user-defined aggregates that declare the same algebra roll up automatically.
files: packages/quereus/src/planner/analysis/query-rewrite-matcher.ts, packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts, packages/quereus/test/query-rewrite-aggregate.spec.ts, docs/materialized-views.md, docs/mv-maintenance.md
difficulty: medium
----
## What shipped

The read-side aggregate-**rollup** matcher (answering a `group by g… agg(…)` query from a
grouped MV at a *coarser* group key by re-aggregating the stored partials) no longer
name-branches on `sum`/`count`/`min`/`max`/`avg`. Rollup soundness + the recombine recipe
are now decided entirely by each fragment aggregate's declared
[`AggregateAlgebra`](../../docs/schema.md#aggregate-function-algebra) (`merge`/`decode`/`decompose`),
resolved from the function registry by `(name, argc)`. Deleted: the closed
`'sum'|'count'|'min'|'max'|'avg'` recipe `kind` union, the `ROLLUP_SUM_LIKE` map, and the
name-branches in `recipeForRollup` + its rule consumer `buildRollupReplacement`.

**One source of truth.** A rollup's decomposability is now the same declaration the
write-side delta-aggregate arm (`feat-mv-agg-delta-arm`) already reads. Any UDAF that
declares algebra rolls up for free.

### The design (read this before reviewing — it deviates from the ticket's literal shape)

The ticket sketched a recipe carrying a `reaggFunc` **name** + an `emptyFill` value derived
from `finalize(cloneInitialValue(initialValue))`. I did **not** implement that shape, for a
correctness reason: the "directly-mergeable → re-aggregate with the aggregate's own
function" rule the ticket states is **wrong for `count`** — `count(countCol)` counts backing
rows, not the sum of stored counts; `count` must re-aggregate via *sum-of-counts*. There is
no name-only rule that gives `sum` for `count` yet `bit_xor` for a `bit_xor` UDAF.

Instead, the re-aggregation is **synthesized generically from the algebra itself**:

- **Directly mergeable** (declares `merge` + `decode`) — the rule builds a synthetic
  aggregate whose step folds each stored (finalized) partial through the aggregate's own
  `merge ∘ decode`, and finalizes with the aggregate's own `finalize`. This is exactly the
  roll-up semantics for *any* mergeable aggregate: `sum`←sum-of-sums, `count`←sum-of-counts,
  `min`/`max`←tightening, `bit_xor`←xor-of-xors. **The empty-group value falls out of
  `finalize(identity)`** (count→0, sum/min/max→NULL) — so there is **no `emptyFill` field and
  no `coalesce`**; the old `count`→`coalesce(sum,0)` special case is subsumed.
- **Decompose** (declares `decompose`, e.g. `avg`) — each sibling partial (`sum(x)`,
  `count(x)`) is re-aggregated by the mergeable path above, then recombined by the
  aggregate's declared `combine`, wrapped as a synthetic scalar function so the JS `combine`
  runs per output row. `avg`'s `sum/count` + NULL/0-over-zero-rows guard lives inside
  `combine`, so it falls out.
- **No usable algebra** (`total`, `group_concat`, `var_*`, `stddev_*`), **`merge` without
  `decode`**, or **any `distinct`** ⇒ decline (default-deny, forgoes only a speedup).

The recipe is now a structural union: `passthrough` (exact-key stored column, unchanged and
name-agnostic), `merge` (one `MergeReagg` = backing col + resolved schema), `compose`
(N `MergeReagg` partials + `combine`). A `resolveAggregate(name, argc) => schema` probe is
threaded from the rule (which holds the live `Database`) into the matcher, parallel to the
existing `DeterminismProbe` — the analysis module still imports no registry.

**Exact-key path is untouched** — it stays a name-agnostic passthrough (a stored
`group_concat` / `count(distinct)` still answers an exact-key query).

## Behavior preservation (the load-bearing claim)

The five builtins produce **byte-identical** rollup results to before — verified against the
existing optimizer + equivalence suites (all green). The subtle bit that makes the synthetic
sum re-aggregation safe: sum's `decode` sets `count: Infinity` (an absorbing witness);
merging many decoded sums does `count: a.count + b.count` = `Infinity + Infinity = Infinity`
(plain JS `+`, **not** `addWithPromotion`, so no `BigInt(Infinity)` throw), and `finalize`
only tests `count === 0`. All-NULL and zero-row groups are exercised by the equivalence
harness (it starts at 0 rows).

## How to test / validate / use

- **Matcher unit tests** — `packages/quereus/test/query-rewrite-aggregate.spec.ts`. Drive the
  matcher directly (rules disabled → pristine `Aggregate(Filter?(scan))`); assert the recipe
  shape per aggregate. Updated to the new union: `merge` recipes assert
  `recipe.reagg.schema.name`; `compose` asserts `partials.map(p => p.schema.name)`. Callers
  now pass an `aggResolver(db)` probe.
- **The free-UDAF-rollup proof (new)** — same file, `describe('… user-defined aggregate
  algebra')`. Registers a `bit_xor` UDAF (abelian group; declares `merge`+`negate`+`decode`),
  builds a grouped MV over it, and asserts (1) the matcher produces a `merge` recipe naming
  `bit_xor`, and (2) **end-to-end**: the rolled-up query returns identical rows with the
  rewrite on vs off, and the plan actually scans the MV backing (non-vacuous). This is the
  headline capability the retarget unlocks.
- **Equivalence backstop** — `packages/quereus/test/query-rewrite-equivalence.spec.ts`
  (`aggregate-rollup equivalence`). Unchanged; still passes. Random data incl. NULL/empty
  over sum/count/min/max/avg exact-key + rollup + global-scalar + rollup-with-residual.
- **Manual smoke**: `create materialized view v as select k, j, sum(x), count(*), avg(x)
  from t group by k, j;` then `select k, sum(x), avg(x) from t group by k;` → `query_plan()`
  shows a scan of `v` + a re-aggregate. Any UDAF with `merge`+`decode` in the MV body behaves
  the same.

### Validation run (all green)

- `yarn build` — full monorepo (tsc project refs + 3 bundled apps) — exit 0.
- Full `packages/quereus` suite — **7131 passing**, 13 pending, exit 0.
- `packages/quereus` lint (eslint + tsc test typecheck) — exit 0.

## Known gaps / where to look hardest (reviewer: treat tests as a floor)

- **Decompose path has no UDAF coverage.** Only `avg` (a builtin) exercises the `compose`
  branch end-to-end. A *user-defined* `decompose` aggregate is not tested — the `resolveMergeablePartial`
  generalization (esp. the `count(*)`-when-NOT-NULL fallback and partial-order preservation
  into `combine`) is covered only via `avg`. Worth an adversarial read.
- **Plan-output shape changed (intentionally, untested as a string).** The `count` rollup
  now emits a synthetic `count`-named re-aggregate (was builtin `sum`), and `avg`'s recombine
  is now a synthetic `agg_combine(...)` scalar function (was a `/` `BinaryOpNode`). No test
  asserts these plan strings; if any downstream tooling greps `query_plan()` for the old
  `sum(cnt)` / `/` shapes it would need updating. I found none.
- **Synthetic schemas are per-rewrite, unregistered.** `buildReaggAggregate` /
  `buildRecipeOutput` call `createAggregateFunction` / `createScalarFunction` on every rule
  fire. Cheap object construction, not memoized. NOTE left at the call sites is unnecessary —
  flagging here instead: if rollup rewriting ever shows up hot, these could be cached by
  `(schema, backingCol)`. Not a defect; a tripwire.
- **`decode` requirement for the mergeable path** is stricter than the ticket's "merge
  present" wording. A UDAF that declares `merge` but omits `decode` (and no `decompose`)
  declines rollup — sound (forgoes only a speedup), but if that ever seems surprising, the
  gate is `recipeForRollup` / `resolveMergeablePartial` (`!schema.algebra?.decode`).
- **Docs location differs from the ticket.** The ticket named `docs/optimizer.md`, but the
  rollup allowlist prose actually lives in `docs/materialized-views.md` (§ Aggregate rollup)
  — that's what I rewrote, plus the forward-reference in `docs/mv-maintenance.md`.
  `optimizer.md` had no allowlist language to change.

## Prereq

`feat-mv-agg-algebra-schema` (landed, commit `2ccbccf6`) supplied the `AggregateAlgebra`
declarations this consumes.
