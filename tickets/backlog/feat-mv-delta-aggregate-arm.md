description: Let aggregate functions declare their algebraic structure (how to combine and retract values) once on the function schema, then use those declarations to maintain aggregate materialized views by pure arithmetic on the stored group row — no re-reading of source rows, and user-defined aggregates participate for free.
prereq: mv-maintenance-statement-batching
files: packages/quereus/src/schema/function.ts, packages/quereus/src/func/builtins/aggregate.ts, packages/quereus/src/planner/analysis/query-rewrite-matcher.ts, packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/planner/cost/index.ts, docs/mv-maintenance.md
----
## Motivation

A single-source aggregate MV (`select g…, sum(x), count(*) … group by g…`) is maintained by
the `'residual-recompute'` arm: every change to a group re-runs a key-filtered re-execution of
the body — a scheduler invocation plus a rescan of the group's source rows, O(group size) per
change. For algebraically well-behaved aggregates none of that is necessary: an insert of
`(g, x)` can update the stored group row arithmetically — `sum += x`, `n += 1` — with zero
source reads. This is standard incremental-view-maintenance delta algebra.

## Design principle: declare the algebra once, on the function schema

The engine currently knows which aggregates are decomposable in exactly one place — and it is
the wrong place: a hardcoded name-keyed allowlist inside the read-side rollup matcher
(`query-rewrite-matcher.ts` — the literal union `'sum' | 'count' | 'min' | 'max' | 'avg'` and
its recombination recipes). A write-side delta arm must NOT introduce a second copy. Instead,
follow the established advertisement pattern (`TableValuedFunctionSchema.relationalAdvertisement`):
add an optional algebraic declaration to `AggregateFunctionSchema` (`schema/function.ts`),
alongside the existing `stepFunction`/`finalizeFunction`/`initialValue` fold:

```ts
/** Optional algebraic structure over the accumulator. Absent field = property not held. */
algebra?: {
	/** Commutative, associative combine of two accumulators (semigroup with the
	 *  existing initialValue as identity). Enables partial aggregation: rollup,
	 *  sharded/parallel aggregation, delta insert-tightening. */
	merge?: (a: AggValue, b: AggValue) => AggValue;
	/** Inverse of stepFunction (abelian group). Enables retraction — full delta
	 *  maintenance under insert/update/delete. */
	inverse?: AggregateReducer;
}
```

Every behavior then **derives generically** — no per-function branches anywhere downstream:

- `inverse` present (sum, count, total, bit-xor…): full delta maintenance — fold the
  statement's changes into a per-group accumulator delta, apply with one read-modify-write per
  affected group. A group whose maintained `count(*)` reaches 0 maps to the point delete.
- `merge` only (min, max, bit_or/and, bool_or/and): inserts tighten the stored value via
  `merge`; a retraction that could relax it falls back to the existing key-filtered residual
  recompute *for that group only*. min/max are not special cases — "no inverse ⇒ rescan on
  retraction" is the general rule and their behavior falls out of it.
- neither (any `distinct` aggregate, `group_concat`, UDAFs that declare nothing): the body
  keeps `'residual-recompute'` exactly as today. Exclusion is structural, never a name list.
- User-defined aggregates that declare `algebra` participate in all of the above with zero
  engine changes — the point of the seam.

Consumers to unify on the declarations (this is a requirement, not an aside):

1. **Write-side delta arm** (this ticket's core).
2. **Read-side rollup matcher** — retarget `query-rewrite-matcher.ts` onto the same
   declarations and delete the hardcoded allowlist/kind union. One source of truth; UDAF
   rollup falls out for free. (`count`'s zero-rows `coalesce` wrapper derives from
   `finalizeFunction(initialValue)`, the same trick `rule-scalar-agg-decorrelation.ts` already
   uses generically.)
3. Future, not this ticket: sharded/parallel aggregation and sliding window frames read
   `merge`/`inverse` from the same field.

## `avg`: eliminate the special case rather than generalize it

`avg` is special-cased on the read side (recombine as `sum(sumCol)/sum(countCol)`, requires
stored partials) and would need hidden partial columns on the write side. Prefer evaluating a
**plan-time canonicalization `avg(x) → sum(x) / count(x)`** (standard in other engines): if
sound for Quereus typing (`/` is already real division, matching native `avg`; NULL-over-empty
falls out as NULL/0 ⇒ NULL), avg vanishes from the algebra entirely and both existing special
cases are deleted. If canonicalization is rejected (typing or plan-shape cost), fall back to
requiring the body to store the partials (the read-side rollup's existing stance) — but do not
add hidden-column plumbing.

## Fit with the maintenance substrate

The five maintenance arms are whole-body shape matchers; a possible future unification is a
compositional per-operator delta substrate (the "unified maintenance substrate" direction,
which would also fold in the assertion `DeltaExecutor`). This ticket must stay
substrate-independent: all aggregate-specific knowledge lives in the schema declarations; the
arm (whether implemented as a sixth `kind` or a fast path inside `'residual-recompute'` —
prefer the latter if it avoids another plan interface) is a thin generic consumer that a
future substrate retargets without touching the declarations. Do not bake function names,
kind unions, or recombination recipes into planner/runtime code anywhere.

Interaction with `mv-maintenance-statement-batching` (prereq): deltas accumulate per (MV,
group key) in the per-statement `MaintenanceBatch` and apply as one read-modify-write per
affected group at the statement flush. Bulk-load maintenance becomes O(affected groups) per
statement with no source rescans; the statement-batching degrade-to-rebuild gate remains the
escape hatch, though delta should usually win.

## Correctness constraints

- Reads-own-writes and lockstep commit/rollback identical to the other bounded-delta arms
  (same backing connection, same savepoint behavior).
- Numeric fidelity: repeated float add/subtract drifts where a rescan would not. Policy must
  be settled at plan stage — e.g. integer/bigint accumulators delta exactly; float `sum`
  either accepts drift consistent with SQL sum semantics or declines `inverse` (declaring
  `merge` only, degrading gracefully to tighten+rescan). The declaration seam makes this a
  per-function choice, not an engine branch.
- NULL semantics derive from the existing fold: `step`/`inverse` see the same argument NULLs,
  `count(x)` vs `count(*)` differ only in their step/inverse pair.
- Oracle: `test/incremental/maintenance-equivalence.spec.ts` must pass unchanged, including
  rollback and NULL zoos; extend its shape zoo with merge-only (min/max retraction) and
  UDAF-declared-algebra cases.
- Value-identical no-op suppression (MV-016) still applies: a delta landing on the same stored
  value reports nothing.

Cost gate: extend `maintenanceCost` with the delta strategy (O(1) per change; expected
rescan probability for merge-only aggregates) so the backward gate picks
delta > residual > rebuild per body shape.
