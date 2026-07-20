<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-20T14:27:34.450Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\feat-mv-delta-aggregate-arm.plan.2026-07-20T14-27-34-450Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
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
/** Optional algebraic structure over the accumulator. Absent field = property not held.
 *  Algebra functions are peers of stepFunction: they see the same accumulator
 *  representation and the same comparison/collation context step sees. */
algebra?: {
	/** Commutative, associative combine of two accumulators, with (a clone of)
	 *  initialValue as identity — a commutative monoid. Enables partial
	 *  aggregation: rollup, sharded/parallel aggregation, delta insert-tightening. */
	merge: (a: AggValue, b: AggValue) => AggValue;
	/** Group inverse: merge(a, negate(a)) ≡ identity — lifts the monoid to an
	 *  abelian group. Enables retraction (delete/update), i.e. full delta
	 *  maintenance. Retracting one source row x is merge(acc, negate(step(identity, x))). */
	negate?: (a: AggValue) => AggValue;
	/** Section of finalizeFunction: reconstruct a working accumulator from the
	 *  STORED output value. Required for backing-delta maintenance because the
	 *  backing row holds finalized values, not accumulators. Omit when finalize
	 *  is identity-like (count); trivial for sum (stored v → {sum: v}, NULL → null);
	 *  IMPOSSIBLE for avg (the quotient forgets the count) — which is precisely
	 *  what makes avg non-delta-maintainable as a stored column (see `decompose`). */
	decode?: (stored: SqlValue) => AggValue;
	/** Rewrite recipe onto sibling partial aggregates: this aggregate's value is
	 *  a scalar expression over other (algebra-complete) aggregates — e.g.
	 *  avg(x) ≡ sum(x) / count(x). Lets a stored column be maintained by
	 *  delta-maintaining its partials when they are ALSO stored in the same body,
	 *  and lets the read-side rollup recombine it. */
	decompose?: AggregateDecomposition;
}
```

**Laws** (the UDAF author's contract — see verification below):

1. `merge` associative + commutative; `merge(a, identity) ≡ a`.
2. Step/merge coherence: `step(a, x) ≡ merge(a, step(identity, x))` — every row's
   contribution is expressible as a mergeable singleton, so per-statement deltas fold.
3. `merge(a, negate(a)) ≡ identity`, hence retract∘insert of the same row is a no-op.
4. Decode is observational: `finalize(merge(decode(finalize(a)), b)) ≡ finalize(merge(a, b))` —
   a stored value round-trips to an accumulator that behaves identically under further merges.
   (Not bijectivity: sum's decode maps stored 5 to `{sum: 5}` even if the true accumulator saw
   NULLs — sound because NULL contributions are merge-identity for sum.)

Every behavior then **derives generically** — no per-function branches anywhere downstream.
A stored aggregate column is:

- **delta-maintainable** ⇔ (`negate` ∧ decodable) — sum, count, total, bit-xor, any UDAF over
  an abelian group. Fold the statement's changes per group; one read-modify-write per affected
  group at flush.
- **tighten-only** ⇔ (`merge` ∧ no `negate`) — min, max, bit_or/and, bool_or/and. Inserts
  merge in; a retraction that could relax the stored value falls back to the key-filtered
  residual recompute *for that group only*. min/max are not special cases — this is the
  general no-inverse rule.
- **decomposition-maintained** ⇔ (`decompose` ∧ every partial present as a sibling stored
  column ∧ each partial delta-maintainable) — delta-maintain the partials, re-evaluate the
  combine expression per affected group at flush. This is the general form of the avg
  treatment; a UDAF like geometric mean declares `decompose` onto sum-of-logs + count.
- **neither** (any `distinct` aggregate, order-sensitive `group_concat`, UDAFs declaring
  nothing): the body keeps `'residual-recompute'` exactly as today. Exclusion is structural,
  never a name list. An author whose accumulator cannot round-trip through the stored value
  and has no decomposition can still get delta maintenance **compositionally**: store the
  encoded accumulator as the MV column (finalize = identity from the engine's view) and
  finalize in a plain view over the MV — no engine machinery, just the layering the engine
  already provides.

**Group emptiness needs multiplicity.** A retraction that empties a group must emit the point
delete, but `sum = NULL` does not distinguish "no rows" from "all-NULL rows". Structural
resolution ladder, no special cases: (a) the body stores a column whose algebra proves
multiplicity (a `count(*)`-shaped column — detected by algebra, not by name) → use it;
(b) otherwise this MV keeps the residual arm for deletes/updates (inserts may still delta);
(c) the general fix is the Z-set / hidden-multiplicity backing already sketched in
`docs/todo.md` § Bag materialization — that ticket, if it lands, removes case (b) entirely
and is the natural convergence point.

**Law verification (trust, then check).** The engine cannot prove user-declared laws, so:
export a `fast-check`-based law harness (validate an `AggregateFunctionSchema.algebra` against
generated inputs — laws 1-4 above) as a testing utility plugin authors run against their own
functions; run it over every builtin in CI; and extend the maintenance-equivalence oracle with
a test-registered UDAF that declares algebra (plus a negative twin with a deliberately broken
law, pinning that the harness catches it). The equivalence harness remains the end-to-end
net: a violated law surfaces as `read(MV) != evaluate(body)`.

Consumers to unify on the declarations (this is a requirement, not an aside):

1. **Write-side delta arm** (this ticket's core).
2. **Read-side rollup matcher** — retarget `query-rewrite-matcher.ts` onto the same
   declarations and delete the hardcoded allowlist/kind union. One source of truth; UDAF
   rollup falls out for free. (`count`'s zero-rows `coalesce` wrapper derives from
   `finalizeFunction(initialValue)`, the same trick `rule-scalar-agg-decorrelation.ts` already
   uses generically.)
3. Future, not this ticket: sharded/parallel aggregation and sliding window frames read
   `merge`/`negate` from the same field.

## `avg` is just the first `decompose` client

`avg` is currently special-cased on the read side (recombine as `sum(sumCol)/sum(countCol)`,
requires stored partials). Under this design it is nothing special: its builtin declares
`decompose` onto `sum(x)` / `count(x)` with combine `s / c` (Quereus `/` is already real
division, matching native `avg`; NULL/0 over the empty group ⇒ NULL), and both the write-side
delta arm and the read-side rollup consume that declaration through the same generic
decomposition path any UDAF uses. A separate plan-time canonicalization `avg(x) →
sum(x)/count(x)` remains worth evaluating as an engine-wide simplification, but is no longer
load-bearing for this ticket. No hidden-column plumbing in either case: a decomposed column is
maintainable only when its partials are stored as sibling columns; otherwise that MV keeps the
residual arm — structural, honest, and visible to the user in the body they wrote.

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
  either accepts drift consistent with SQL sum semantics or declines `negate` (declaring
  `merge` only, degrading gracefully to tighten+rescan). The declaration seam makes this a
  per-function choice, not an engine branch.
- NULL semantics derive from the existing fold: `step` and the negate-of-singleton retraction
  see the same argument NULLs; `count(x)` vs `count(*)` differ only in their step functions.
  Law 4's observational form is what makes NULL-blind decodes sound (sum's decode need not
  know how many NULLs the true accumulator ignored).
- Oracle: `test/incremental/maintenance-equivalence.spec.ts` must pass unchanged, including
  rollback and NULL zoos; extend its shape zoo with merge-only (min/max retraction) and
  UDAF-declared-algebra cases.
- Value-identical no-op suppression (MV-016) still applies: a delta landing on the same stored
  value reports nothing.

Cost gate: extend `maintenanceCost` with the delta strategy (O(1) per change; expected
rescan probability for merge-only aggregates) so the backward gate picks
delta > residual > rebuild per body shape.
