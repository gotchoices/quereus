description: The query planner charged a full read of a table on slow, remote storage as one network delay no matter how many rows it pulled, and counted each millisecond of delay as one row of in-memory work; it now prices a read by the rows it pulls and converts milliseconds to work units at a measured rate.
architecture: docs/optimizer-costing.md#first-row-latency-in-cost-comparisons
files: packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts, packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts, packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus-plugin-indexeddb/src/provider.ts, packages/quereus/test/optimizer/join-latency-cost.spec.ts, packages/quereus/test/optimizer/index-nested-loop.spec.ts, packages/quereus/test/plan/**/*.plan.json, docs/optimizer-costing.md, docs/optimizer-joins.md, docs/module-capabilities.md, docs/progressive-optimizer.md, docs/runtime-parallel.md
difficulty: hard
----

# Price remote reads per row, in the planner's own cost units — complete

## What landed (`ticket(implement): feat-per-row-latency-cost-for-remote-scans`)

- **Scale.** `OptimizerTuning.latencyCostPerMs` (default 1000, measured from the full-scan bench and rounded down). `latencyCost(ms, tuning)` in `cost/index.ts` is the single conversion site; `indexNestedLoopJoinCost` / `batchedIndexNestedLoopJoinCost` take an already-converted `perSeekLatencyCost`. The wall-clock gates (`parallel.*ThresholdMs`, the fan-out savings gate) keep reading raw milliseconds.
- **Per-row hint.** `VirtualTableModule.expectedRowLatencyMs` → `PhysicalProperties.expectedRowLatencyMs`, lifted at the table leaf when finite and positive (the first-row lift gained the same finiteness guard), max-merged up the tree like the first-row hint.
- **Drains.** `rule-join-physical-selection` prices a side's full read as `firstRowMs + rowsRead × rowMs`, with `rowsRead` the access leaf's count when the side peels to one, else the side's own estimate; every candidate pays one drain of its outer plus the drains of its inner it performs. A seek pays `firstRowMs + rowsPerSeek × rowMs`.
- **Docs** rewritten in `optimizer-costing.md`, `optimizer-joins.md` (charge table, consequences, crossovers), `module-capabilities.md`, `progressive-optimizer.md`; NOTEs at QuickPick scoring, the cache rule's size gate and the IndexedDB provider.

## Review findings

**Read first:** the implement diff in full (source, tests, docs, goldens), then the handoff. Checked SPP/DRY, error paths, type safety, hot-path cost, docs reality, and the arithmetic.

**Arithmetic re-derived (all hold).** The new spec's numbers: hash 2,040 + (75 + 5,025) ms × 1,000 = 5,102,040; index-NL 50 × (1.8 + 26,000) + 75,000 = 1,375,090. The `optimizer-joins.md` crossovers, from `batched = 20,000 × (1.8 + (25,000 + 1,000R)/16)` against `hash = 41,000 + (0.4 + 1,000R) × M` with `inFlight = min(16, 64) = 16`: serial first-row-only ≈ 1.25 billion; batched first-row-only 78.1 million; R = 0.01 → 3.0 million; R = 1 → 32,500. Hash builds from the smaller side, so the test's `0.8 × 50 + 0.4 × 5,000` is the right orientation.

**Correctness checks, no defect found.**

- `readMs` returns the raw first-row figure when `rowMs` is 0, so the leaf peel and the cache rule's subtree walk stay off the zero-latency path; `nestedLoopInnerLatency`'s `=== 0` short-circuit is therefore sound for both hints.
- `rowsRead` peels through Alias / trivial Project / Filter only; a `CacheNode`-wrapped inner (the rule's second visit) falls back to the side's estimate, which is correct since a cached inner is drained once.
- No other `computePhysical` copies `expectedLatencyMs` by hand (grep of `src/`), so the max-merge default is the only propagation path and the per-row hint cannot be dropped by a node that forwards the first-row one.
- The golden plans gained `"expectedRowLatencyMs": 0` on every non-leaf because the merged `physical` block is serialized whole; shapes are unchanged. Accepted as the implementer argued: omitting a zero would make the two hints asymmetric.
- The hand-built `OptContext` doubles in `index-nested-loop.spec.ts` now carry `tuning`; that duck-typing is already `debt-planner-test-doubles-duck-typed`'s concern.

**Minor, fixed inline.**

- `optimizer-tuning.ts`: the `parallel` block's header claimed "all values are unitless cost comparators" and `branchSetupCost` was documented as "anchored against `NL_JOIN_PER_OUTER_ROW`, ms-equivalent cost" — the pre-change unit confusion this ticket settled. Under `latencyCostPerMs = 1000` one cost unit is about a microsecond, so that anchor is off a thousandfold. Both comments and the default's comment now say the gates and `branchSetupCost` are wall-clock milliseconds compared against raw declarations.
- `docs/runtime-parallel.md` described the `PhysicalProperties` merge defaults without the new field; it now names `expectedRowLatencyMs` beside `expectedLatencyMs` and links the costing doc.

**Tripwire recorded.** `toBatchedOuter` (`rule-fanout-batched-outer.ts`) gates on the first-row hint only, so a module declaring a per-row latency without a first-row one never gets a batched seek even though batching would amortize its per-seek round trip. Fine now (no module declares that shape; the doc already states the behaviour); `NOTE:` at the gate says what to change if one does.

**Major findings:** none. The one architectural gap — QuickPick scoring, access-path selection and the cache rule's size gate ignore both hints — is conditional on a module declaring latency, is recorded as NOTEs at two of the three sites by the implementer, and is not a latent defect: those paths produce the same plans they did before.

**Tests.** No test cut: the two new specs pin distinct behaviours (per-row latency reaches the seek plan's price; first-row latency alone cannot favour it) over a real module fixture, not a mock. None added: the fixes above are comments and docs.

**Tickets filed:** none. **Accepted-tradeoff NOTEs encountered:** the IndexedDB provider's declaration refusal (revisit condition is `feat-indexeddb-declares-its-read-latency`, still open) — left alone.

## Validation (repo root, 2026-11-01)

| command | result |
| --- | --- |
| `yarn workspace @quereus/quereus run lint` | clean |
| targeted mocha: `optimizer/join-latency-cost`, `index-nested-loop*`, `parallel-*`, `plan/**` | 594 passing |
| `yarn test` | quereus 10,838 passing / 25 pending (pre-existing); store 1,958; every other workspace green |
| `yarn docs:check` | OK |

## Follow-ups already on the board

`store-provider-declares-per-row-latency` (implement) adds the key-value store provider surface; `feat-indexeddb-declares-its-read-latency` (backlog) measures and declares; `unknown-size-join-scans-instead-of-seeking` (fix) and `bug-measured-empty-table-costed-as-thousand-rows` (implement) revisit the `sideRows` default, now spelled in one place.
