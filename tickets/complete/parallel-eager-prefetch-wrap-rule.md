description: PostOptimization rule `ruleEagerPrefetchProbe` — wraps a hash join's probe (left) side in EagerPrefetch when the build (right) side is high-latency. Reviewed and accepted; two follow-on tickets filed.
files: packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts, docs/optimizer.md
----

## What landed

A new PostOptimization rule `ruleEagerPrefetchProbe` (priority 15) that recognizes
a physical hash join (`BloomJoinNode`, `PlanNodeType.HashJoin`) whose build
(`right`) side advertises `expectedLatencyMs >= prefetchProbeThresholdMs`, and
wraps the probe (`left`) side in an `EagerPrefetchNode`. Two tuning knobs
(`prefetchProbeThresholdMs` default 25, `prefetchBufferSize` default 64). Inert
by design on local-only memory-vtab plans (latency 0 everywhere except
remote-vtab leaves). Skip predicates for `left` ∈ {EagerPrefetch, Cache,
AsyncGather}. 12 tests, docs updated. See the implement commit
(`ticket(implement): parallel-eager-prefetch-wrap-rule`) for full detail.

## Review findings

### Verified correct

- **Rule logic** — matcher (`instanceof BloomJoinNode`), skip predicates, and
  cost gate (`right.physical.expectedLatencyMs >= threshold`) all read as
  intended. The `left = probe / right = build` convention is correct per
  `bloom-join-node.ts:30-34`; the wrap target (`left`) and gate side (`right`)
  match the plan ticket's reasoning.
- **`withChildren` contract** — the rule rebuilds children as
  `[wrappedProbe, right, ...residual?]`, exactly matching
  `BloomJoinNode.withChildren`'s expected arity (2 or 3) and `isRelationalNode`
  checks. Residual is preserved.
- **Idempotence** — after the rewrite `left` is an `EagerPrefetchNode`, caught
  by the first skip predicate; SQL-level idempotence test confirms no double-wrap.
- **Pass placement** — priority 15 sits after `mutating-subquery-cache` (10) /
  `asof-strategy-select` (11) and before `cte-optimization` (20) /
  `materialization-advisory` (30), as documented.
- **Tuning** — both knobs added to the interface and `DEFAULT_TUNING`, documented
  in the `gatherThresholdMs` style. Both > 0, so the local-only no-rewrite
  invariant holds.
- **Tests** — all 12 pass. Execution-equivalence test asserts the rule actually
  fired (guards against a vacuous pass) and compares row sets rule-on vs rule-off.
- **Lint** — `yarn lint` (quereus) clean.
- **Full suite** — `node test-runner.mjs` (quereus): **3425 passing, 9 pending,
  0 failing** (49s). Matches the implement-stage claim.
- **Docs** — `docs/optimizer.md` "Eager-prefetch probe wrap" subsection
  accurately describes gate, skip predicates, placement, knobs, and scope.

### Major (follow-on tickets filed)

- **`EagerPrefetchNode` drops physical claims.** It does not override
  `computePhysical`, and the default child-merge (`plan-node.ts:545-567`) only
  carries `deterministic`/`idempotent`/`readonly`/`expectedLatencyMs`/
  `concurrencySafe` — **not** `ordering`/`fds`/`equivClasses`/`monotonicOn`/
  `constantBindings`/`domainConstraints`. Confirmed empirically: a source
  declaring `ordering` wrapped in EagerPrefetch yields
  `physical.ordering === undefined`. The node's docstring falsely claims these
  "pass through verbatim". This rule is the *first* code to insert
  `EagerPrefetchNode` into real plans, so it activates the latent defect: a
  prefetch-wrapped probe loses its ordering/key/FD claims, weakening the hash
  join's (and everything above it's) physical and defeating downstream sort /
  distinct / streaming-aggregate elision. Conservative (FIFO buffer preserves
  runtime order, so no wrong rows) but a real missed-optimization defect. The
  defect lives in `EagerPrefetchNode` (a prior ticket's code), so it is fixed in
  its own ticket rather than inline here. → **`tickets/fix/eager-prefetch-physical-passthrough.md`**.

### Minor (annotated, not a code change here)

- **No concurrency-safety gate — correct today, hazardous after eager-start.**
  The rule has no `concurrencySafe` gate, unlike `rule-async-gather-union-all`.
  This is *correct now*: the BloomJoin drains the build side fully before the
  probe pump starts (pump fires on first iteration), so pump and build never
  overlap and the pump is the sole reader of the probe iterator. But the filed
  `parallel-eager-prefetch-eager-start` backlog ticket will make the pump start
  on `run()`, overlapping the probe pump with the build for-await — at which
  point a shared serial vtab connection makes concurrent iteration unsafe.
  Annotated that backlog ticket to require landing a `concurrencySafe` gate on
  the wrap rule as part of the eager-start change. No code change in this pass.

### Scrutinized, accepted as-is

- **"Fires" SQL test sensitivity** (implementer-flagged) — the test depends on
  the optimizer picking a hash join and keeping the high-latency table on the
  build (right) side. The execution-equivalence test asserts the rule fired, so
  a future cost-model change that flips the shape would fail loudly rather than
  pass vacuously. Acceptable guard.
- **Build-side-only gate** — the asymmetric gate (`right` latency only) is a
  reasoned default, not measured against a real remote vtab (none in-tree). The
  plan ticket explicitly sanctions switching to `max(left, right)` later. Fine.
- **Skip predicates exercised only via mock nodes** — `Cache`/`AsyncGather` on
  the probe are coaxed from direct rule invocation, not a natural SQL plan. The
  logic coverage is sound; producing those shapes upstream of a hash join from
  SQL deterministically is genuinely awkward. Acceptable.
- **`MockRelNode` duplication** — re-declared from
  `test/runtime/fanout-lookup-join.spec.ts` rather than shared. Consistent with
  existing test conventions in this repo; not worth a shared-helper extraction.

### No pre-existing failures

No `tickets/.pre-existing-error.md` written — the full suite is green at this SHA.

## Follow-on tickets

- `tickets/fix/eager-prefetch-physical-passthrough.md` — fix `EagerPrefetchNode.computePhysical`.
- `tickets/backlog/parallel-eager-prefetch-eager-start.md` — eager-start the pump (now annotated to require a concurrency-safety gate).
