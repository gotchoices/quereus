description: COMPLETE — the lens prover's round-trip seam (`proveRoundTrip`) is a computed deploy-time GetPut/PutGet predicate over the predicate-honest complement (`viewComplement`) for the single-source projection-and-filter fragment, agreeing with the operational round-trip harness and degrading to the safe verdict outside it. Reviewed: implementation sound, one doc inaccuracy fixed inline, no major findings.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/property.spec.ts, docs/lens.md, docs/view-updateability.md, packages/quereus/src/planner/analysis/scalar-invertibility.ts
----

## What landed

`proveRoundTrip(ctx)` in `schema/lens-prover.ts` (formerly an encapsulated no-op
returning `[]`) is now a **computed deploy-time predicate** over the predicate-honest
complement (`viewComplement`), closing the round-trip seam for the single-source
projection-and-filter fragment. It plans the lens body **logically** (`planLogicalBody`,
not the optimized `ctx.root`, preserving the Project/Filter/TableReference tree that
threads `updateLineage`), then delegates to the exported testable core
`computeRoundTrip(root)` which returns one `ColumnRoundTrip` verdict per output column
(`writable` / `faithful` / `obstruction`) or `undefined` (degrade-to-safe) when the
complement cannot characterize the body. `lens.non-invertible` fires only for a column
the lens *presents as writable* whose GetPut/PutGet round-trip cannot be proved
faithful; computed/opaque columns stay intentionally read-only (write reds `no-inverse`
at mutation time). The shipped invertibility registry is faithful by construction, so
the check emits nothing today — it is a live defensive seam that reds the day a shape or
a future domain-restricted/composed profile violates a law.

Core helpers, all exercised by tests: `getPutComposesToIdentity` (PutGet identity probe
over `ROUND_TRIP_PROBES = [7,13,-5]` via the closed total evaluator `evalClosed`),
`isNegationFree` (residual honesty gate), `isSingleSourceProjectionFilter` (fragment
gate reusing `classifyViewBody` plus an explicit LIMIT/OFFSET/DISTINCT reject),
`roundTripObstruction`, and the unreachable-today `domainEntailedBy` seam.

The stronger reading (hard-block an opaque column in a name-matched would-be-writable
position) needs a logical-layer read-only/generated intent signal the model lacks today
→ already filed by implement as `tickets/backlog/lens-logical-readonly-intent-signal.md`.

## Review findings

Adversarial pass over the implement diff (commit `6eda364e`), read fresh before the
handoff. Scope: `schema/lens-prover.ts` round-trip section, the new tests in
`lens-prover.spec.ts` and `property.spec.ts`, and the touched docs. Lint + full suite
run and green.

### Checked — sound, no action

- **GetPut over-block impossibility.** `roundTripObstruction`'s GetPut arm reds a
  writable column whose `baseColumn` is in the complement's `hiddenColumns`. Verified
  this is structurally unreachable for a writable column on a single-source body: a
  writable column is *projected* (present in the output image), so its base column is by
  definition not among the projected-away hidden set. Correct defensive guard, no
  spurious red.
- **`evalClosed` vs registry soundness.** Confirmed the closed vocabulary
  {literal, column, `±`, `*`, unary `±`, no-op cast, collate} is a *superset* of what
  `traceInvertibleColumn` admits for a writable site (`scalar-invertibility.ts`:
  passthrough column/collate/no-op-cast + `±k` arithmetic only). A writable column's
  forward `get` therefore always lies inside `evalClosed`'s domain and is faithful ⇒ the
  PutGet probe returns `true` for every shipped-registry writable column. The `* `
  branch in `evalClosed` is harmless (a `*` column is never writable, so never probed).
  No spurious red.
- **`isNegationFree` operator casing.** Cross-checked the AST against the parser:
  unary `NOT` → operator `'NOT'` (parser.ts:1202), `IS NOT NULL` → `'IS NOT NULL'`
  (parser.ts:1217), and both `!=` and `<>` lex to `NOT_EQUAL` → operator `'!='`
  (parser.ts:1237; lexer.ts:411-417). So the `'NOT'` / `'IS NOT NULL'` / `'!='` checks
  match real ASTs; the extra `'<>'` literal is dead-but-harmless redundancy. `NOT
  BETWEEN` handled via `BetweenExpr.not`. Negation detection is correct.
