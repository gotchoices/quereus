description: Review the lens prover's round-trip seam — `proveRoundTrip` is now a computed deploy-time GetPut/PutGet predicate over the predicate-honest complement (`viewComplement`), for the single-source projection-and-filter fragment, agreeing with the operational round-trip harness and degrading to the safe verdict outside it. Replaces the encapsulated no-op stub.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/property.spec.ts, docs/lens.md, docs/view-updateability.md
----

## What landed

`proveRoundTrip(ctx)` in `schema/lens-prover.ts` was an encapsulated no-op
(`return []`). It is now a **computed deploy-time predicate** over the
predicate-honest complement (`viewComplement`), closing the round-trip seam for the
single-source projection-and-filter fragment the complement covers. No call-site or
wiring change was needed — `proveLens` already does `errors.push(...proveRoundTrip(ctx))`,
and `lens.non-invertible` already exists in `LensErrorCode` and throws atomically
before catalog mutation (`lens-compiler.ts:236`).

### Core implementation (`lens-prover.ts`, all new code under the round-trip section)

- **`proveRoundTrip(ctx)`** — plans the body **logically** via the new
  `planLogicalBody(ctx)` (`db._buildPlan([slot.compiledBody])`, not the optimized
  `ctx.root`, so the Project/Filter/TableReference tree threading `updateLineage`
  survives — same reason `view_info`/`column_info` plan logically), then delegates
  to `computeRoundTrip` and emits `lens.non-invertible` (sited `{table, column}`,
  logical-column spelling via `ctx.outputColumns[i]`) for each writable-but-unfaithful
  column. Both helpers `try/catch`-degrade to the safe verdict.
- **`computeRoundTrip(root)`** (exported, the testable core) — returns
  `ColumnRoundTrip[]` (per output column: `writable` / `faithful` / `obstruction`),
  or `undefined` (degrade-to-safe) when out of fragment / no threaded lineage /
  non-negation-free residual. The fragment gate reuses `classifyViewBody` (rejects
  join/aggregate/set-op/VALUES/recursive-CTE) **plus** an explicit walk rejecting
  `LimitOffset`/`Distinct` nodes (which `classifyViewBody` tolerates as
  pass-through). Reads each site via `resolveBaseSite` (the n-way reader the put
  fan-out shares), so the GetPut hidden-column / PutGet inverse-domain checks already
  generalize past single-source — only the fragment gate is single-source-only.
- **GetPut** = `put` leaves the complement fixed: the writable base column is not in
  `complement.hiddenColumns` (structural over the fragment; a guard that reds the day
  a shape violates it).
- **PutGet** = `getPutComposesToIdentity(forward, inverse)` (exported pure core) +
  `domainEntailedBy(domain, residual)`. The forward `get` expression comes from the
  topmost `ProjectNode.getProjections()` (handles `select *` expansion); the `put`
  inverse from the site. `getPutComposesToIdentity` numerically probes `get(put(w)) === w`
  over `ROUND_TRIP_PROBES = [7, 13, -5]` using `evalClosed`, a **synchronous total
  evaluator over the closed invertibility-registry vocabulary** (literal, bound
  column, `+`/`-`/`*`, unary `±`, no-op `cast`/`collate`); anything outside it yields
  `undefined` and reds.
- **`isNegationFree`** — reflective walk rejecting `not` / `is not null` / `!=`(`<>`) /
  `not between` (the signal `viewComplement` carries a non-determined complement).

### Firing rule (the design decision, documented in code + docs)

`lens.non-invertible` fires **only** for a column the lens *presents as writable*
(`resolveBaseSite(...).writable`). A `computed`/opaque output column is **not** a
deploy error — it is an intentional read-only/derived column (its write reds
`no-inverse` at mutation time, as today). This is the soundness-over-completeness /
no-over-block reading. The stronger reading (hard-block an opaque column in a
name-matched would-be-writable position) needs a logical-layer read-only/generated
*intent* signal the model lacks today → filed as
`tickets/backlog/lens-logical-readonly-intent-signal.md`.

## Use cases to validate (the acceptance gate)

**`test/property.spec.ts` § View Round-Trip Laws — 3 new tests (the oracle):**
- **Harness agreement (primary gate)** — `computeRoundTrip per-column verdict agrees
  with the operational write/no-inverse law across the zoo`: for every zoo body
  (`SHAPES` × filter) **plus an opaque `b * 2 as bp`** (the only way to reach a
  `no-inverse` operational verdict — every zoo column is identity/rename/`b+1`-inverse
  writable), the computed `writable && faithful` verdict equals whether an actual
  `update v set <col> = 1` propagates vs. reds `no-inverse`.
- **Injected-violation self-test** — `getPutComposesToIdentity` reds on an injected
  unfaithful inverse (`b+1` forward with `w ↦ w-2` put), greens on the honest
  `w ↦ w-1` and on identity. Mirrors the existing `injected-widening`/`injected-getput`
  pure-core self-tests.
