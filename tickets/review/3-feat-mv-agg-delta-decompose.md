description: An "average" column in an aggregate materialized view (and any aggregate defined as a formula over simpler ones) is now kept current by arithmetic on its stored building-block columns instead of re-running the query — but only when those building blocks are themselves stored columns of the same view.
prereq: feat-mv-agg-delta-arm
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, docs/mv-maintenance.md
difficulty: medium
----
## What shipped

The **decomposition-maintained** class of delta-aggregate column, layered onto the
`DeltaAggregateDescriptor` from `feat-mv-agg-delta-arm`. A stored aggregate column whose
value is a scalar formula over sibling *partial* aggregates (`AggregateAlgebra.decompose`)
— `avg(x) ≡ sum(x)/count(x)`, and any UDAF declaring `decompose` — is now delta-maintained
by delta-maintaining its partials and re-evaluating `decompose.combine` per affected group
at the end-of-statement flush. `avg` is the **first client** of this class, not a special
case: nothing is aggregate-name-driven.

The column is maintainable **only when every partial it names is also stored as a sibling
column of the same MV body** and each partial is itself delta-maintainable. If any partial
is missing or not delta-maintainable, the decomposed column is not maintainable and the
**whole MV falls to the residual** (correct, just not incremental).

### Where the pieces live

- **`database-materialized-views-plans.ts`** — new `DeltaDecomposeColumn` type (`backingCol`
  + `partialIndices` into `aggColumns` + the `combine` closure) and a `decomposeColumns`
  field on `DeltaAggregateDescriptor`. (Design note: I did **not** fold the decompose variant
  into `DeltaAggregateColumn` as the ticket's TODO literally suggested — a decompose column
  has no accumulator slot and its partials may project before *or* after it, so a dedicated
  list keeps the hot accumulate/finalize loops untouched and avoids a two-pass finalize with
  interleaving-order hazards. Semantically identical to what the ticket asked for.)
- **`database-materialized-views-plan-builders.ts`** — `buildDeltaAggregateDescriptor` now
  routes each aggregate output column by declared algebra: directly delta-maintainable
  (`merge`+`negate`+`decode`) → accumulate as before; else `decompose` present → deferred to
  a second pass that binds each partial to a stored sibling via the new
  `resolveDecomposePartial` (the write-side twin of the read-side
  `query-rewrite-matcher.resolveMergeablePartial`); else → residual.
- **`database-materialized-views-apply.ts`** — `computeDeltaAggregateOps` fills each decompose
  column at flush from the already-finalized partials: `row[col] = combine([finals[pi] …])`.
  No independent accumulation on the insert/retract path.

## Use cases to validate

The maintenance-equivalence property harness is the oracle (`read(MV) == evaluate(body)`
after each random mutation and after rollback); new suites are grouped under
**"decompose class"** in `maintenance-equivalence.spec.ts`:

- **avg delta-maintained** — `select k, count(*), sum(a), avg(a) from t group by k` over a
  **NOT NULL integer** `a`. Here `count(*)` serves as avg's `count(x)` divisor (the count(*)
  fallback, see below) and `sum(a)` is retraction-safe, so inserts **and** deletes maintain
  avg by arithmetic. White-box pin: `chosenStrategy === 'delta-aggregate'` and exactly one
  decompose column recorded.
- **avg over a nullable arg with `count(a)` stored** — the NULL-excluding divisor path.
  `sum(a)` over nullable `a` is not retraction-safe, so deletes fall back to the residual
  per group (still exact). Deterministic edge pins: a **group of only NULL-arg rows**
  (count(*)>0, count(x)=0 → avg NULL) and an **emptied group** (deleted via the multiplicity
  witness).
- **not-delta-maintainable → residual** — `select k, avg(a) from t group by k` (no stored
  partials) and `avg` over a **REAL** column (its `sum` partial fails the integer-domain
  gate). Both stay equivalent on the residual; pinned `chosenStrategy != 'delta-aggregate'`.
- **a non-avg `decompose` UDAF** — `wsum(x) ≡ sum(x) + count(x)`, registered in the test,
  delta-maintained from stored `sum`/`count`. Proves the class is function-generic.

## Honest gaps / things a reviewer should probe

- **The UDAF test is NOT a real geometric mean.** The ticket suggested a geometric-mean-style
  UDAF; I used an INTEGER-exact linear-combination UDAF (`wsum`) instead, on purpose. A true
  geomean partial (`sum(log x)`) is a float sum that drifts under re-association, so the
  incremental value would diverge byte-exactly from the live re-fold and red the oracle. This
  is not a hole in the implementation: a `sum(log x)` partial has a **non-bare, float-producing
  argument**, so it can never pass the accumulator gate (bare-column arg + integer domain) and
  therefore can never be a resolved partial — a real geomean correctly falls to the residual.
  There is a greppable `NOTE:` at `resolveDecomposePartial` recording this soundness argument,
  and the docs' "Float gate on the partials" bullet states it. **Worth a reviewer double-check**
  that the bare-arg + integer-domain gate really does close every float-drift path a decompose
  UDAF could open — I believe it does, but this is the subtlest soundness claim here.
- **count(*) vs count(x) for avg** mirrors the read-side relaxation from
  `feat-mv-agg-rollup-retarget`: a stored `count(*)` substitutes for avg's `count(x)` divisor
  **only when the argument column is NOT NULL**. Same rule on both sides; verify the two stay
  in lockstep if either is ever touched.
- **Discovery worth flagging:** Quereus columns default to **NOT NULL** (a plain `integer`
  column rejects NULL); `integer null` is required for a nullable column. The nullable-arg
  suite depends on this. Unrelated to this ticket but easy to trip over when writing MV/agg
  tests.
- **Decompose column is never the multiplicity witness** (it accumulates nothing; the witness
  must be a real stored `count(*)`) — enforced structurally, pinned indirectly by the
  "not-delta-maintainable → residual" avg-only case.

## Validation performed

- `yarn build` (tsc, `@quereus/quereus`) — clean.
- `yarn workspace @quereus/quereus typecheck:test` — clean.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) — clean.
- `yarn test` — green, exit 0: **7142 passing** in `@quereus/quereus` (incl. 11 new
  decompose-class tests) and all other packages pass; **zero failing**. Full
  `maintenance-equivalence.spec.ts` = 126 passing.
- No `.pre-existing-error.md` written — no unrelated failures surfaced.
