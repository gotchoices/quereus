description: Aggregate functions can now declare, once on their schema, how their values combine and reverse — groundwork for maintaining and rolling up aggregate materialized views. Review the declarations, the property-test harness that validates them, and one deliberate deviation from the spec (sum's accumulator now tracks a contribution count).
prereq:
files: packages/quereus/src/schema/function.ts, packages/quereus/src/func/registration.ts, packages/quereus/src/func/builtins/aggregate.ts, packages/quereus/test/util/aggregate-algebra-laws.ts, packages/quereus/test/incremental/aggregate-algebra.spec.ts, docs/schema.md, docs/mv-maintenance.md
difficulty: medium
----
## What was built

Implements the `feat-mv-agg-algebra-schema` ticket: an optional `algebra` declaration on
`AggregateFunctionSchema`, declared on the incremental-capable builtins, verified by a
fast-check law harness in CI. **Metadata only** — nothing reads the field yet; the two
consumers (`feat-mv-agg-rollup-retarget` read-side, `feat-mv-agg-delta-arm` write-side)
land separately and `prereq` on this.

- `schema/function.ts` — new `AggregateAlgebra` (`merge` / `negate?` / `decode?` /
  `decompose?`) and `AggregateDecomposition` interfaces + `algebra?` field on
  `AggregateFunctionSchema`, with the five author-contract laws in the doc comments.
- `func/registration.ts` — `algebra?` threaded through `AggregateFuncOptions` →
  `createAggregateFunction`, so plugin UDAFs get the same path.
- `func/builtins/aggregate.ts` — declarations per the spec table: count(*)/count(x)
  (full abelian group + identity decode), sum (merge/negate/decode), min/max
  (tighten-only: merge + decode, no negate, same `compareSqlValuesFast(...BINARY)` the
  step uses), avg (merge/negate + `sum/count` decomposition, **no decode**).
  total / group_concat / var_* / stddev_* deliberately declare nothing (NOTE comment at
  `totalFunc` explains the float-drift reason).
- `test/util/aggregate-algebra-laws.ts` — `assertAggregateAlgebraLaws(schema, valueArb,
  opts?)`: fast-check over laws 1–5 for whichever fields are declared; equivalence is
  finalize-then-byte-compare (`sqlValueIdentical`, storage-class tolerant). Decompose
  partials resolve against the builtins by default; `opts.resolvePartial` overrides.
  Throws naming the violated law.
- `test/incremental/aggregate-algebra.spec.ts` — 12 tests: the 6 declared builtins under
  domain-appropriate arbitraries (ints+NULL for count/avg; ints+overflow-scale bigints
  for sum; mixed numbers/bigints/doubles/strings+NULL for min/max), shape pins (avg has
  decompose-not-decode; min/max have no negate; decode(NULL) → empty accumulator; the
  residual-only builtins declare nothing), and **two negative twins** (a negate that
  returns its input → `negate-inverse` throws; a decode that fabricates a value →
  `decode-observational` throws).
- `docs/schema.md` § "Aggregate Function Algebra" — declaration, laws, harness usage,
  builtin table. `docs/mv-maintenance.md` — forward-reference paragraph (end of the
  `'residual-recompute'` section) naming the two consumer tickets.

## Deliberate deviation from the ticket spec — reviewer should scrutinize

The ticket specified sum's accumulator as `{sum}` with `merge: {sum: a.sum+b.sum}` and
`decode: v → {sum: v}`. That declaration **cannot satisfy the ticket's own law 3**
(`merge(a, negate(a)) ≡ identity` under finalize-compare): insert 5 then retract 5 gives
`{sum: 0}` → finalizes to `0`, while the identity (empty group) finalizes to `NULL`.

Resolution: sum's accumulator is now `{sum, count}` (count of non-NULL numeric
contributions), finalize returns `NULL` when `count === 0`. External step/finalize
behavior is unchanged (a fold that counted nothing already finalized NULL via the null
accumulator); the shape is private to `aggregate.ts` (verified: window-function emitters
keep their own accumulators — and notably window-sum already uses exactly this
`{sum, count}` pattern). `decode` maps stored `v → {sum: v, count: 1}` — the count is an
observational witness for "non-empty" (finalize only distinguishes zero/non-zero), which
is sound under law 4's observational (not bijective) contract. Documented in
`docs/schema.md` as guidance for UDAF authors with NULL-on-empty finalizers.

Secondary refactor: sum's inline promotion arithmetic extracted to `addWithPromotion`
(same overflow-check-then-BigInt logic, byte-identical results) so merge and step share
it.

## Validation performed

- `yarn build` green (all packages).
- `yarn test` green — 7110 quereus tests (incl. all sqllogic) + all other packages; the
  sum accumulator change altered zero existing results.
- `yarn lint` green (incl. the tsc pass over test files).
- New spec: 12/12 passing.

## Known gaps / review angles

- **fast-check seeds are random per run.** The positive laws are exact on their chosen
  domains (integer sums, NaN excluded from min/max), so they cannot flake. The negative
  twins fail with overwhelming probability (broken negate fails for any input array with
  ≥1 non-null value; fabricating decode fails unless the true sum happens to be exactly
  1) but are not seed-pinned. If CI ever sees a flake there, pin `seed` via a new option
  on the harness.
- **`decode` type-trusts its input**: sum's decode casts `stored as number | bigint`
  without validating — a caller handing it a text value would poison the accumulator.
  Acceptable while decode's only callers are the (not yet landed) engine arms that read
  it back from a backing the same aggregate wrote; worth revisiting when
  `feat-mv-agg-delta-arm` lands.
- **`count` decode uses `Number(stored)`** — precision-lossy above 2^53. Counts of that
  magnitude are unreachable in practice; noted here rather than guarded.
- Law 1 (associative/commutative) is checked over ≤12-element folds ×100 runs per law —
  standard property-test coverage, not a proof.
- The harness assumes algebra functions are pure (documented in the contract); it
  rebuilds accumulators per expression, so a mutating merge is likely — not guaranteed —
  to be caught.
- Negative-count accumulators (unbalanced retraction, e.g. sum's `{sum, count: -2}`)
  finalize as non-empty. The laws never produce them; the write-side arm must keep
  retractions balanced — flagged for the `feat-mv-agg-delta-arm` design.
