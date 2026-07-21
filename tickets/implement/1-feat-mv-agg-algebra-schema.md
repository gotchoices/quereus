description: Teach aggregate functions to declare, once on their schema, how their values combine and reverse — so the engine can maintain aggregate materialized views and roll them up from one source of truth instead of a hardcoded list of known aggregate names.
prereq:
files: packages/quereus/src/schema/function.ts, packages/quereus/src/func/registration.ts, packages/quereus/src/func/builtins/aggregate.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/incremental/, docs/mv-maintenance.md, docs/schema.md
difficulty: hard
----
## Goal

Add an optional **algebraic-structure declaration** to `AggregateFunctionSchema` — the single
place the engine learns how an aggregate's accumulator combines (`merge`), reverses
(`negate`), reconstructs from a stored value (`decode`), and rewrites onto sibling partials
(`decompose`). Declare it on the built-in aggregates. Ship a `fast-check` law harness that
validates a declaration against generated inputs, run it over every builtin in CI.

This ticket adds **only** the declarations + verification. The two consumers land separately
(`feat-mv-agg-rollup-retarget` read-side, `feat-mv-agg-delta-arm` write-side), both `prereq`
on this. Nothing downstream reads the field yet after this ticket, so it must be net-neutral:
build + full suite green, no behavior change.

## The declaration

Add to `AggregateFunctionSchema` (`schema/function.ts:245`), peer to
`stepFunction`/`finalizeFunction`/`initialValue`:

```ts
/** Optional algebraic structure over the accumulator. Absent field = property not held.
 *  Algebra fns are peers of stepFunction: same accumulator representation, same
 *  comparison/collation context step sees. AggValue is the opaque accumulator type. */
export interface AggregateAlgebra {
	/** Commutative, associative combine of two accumulators; identity is a clone of
	 *  initialValue (a commutative monoid). Enables partial aggregation. */
	merge: (a: AggValue, b: AggValue) => AggValue;
	/** Group inverse: merge(a, negate(a)) ≡ identity (lifts the monoid to an abelian
	 *  group). Enables retraction. Retracting one source row x is
	 *  merge(acc, negate(step(identity, x))). Absent ⇒ tighten-only. */
	negate?: (a: AggValue) => AggValue;
	/** Reconstruct a working accumulator from the STORED (finalized) output value.
	 *  Required for backing-delta maintenance (the backing holds finalized values, not
	 *  accumulators). Omit when finalize is identity-like (count → stored int IS the
	 *  accumulator). IMPOSSIBLE for avg (the quotient forgets the count → declare
	 *  `decompose` instead). */
	decode?: (stored: SqlValue) => AggValue;
	/** This aggregate's value is a scalar expression over OTHER (algebra-complete)
	 *  sibling aggregates — e.g. avg(x) ≡ sum(x)/count(x). Lets a stored column be
	 *  maintained by delta-maintaining its partials, and lets the read-side rollup
	 *  recombine it. */
	decompose?: AggregateDecomposition;
}

/** A decomposition of one aggregate onto sibling partial aggregates. */
export interface AggregateDecomposition {
	/** The partials this aggregate is composed from. Each names a sibling aggregate by
	 *  function name and how its argument relates to this aggregate's argument. */
	readonly partials: ReadonlyArray<{
		/** Sibling aggregate function name (e.g. 'sum', 'count'). */
		readonly func: string;
		/** 'same-arg' → f(thisArg); 'star' → count(*)-shaped (no argument). */
		readonly arg: 'same-arg' | 'star';
	}>;
	/** Build the composed *finalized* value from the partials' finalized values, in
	 *  `partials` order. Must reproduce this aggregate's finalize exactly (incl. the
	 *  empty-group / divide-by-zero case → e.g. avg NULL/0 ⇒ NULL). */
	readonly combine: (partialValues: readonly SqlValue[]) => SqlValue;
}
```

Thread `algebra?: AggregateAlgebra` through `AggregateFuncOptions` and
`createAggregateFunction` (`func/registration.ts:95,232`).

### Laws (the UDAF author's contract — what the harness checks)

1. `merge` associative + commutative; `merge(a, identity) ≡ a`.
2. Step/merge coherence: `step(a, x) ≡ merge(a, step(identity, x))`.
3. `merge(a, negate(a)) ≡ identity` (retract∘insert of the same row is a no-op).
4. Decode observational: `finalize(merge(decode(finalize(a)), b)) ≡ finalize(merge(a, b))` —
   a stored value round-trips to an accumulator that behaves identically under further
   merges. **Not bijectivity**: sum's decode maps stored 5 → `{sum:5}` even if the true
   accumulator saw NULLs (sound because a NULL contributes merge-identity).
5. (decompose) `finalize(a) ≡ combine([finalize(p) for each partial p of a's inputs])` over
   any accumulator `a` and its induced partial accumulators.

Accumulator equivalence for the laws is **finalize-then-byte-compare** (`rowsValueIdentical`
semantics, `util/comparison.ts`) — two accumulators are equal iff they finalize to the same
stored value. This is what makes decode observational rather than structural.

## Builtin declarations

Declare in `func/builtins/aggregate.ts`. Accumulator shapes are already there — reuse them.