- **Import-cycle risk** (handoff flagged the new prover→mutation edge). Verified the
  modules `lens-prover.ts` newly imports (`mutation/propagate.js`,
  `analysis/update-lineage.js`, `analysis/view-complement.js`, `nodes/project-node.js`)
  do **not** import back from `schema/lens-prover.ts`. The pre-existing planner→prover
  edges (`building/select.ts`, `mutation/lens-enforcement.ts`) are one-directional and
  untouched. All imports are call-time; build + deploy-exercising tests pass ⇒ no
  init-time TDZ. No new cycle.
- **Test coverage** — happy path (all-invertible chain deploys writable + round-trips),
  edge (degrade-to-safe on LIMIT/DISTINCT/`<>`, out-of-fragment join, opaque computed
  column read-only), error (injected unfaithful inverse reds at the pure-core level),
  and the primary **harness-agreement** oracle (`computeRoundTrip` per-column verdict
  equals the operational write/`no-inverse` law across the zoo + an opaque `b*2`).
  Regression: full suite green. Adequate as more than a floor.

### Acknowledged gaps — reviewed, accepted as designed (no new ticket)

These are honestly disclosed in the implement handoff and are correct trade-offs, not
defects:
- Injected-unfaithful exercised only at the pure-core level — the shipped registry is
  faithful by construction, so a real deploy cannot produce an unfaithful writable site;
  mirrors the existing `injected-widening`/`injected-getput` self-test pattern.
- `domainEntailedBy` unreachable today (no shipped profile carries a `domain`) — a
  structural seam for a future domain-restricted profile, clearly documented as such.
- Harness-agreement oracle treats only `mutationDiagnostic.reason === 'no-inverse'` as
  non-writable — robust for the integer-only zoo; no zoo column throws a different error.
- Fragment scope single-source-only by design; the join/decomposition widening tracks
  with `view-write-through-shape-gaps`. The checks are already expressed against
  `resolveBaseSite` to make that a later widening behind the same law.
- `evalClosed` coerces `bigint → Number` and compares with `===` — safe for the small
  integer probes, not for out-of-`Number`-range values (which the probe set never hits).

### Found and fixed inline (minor)

- **`docs/lens.md:228` documented a non-invertible expression as writable.** The bullet
  used `(speed + 1) * 2 as adjusted` as the example of an "invertible expression [that]
  stays writable". Verified against `scalar-invertibility.ts:classifyArithmetic` (line
  71: `if (op !== '+' && op !== '-') return null`) that `*` is **not** in the registry —
  the outer `* 2` makes the column opaque/read-only, contradicting the doc's claim (the
  implement handoff flagged this aspirational example but did not fix it). Corrected to a
  genuinely-invertible `±k` chain — `(speed + 1) - 2 as adjusted` (the same shape the new
  "all-invertible chain passes" test uses) — and added an explicit note that the registry
  inverts only `±k`, not `*`, so a `* 2` step is read-only. Docs now match the shipped
  registry and the test suite.

### Major findings

None. No new fix/plan/backlog ticket is warranted from this review. (The implement stage
already filed `lens-logical-readonly-intent-signal.md` to backlog for the stronger
opaque-column-blocking reading; that remains the correct home for that future work and is
not duplicated here.)

## Validation performed (review)

- `yarn workspace @quereus/quereus run lint` — clean (EXIT 0).
- Targeted specs (`lens-prover.spec.ts` + `property.spec.ts`) — **132 passing**, including
  all 7 new round-trip tests.
- Full quereus suite (`node test-runner.mjs`) — **4626 passing, 9 pending, 0 failing**.
- Only change introduced by review: the one-line `docs/lens.md` correction above
  (no code change), so the implement-stage clean build is unaffected.

## End
