description: Aggregate materialized views over a single source are now kept current by pure arithmetic on the stored group row (add on insert, subtract on delete) instead of re-running the query per changed group — driven entirely by each aggregate's declared algebra, with automatic fallback to the old recompute path whenever the arithmetic cannot be proven exact.
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/schema/function.ts, packages/quereus/src/func/builtins/aggregate.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/test/incremental/delta-aggregate.spec.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/incremental/aggregate-algebra.spec.ts, packages/quereus/test/util/aggregate-algebra-laws.ts, docs/mv-maintenance.md, docs/schema.md, docs/invariants.md
difficulty: hard
----
## What was built

The delta-aggregate fast path from `implement/2-feat-mv-agg-delta-arm`: a
`'residual-recompute'` maintenance plan for a single-source aggregate MV now carries an
optional `delta: DeltaAggregateDescriptor` (plan `kind` unchanged; `chosenStrategy`
records `'delta-aggregate'`). When present, the per-statement accumulation folds
per-group accumulator deltas (`merge(step(identity, value))` on insert,
`merge(negate(step(identity, value)))` on delete; an update retracts the OLD image and
inserts the NEW, possibly into two groups), and the end-of-statement flush rebuilds each
affected group as `finalize(merge(decode(storedRow[col]), delta))` after a single
effective point read of the stored row — **zero source reads, no residual execution**.
The multiplicity witness (count(*)) finalizing to 0 deletes the group row. Everything is
driven by the declared `AggregateFunctionSchema.algebra` — no aggregate-name list
anywhere (pinned in docs/invariants.md MV-007).

Create-time gate (`buildDeltaAggregateDescriptor`, plan-builders): bare-column plain
aggregate calls with merge+negate+decode; exact numeric domain (INTEGER-physical result
type — count-shaped — OR INTEGER-physical argument column); a zero-arg `decodeExact`
multiplicity witness; **no post-aggregate filter (HAVING)**; BINARY collations on the
group-key backing PK; body WHERE compiled to a single-row scope predicate. Any failure
silently leaves the plan on the plain residual.

Cost gate: `'delta-aggregate'` added to `MaintenanceStrategy` with cost
`min(seek+project, residualCostPerGroup × 0.5)` per change — strict dominance over the
residual for every stats input (a flat constant LOST to the residual on an empty source
at create, which was the first bug found: the descriptor built but was never chosen).
The delta flush bypasses `shouldDegradeToRebuild` (already O(affected groups)).

## Two significant deviations from the ticket spec — both correctness-forced

**1. The prereq's `sum.decode` witness was unsound under retraction.** Ticket flush
formula `finalize(merge(decode(stored), delta))` with the prereq's
`decode(v) = {sum: v, count: 1}` collapses to a spurious NULL on the FIRST retraction
from any multi-row group (stored 12 for rows [5,7], delete 5 → merged count 0 → NULL,
true answer 7). Implementing the ticket verbatim fails its own AGGREGATE_SHAPES tests.
Resolution (three coordinated pieces):
  - `sum.decode` now reconstructs an **absorbing** witness (`count: Infinity`) — never
    spuriously empties under finite retraction (the prereq's decode comment anticipated
    "validate here when feat-mv-agg-delta-arm lands");
  - new optional `AggregateAlgebra.decodeExact` flag (decode is a FULL inverse of
    finalize — count declares it, sum must not) with a new law-harness law
    `decode-exact-retraction` (4b) checking observationality under negated merges, plus
    a negative test that falsely declaring it on sum fails;
  - per-column `retractionSafe` = `decodeExact` OR NOT-NULL argument column (then true
    contribution count = multiplicity, provably positive while the row exists). A group
    that accumulated any retraction while some column is NOT retraction-safe is
    re-derived at flush through the residual (per-group fallback — the forward residual
    keys are ALWAYS accumulated alongside the delta, same canonical map key), so
    nullable-argument sums still get the bulk-insert fast path and stay exact on delete.

**2. `HAVING` had to be gated out** (not mentioned in the ticket): a post-aggregate
filter breaks "stored row == the group's full accumulator" (a HAVING-hidden group has
contributions but no stored row → a later delta rebuilds from identity and understates).
Caught by the pre-existing sqllogic HAVING case (53-materialized-views-rowtime §22d).
Gate: any Filter node whose subtree contains the aggregate → residual.

## Latent engine bug found and fixed (outside the ticket's file list)