| aggregate | numArgs | merge | negate | decode | decompose | delta class |
|---|---|---|---|---|---|---|
| `count(*)` | 0 | `a+b` | `-a` | stored int (identity) | — | abelian group; **row-multiplicity witness** |
| `count(x)` | 1 | `a+b` | `-a` | stored int (identity) | — | abelian group |
| `sum(x)` | 1 | `{sum:a.sum+b.sum}` (null=identity) | `{sum:-a.sum}` | stored v→`{sum:v}`, NULL→null | — | abelian group **(exact only for integer domain — see gate below)** |
| `min(x)` | 1 | binary-min | **none** | stored v→`{min:v}`, NULL→null | — | tighten-only (merge, no negate) |
| `max(x)` | 1 | binary-max | **none** | stored v→`{max:v}`, NULL→null | — | tighten-only |
| `avg(x)` | 1 | `{sum:a.sum+b.sum,count:a.count+b.count}` | `negate both` | **impossible** | `sum(x)/count(x)` | decompose-only |
| `total(x)` | 1 | — | — | — | — | **declare nothing** (float running sum; drift ⇒ non-delta) |
| `group_concat`, `var_*`, `stddev_*` | | — | — | — | — | declare nothing |

Notes:
- `sum` **declares** `merge`+`negate`+`decode` unconditionally. Exactness is a *value-domain*
  property the function cannot see, so the write-side arm gates on the argument's static type
  (see `feat-mv-agg-delta-arm`). The read-side rollup already sums exact partials.
- `min`/`max` merge must use the **same** `compareSqlValuesFast(..., BINARY_COLLATION)` the
  step uses, so merge and step agree byte-for-byte.
- `avg.combine([sumV, countV])` = `countV === 0 || countV == null ? null : sumV / countV`
  (real division, matching native `avg`; NULL/0 empty group ⇒ NULL). Its `partials` are
  `[{func:'sum',arg:'same-arg'},{func:'count',arg:'same-arg'}]`.
- `total` deliberately declares nothing: a float running sum drifts under retraction and would
  diverge byte-exactly from a fresh live re-sum, which the maintenance-equivalence oracle
  compares byte-exactly. Keeping it residual is correct, just not incremental.

## Law harness

Export a `fast-check`-based validator (a testing utility, not engine code — place under
`packages/quereus/test/incremental/` or a `test/util/` module so plugin authors can import it
from the test surface). Signature roughly:

```ts
export function assertAggregateAlgebraLaws(
	schema: AggregateFunctionSchema,
	valueArb: fc.Arbitrary<SqlValue>,   // domain of legal argument values incl. NULL
): void   // runs fc.assert over laws 1–5 for whichever fields are present
```

- Generate argument-value arrays; build accumulators by folding `step` from a cloned
  `initialValue` (`cloneInitialValue`); check each law that applies to the declared fields.
- Compare accumulators by `finalize`-then-byte-equal (law 4's equivalence).
- For `decompose`, register/resolve the named partials from the same function registry and
  check law 5.

CI spec: run `assertAggregateAlgebraLaws` over every builtin that declares `algebra`
(count*/countX/sum/min/max/avg) with a domain-appropriate `valueArb` (integers for sum/count
exactness; mixed comparable values + NULL for min/max). A **negative twin**: a deliberately
broken declaration (e.g. a `negate` that returns identity) must make the harness FAIL — pin
that the harness catches a law violation (wrap in `expect(() => assert...).to.throw`).

## TODO

- [ ] Add `AggregateAlgebra` + `AggregateDecomposition` interfaces and the `algebra?` field to
      `AggregateFunctionSchema` (`schema/function.ts`). Import `AggValue`, `SqlValue`.
- [ ] Thread `algebra?` through `AggregateFuncOptions` + `createAggregateFunction`
      (`func/registration.ts`).
- [ ] Declare `algebra` on count(*), count(x), sum, min, max, avg per the table
      (`func/builtins/aggregate.ts`). Leave total / group_concat / var / stddev undeclared.
- [ ] Write `assertAggregateAlgebraLaws` (fast-check) + a CI spec running it over the declared
      builtins, incl. the broken-declaration negative twin.
- [ ] `docs/schema.md`: document the algebra declaration + the UDAF author contract (laws).
      `docs/mv-maintenance.md`: one forward-reference note that the declarations exist and name
      the two consumer tickets (fill in when they land).
- [ ] `yarn build && yarn test && yarn lint` green; confirm zero behavior change (no consumer
      reads the field yet).

## Edge cases & interactions

- **NULL contributions.** `sum`/`avg`/`count(x)` step ignores NULL; law 2 must hold for NULL
  args (step(a, NULL) ≡ merge(a, step(identity, NULL)) ≡ merge(a, identity) ≡ a). Include NULL
  in the `valueArb`.
- **bigint/number promotion in sum.** merge/negate must preserve the accumulator's
  overflow-promotion (`5n` ≡ `5`). Law 4's finalize-compare is storage-class tolerant
  (`compareSqlValues` treats bigint 5n ≡ number 5) — verify the harness comparison uses that,
  not `===`.
- **min/max identity.** `initialValue` is `null` (the empty accumulator), and `merge(null, b)`
  must equal `b`, `merge(a, null)` equal `a`. The step already treats `acc===null` as empty;
  merge must mirror it.
- **decode of NULL.** sum/min/max decode of a stored SQL NULL must yield the *empty*
  accumulator (`null`), NOT `{sum:NULL}` — else a later merge corrupts. Pin in the harness.
- **avg has no decode.** Assert (in a comment / a targeted test) that avg declares `decompose`
  and NOT `decode` — the quotient is lossy; a stored avg value cannot reconstruct the count.
- **decompose partial resolution.** `combine` runs on *finalized* partial values; a decompose
  whose named partial is itself only decompose-able (no direct algebra) is out of scope —
  keep decompositions one level deep (partials must be directly algebra-complete).
- **Registry independence.** The declarations must not change function *resolution* or the
  `schema()`/`function_info()` listings — algebra is metadata only.
- **Plugin UDAF path.** A plugin registering via `createAggregateFunction` with `algebra` gets
  the same treatment; the harness is the author's self-test. Nothing forces a UDAF to declare
  algebra (absent ⇒ residual/floor, unchanged).