- **Degrade-to-safe** — `computeRoundTrip` returns `undefined` for LIMIT/DISTINCT/`<>`
  bodies, not-`undefined` for an honest filtered body.

**`test/lens-prover.spec.ts` § round-trip (computed deploy-time predicate) — 4 new
deploy-time tests (through the full `apply schema` pipeline):**
- **All-invertible chain passes**: `(speed + 1) - 2 as adjusted` declared writable
  deploys (no throw), `column_info` reports `adjusted` writable, and a write
  round-trips (`set adjusted = 5` ⇒ base `speed = 6` ⇒ reads back `5`).
- **No over-block** ×3: a non-negation-free residual (`where speed <> 1`), a two-table
  inner-join body, and the documented `upper(who) as label` opaque derived column all
  deploy with **no** `lens.non-invertible` (asserted as: `apply schema` does not throw
  + a report exists). The opaque column is read-only via `column_info` and its write
  still reds at mutation time.

> Because `lens.non-invertible` is an **error** (throws atomically, never reaches the
> report), the "no over-block" tests assert *no-throw*; a spurious red would surface as
> an `apply schema` throw matching `/lens.non-invertible/`.

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (EXIT 0).
- `yarn workspace @quereus/quereus run lint` — clean (single-quoted globs).
- `yarn test` (full suite) — **4600 passing, 9 pending** (was 4593 before; +7 new).

## Known gaps / where to scrutinize (honest — treat tests as a floor)

- **Ticket example `(speed + 1) * 2` is NOT actually invertible under the shipped
  registry** (`classifyArithmetic` inverts only `±k`, never `*` — `x*k`'s inverse
  `w/k` is not exact over integers). I used a genuinely-invertible `±` chain
  (`(speed + 1) - 2`) for the "all-invertible chain passes" test and the docs note the
  deviation. If a reviewer expects `*`-by-constant to be writable, that is a
  *registry* change (`scalar-invertibility.ts`), out of scope here — but worth a
  conscious decision, since `docs/lens.md:228` still uses `(speed + 1) * 2` as the
  writable example (aspirational; that column is currently read-only).
- **The injected-unfaithful path is exercised only at the pure-core level**
  (`getPutComposesToIdentity` fed a bad pair), not via a real deploy — because the
  shipped registry is faithful by construction, so a real deploy can never produce an
  unfaithful writable site. This matches the harness's existing injected self-test
  pattern, but means the *end-to-end* "deploy reds → mutation reds" arm of ticket test
  group #4 is covered by the harness-agreement contract, not a literal red-at-deploy.
  A reviewer wanting a literal deploy red would need to stub the registry.
- **`evalClosed` soundness rests on the writable fragment being limited to the closed
  registry vocabulary.** If any writable `get` expression could fall outside
  {literal, column, `±`/`*`, unary `±`, no-op cast, collate}, the probe returns
  `undefined` and **reds** — which would be an over-block. I believe this cannot
  happen (a writable site comes from `traceInvertibleColumn`, whose only invertible
  shapes are exactly that vocabulary), but it is the load-bearing assumption to
  scrutinize. Note `evalClosed` coerces `bigint → Number` and compares with `===`;
  safe for the small integer probes but not for values outside `Number` range.
- **`domainEntailedBy` is unreachable today** (no shipped profile carries a `domain`)
  and is a best-effort *structural* (verbatim-conjunct) entailment via
  `expressionToString` comparison — untested in a live path; it is the seam for a
  future domain-restricted profile, not a proven entailment checker.
- **Forward-expr extraction degrades to safe when no `ProjectNode` is found.** For a
  writable inverse column with a missing forward (shouldn't happen on a single-source
  projection-filter body, which always has a Project), `roundTripObstruction` skips the
  PutGet identity probe (conservative: no false error). Confirm no real fragment body
  lacks a topmost Project.
- **New import edges** from `schema/lens-prover.ts`: `classifyViewBody`
  (`planner/mutation/propagate.js`), `resolveBaseSite` (`planner/analysis/update-lineage.js`),
  `viewComplement`, `ProjectNode`, `PlanNodeType`. These are runtime (call-time)
  imports; the build is clean and no module-init cycle manifested, but the
  prover↔mutation direction is new — worth a glance for cycle fragility.
- **Harness-agreement operational oracle** uses `update v set <col> = 1` and classifies
  only `mutationDiagnostic.reason === 'no-inverse'` as non-writable (any other
  outcome ⇒ writable). Robust for the integer-only zoo, but a writable column that
  threw a *different* error would be misclassified writable (masking a disagreement).
  No such case in the zoo; flagged for completeness.
- **Fragment scope is single-source only** by design. The join/decomposition widening
  tracks with `view-write-through-shape-gaps` (the complement being defined there);
  the checks are already expressed against `resolveBaseSite` to make that a later
  widening behind the same law, but the join path is **not** exercised positively here
  (the two-table-join deploy test only confirms degrade-to-safe).