`vtab/memory/layer/scan-layer.ts`: an `equalityPrefix` seek always used an ARRAY-shaped
start key; a **single-column** PK btree stores SCALAR keys, so the seek positioned past
the matching row and the prefix scan returned nothing. Never hit before (prefix-delete
and covering scans use composite keys / strictly-shorter prefixes); the delta arm's
full-PK point read over a one-column group key is the first consumer. Fixed in both the
primary and (mirrored, latent) secondary-index branches. The store host's own
`scanEffective` is fine — verified by the full `yarn test:store` run.

## OR FAIL correctness (the ticket's flagged sharpest risk)

Confirmed by reading `dml-executor.ts`: the per-row OR FAIL savepoint reverts source and
backing writes but the residual batch is a JS map that cannot be unwound, so a reverted
row's folded delta would survive. Resolution: `poisonResidualDeltaAccumulations` — the
executor calls it exactly at the per-row savepoint rollback; it drops the delta maps and
marks entries poisoned, and the FAIL-path flush falls back to the plain residual over
the always-present forward keys (a reverted key's recompute is value-identical →
suppressed). OR IGNORE never writes the skipped row (vtab returns `row: undefined`
before maintenance); OR REPLACE evictions arrive as real delete `BackingRowChange`s —
both accumulate correctly with no special-casing. Covered by the pre-existing
OR FAIL / OR IGNORE / OR REPLACE statement-batching tests, now running on the delta path.

## Validation

- `yarn build`, `yarn lint`, `yarn test` (7129 passing), `yarn test:store` (7123
  passing) all green.
- Existing AGGREGATE_SHAPES equivalence properties now run on the delta path
  (routing verified by plan-introspection pins, not assumed).
- New `test/incremental/delta-aggregate.spec.ts`:
  - create-time routing pins (delta on: count+sum int, count-only, nullable-arg sum
    [not retraction-safe]; residual on: min/max, TEXT sum, NOCASE group key, no
    multiplicity witness, expression argument);
  - declared-algebra UDAF (`test_xor`, xor is its own negate, `decodeExact`) —
    random-mutation equivalence property incl. rollback;
  - broken-law negative twin (`test_xor_bad`, wrong negate) — the oracle catches the
    divergence on the first retraction;
  - nullable-argument retraction fallback: directed witness-collapse cases (partial
    retraction keeps the surviving sum; last-non-NULL retraction yields NULL) plus a
    NULL-mixed random-mutation property;
  - two-level delta-over-delta chain (count+sum → count over the count column)
    converging under random mutations incl. rollback.
- `maintenance-equivalence.spec.ts`: demotion pin re-based on a min-bearing (delta-
  ineligible) body; new pin that a delta body bypasses demotion (no replace-all over
  the crossover).
- `aggregate-algebra.spec.ts`: decodeExact declaration pins, absorbing-witness pin,
  false-decodeExact negative.
- Performance: the sentinel workload (2 aggregate MVs, 1000-row bulk insert) measures
  **2.28×** a plain bulk insert (was ~3× batched-residual; sentinel bound 12× —
  observed, bound left unchanged for CI stability). Note `bucket_totals` in the
  sentinel has no count(*) so it correctly stays residual; only `acct_totals` is delta.

## Review focus suggestions

- `computeDeltaAggregateOps` / `accumulateDeltaAggregates` in
  `database-materialized-views-apply.ts` — the arithmetic core and the retraction
  fallback routing; and the flush routing in `applyResidualBatch`
  (`database-materialized-views.ts`).
- The scan-layer fix: the secondary-index branch is a mirrored fix with no direct new
  test (the primary branch is exercised by every delta flush); consider a targeted
  secondary-index prefix-scan test.
- Negative multiplicity (an already-corrupt backing) upserts a negative count rather
  than failing loud — deliberate (delta trusts invariants, oracle catches divergence),
  but a reviewer may prefer an INTERNAL assert.
- The gate requires `decode` on every column including the multiplicity witness
  (stricter than the ticket's "decode OR multiplicity witness" wording) — a zero-arg
  UDAF without decode falls to residual; count declares decode, so nothing reachable
  changes.
- `delta` is attached only when the cost gate actually chose `'delta-aggregate'`
  (cost-strategy decoupling); the dominance-capped cost makes that unconditional today.

## Tripwires (recorded, not tickets)

- `NOTE` at the exact-domain gate (plan-builders): a REAL-domain sum wanting the fast
  path needs Kahan accumulation or periodic rescan — a design change, not a gate
  relaxation. Also documented in docs/mv-maintenance.md.
- An INTEGER-declared column physically holding a non-integer value is not re-checked
  by the gate (the engine's INTEGER validate/parse on write is the guard; the oracle
  is the backstop).
