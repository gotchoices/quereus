description: The query planner charges a full read of a table on slow, remote storage as one network delay no matter how many rows it pulls, and it counts each millisecond of delay as if it were one row of in-memory work — so plans over remote storage are priced far from what they actually cost.
architecture: docs/optimizer-costing.md#first-row-latency-in-cost-comparisons
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/rules/shared/access-leaf.ts, packages/quereus/test/optimizer/join-latency-cost.spec.ts, packages/quereus/test/optimizer/index-nested-loop-batched.spec.ts, packages/quereus/test/optimizer/parallel-fanout-batched.spec.ts, packages/quereus-store/test/expected-latency-plan.spec.ts, packages/quereus-plugin-indexeddb/src/provider.ts, docs/optimizer-costing.md, docs/optimizer-joins.md, docs/module-capabilities.md, docs/module-authoring.md, docs/progressive-optimizer.md
difficulty: hard
----

# Price remote reads per row, in the planner's own cost units

A module can declare one latency today — `VirtualTableModule.expectedLatencyMs`, the *first-row* delay of an iterator it opens. Two things about how the planner uses it are wrong for remote storage, and this ticket fixes both:

1. **A full read costs one delay however many rows it pulls.** For storage that answers one page (or one row) per request, a 100,000-row scan is many round trips, priced as one.
2. **A millisecond is priced as one cost unit.** Every formula that adds latency to engine work adds the declared milliseconds verbatim, but one engine cost unit is one in-process sequentially scanned row (`COST_CONSTANTS.SEQ_SCAN_PER_ROW = 1.0`). Measured on the reference machine (`yarn bench`, `execution/full-scan-10k`: 10,000 rows in a 7.8–8.1 ms median on the memory backend, 12.9 ms on `store-mem`), one millisecond is roughly 800–1,300 cost units — a declared delay is under-weighted about a thousandfold against engine work.

Example of (2) with today's formulas, 25 ms remote, 100 outer rows probing a 10,000-row inner on its primary key: index-nested-loop `100 × (1.0 + 0.5 + 0.3 + 25) + 25 = 2,705` beats hash `100 × 0.8 + 10,000 × 0.4 + 25 + 25 = 4,130`, though the seek plan makes 101 round trips (≈ 2.5 s) and the hash plan two.

## Where this stands (audited 2026-11-01 against the tree)

Corrections to the backlog ticket this replaces:

- The asymmetry GitHub issue #30 described ("`hashJoinCost` takes no latency argument at all") was partly closed by `feat-join-latency-cost-symmetry` (landed 2026-08-23): `rule-join-physical-selection` now charges every candidate one open of its outer side plus however many opens of its inner side it performs — hash and merge pay one open of each side. What remains is item (1): an open is charged once, whatever the read then pulls.
- Line references moved: `indexNestedLoopJoinCost` is `cost/index.ts` ~178, the batched gate is `rule-fanout-batched-outer.ts:142`, the 25 ms default is `optimizer-tuning.ts` ~312.
- The store wiring for the existing hint landed (`store-module-latency-hint-wiring`): `KVStoreProvider.expectedLatencyMs` → `StoreModuleBase.expectedLatencyMs` → `IsolationModule`'s forwarding getter. No in-tree provider declares a value; the IndexedDB provider declines on purpose, pending this ticket (NOTE at `quereus-plugin-indexeddb/src/provider.ts` ~108).
- For the shape quoted in #30 (20k outer × 10k inner, no filter), the plugin's own bench (`quereus-plugin-indexeddb/bench/README.md`) says hash is the cheaper plan even once per-row cost is modelled: a full scan pages 256 rows per request (arm C, ≈ 0.005 ms per row at 20k rows) while a point read costs about three scanned rows (`costProfile.pointRead = 3.0`). This ticket changes which plan wins only where a backend's per-row cost is large relative to its seeks.

## Decision 1 — how a module says it: `expectedRowLatencyMs`

New optional `VirtualTableModule.expectedRowLatencyMs?: number`: wall-clock milliseconds per row an iterator yields **after the first**, in a sequential read. Omitted means 0 — rows arrive at in-process speed once the first is in hand, which is today's assumption. A hint: correctness never depends on it.

Options weighed: a per-request page size (`rowsPerRequest`) is equivalent for scans (`latency / page`) but cannot express per-row transfer or decode cost and needs a page model for seeks; a per-access-plan override on `BestAccessPlanResult` lets one module price indexes differently, which nothing needs yet (it can be added later as an override of the module-level value). A per-row figure is what an author can measure directly: the full-scan rate.

Propagation mirrors the first-row hint: `PhysicalProperties.expectedRowLatencyMs`, set by `TableReferenceNode.computePhysical` from the module (lifted only when finite and `> 0`), and merged upward as the max of the children by the default merge in `PlanNode.computePhysicalFromChildren`.

## Decision 2 — units: one scale knob, `tuning.latencyCostPerMs`

New `OptimizerTuning.latencyCostPerMs` (default **1000**): engine cost units charged per millisecond of declared latency, first-row or per-row. Applied wherever a rule **adds** latency to engine cost: `rule-join-physical-selection`'s per-candidate charges and the latency argument of `indexNestedLoopJoinCost` / `batchedIndexNestedLoopJoinCost`. Keep `cost/index.ts` in cost units — the formulas take an already-converted latency cost (rename the parameter to say so) and callers convert through one helper, so the conversion is spelled once.

Not converted, on purpose:

- the wall-clock gates — `batchedOuterThresholdMs`, `gatherThresholdMs`, `prefetchProbeThresholdMs` — read milliseconds and stay milliseconds;
- the fan-out gate in `rule-fanout-lookup-join` (`(N − cap) × maxLatency > N × branchSetupCost`) compares milliseconds with a millisecond-equivalent setup cost on both sides and is left alone.

The default is the measured order of magnitude rounded **down** (under-weighting a delay slightly rather than over-weighting it); plans are sensitive to the order of magnitude only, and a host on very different hardware can set it. Rejected: inflating a module's declaration to the ratio value (lies to the wall-clock gates — the NOTE at `indexNestedLoopJoinCost` already forbids it); a per-module scale (the ratio is a property of the host CPU against the engine, not of the backend); self-calibrating at startup (timing inside planning makes plans machine- and load-dependent and tests nondeterministic — leave a `NOTE:` saying so at the knob). Rewrite the unit-mismatch NOTE at `indexNestedLoopJoinCost` to describe the settled convention.

## Decision 3 — which formulas consume it: drain latency per input

In `rule-join-physical-selection`, per input side:

- `rowsRead(side)` — the rows the side pulls from storage: the access leaf's own row count when the side peels to one (`peelToSeekableAccessLeaf` in `rules/shared/access-leaf.ts` — a Filter above a scan still reads every row the scan yields); else the side's row estimate. When the count is unknown, use whatever the rule already uses for that side (`leftRows` / `rightRows`, today `|| 100`) — one helper, so `unknown-size-join-scans-instead-of-seeking` can later change the default for every term at once.
- `readMs(side) = firstRowMs(side) + rowsRead(side) × rowMs(side)` — the wall-clock to open the side and drain it once.

Each candidate is charged, converted by `latencyCostPerMs`:

| candidate | charge |
| --- | --- |
| plain nested loop | `readMs(left) + (opensOnce ? readMs(right) : leftRows × readMs(right))` |
| hash, merge | `readMs(left) + readMs(right)` |
| index-nested-loop | `readMs(left)`, plus per seek (inside the formula) `firstRowMs(inner) + rowsPerSeek × rowMs(inner)` |
| index-nested-loop, mirrored | `readMs(right)`, plus the per-seek term keyed on the left |
| batched (either orientation) | `readMs(outer)`, plus the per-seek term divided by the in-flight count |

At `rowMs = 0` every row of this table reduces to today's charge table times the scale. `IndexNestedLoopCandidate.perSeekLatencyMs` becomes the per-seek drain (still milliseconds), so the batched short-circuit `perSeekLatencyMs === 0` keeps working. `nestedLoopInnerLatency`'s short-circuit (skip the cache-rule walk at zero latency) must test both latencies.

## Not this ticket

- The store and isolation surface for declaring the per-row value: `store-provider-declares-per-row-latency` (next).
- Measuring and declaring IndexedDB's numbers, and whether the 25 ms gates should become cost-based for sub-millisecond backends: backlog `feat-indexeddb-declares-its-read-latency`. Update the NOTE at the IndexedDB provider to point there.
- QuickPick scores tours with `getTotalCost()`, which carries no latency at all. Leave a `NOTE:` at `estimatePlanCost` in `rule-quickpick-enumeration.ts`; it is not this ticket.
- `rule-nested-loop-right-cache` admits on size only; per-row latency makes caching a remote inner worth more. Leave a `NOTE:` at its size gate.
- Restructuring the candidate comparison (`debt-join-selection-candidate-list`, backlog) — keep this change to the charge expressions.

## Edge cases & interactions

- **In-tree inertness.** Every in-tree module declares 0 for both hints, so every charge is 0 and no plan changes. Verify: `yarn test` (golden-plans.spec unchanged) and `yarn bench:gate` (foreground, ~35 s; zero counter differences).
- **Existing latency fixtures** (25 ms / 30 ms: `join-latency-cost.spec.ts`, `index-nested-loop-batched.spec.ts`, `parallel-fanout-batched.spec.ts`, `quereus-store/test/expected-latency-plan.spec.ts`, and any other spec that fails) now see latency ×1000. Re-derive each from the formulas. Where a test's stated intent is scale-independent (e.g. "the right side's latency cancels between hash, merge and the mirror"), keep the intent and adjust fixture sizes or latencies; where an old expectation was itself the miscalibration (a seek plan preferred over two opens at 25 ms with tens of outer rows), change the expectation and say why in the handoff. The eleven copies of the fixture module are tracked by `debt-shared-high-latency-test-module` — do not fold that refactor in. Verify: those specs.
- **Gates unchanged.** `parallel-async-gather*.spec.ts`, `parallel-eager-prefetch-probe.spec.ts`, `parallel-fanout.spec.ts`, `parallel-side-effect-refusal.spec.ts` gate on wall-clock milliseconds and must pass untouched. Verify: those specs.
- **Non-peelable side** (a join or aggregate subtree): `rowsRead` falls back to the side's own estimate, which under-counts rows read beneath a filter or aggregate inside it; `rowMs` is the max over its leaves. Verify: inspection; state the approximation in `docs/optimizer-joins.md`.
- **Inner the cache rule will wrap**: one drain, not one per outer row (`nestedLoopRightOpensOnce`, as today). Verify: the NL arm of the new test, or inspection.
- **Mirrored orientation**: its outer is the right side and its per-seek drain is the left's. Verify: the re-derived "each candidate is charged its own inner side" arm.
- **Batched**: only the per-seek term is divided by the in-flight count; the outer's drain is charged once. A per-row latency with zero first-row latency yields no batched candidate (`toBatchedOuter` gates on first-row latency). Verify: inspection; the re-derived batched spec.
- **Invalid declarations** (negative, NaN, Infinity) read as 0 — the leaf lifts only finite positive values, exactly as for the first-row hint. Verify: inspection.
- **Unknown or measured-zero row counts**: drains use the rule's side rows, whatever default that carries (revisited by `bug-measured-empty-table-costed-as-thousand-rows` and `unknown-size-join-scans-instead-of-seeking`). Verify: inspection.
- **No runtime change**: estimates and costs only. Verify: inspection.

## Tests (only these)

In `join-latency-cost.spec.ts`, one new `describe('per-row read latency')` over a fixture module declaring first-row latency 25 ms and per-row latency `R`, with an analyzed 50-row outer joined on the primary key of an analyzed 5,000-row inner (state the arithmetic in a comment):

- `R = 1`: index-nested-loop wins — hash pays `(25 + 50·1) + (25 + 5,000·1)` ms ≈ 5.1 million units against the seek plan's `(25 + 50·1) + 50 × (25 + 1·1)` ms ≈ 1.4 million.
- `R = 0` (control): hash wins — two opens (50,000 units plus 2,040 of engine work) against fifty seeks (≈ 1.28 million).

## TODO

Phase 1 — scale
- `latencyCostPerMs` in `OptimizerTuning` / `DEFAULT_TUNING`, with the measurement and the self-calibration `NOTE:` at the field.
- One conversion helper; `indexNestedLoopJoinCost` / `batchedIndexNestedLoopJoinCost` take a latency cost; convert at the call sites in `index-nested-loop.ts` and `rule-join-physical-selection.ts`; rewrite the unit NOTE at `indexNestedLoopJoinCost`.
- Re-derive the latency specs that fail (see edge cases) and list each change, with its reason, in the handoff.

Phase 2 — per-row
- `VirtualTableModule.expectedRowLatencyMs` (doc comment), `PhysicalProperties.expectedRowLatencyMs`, the default max-merge, the lift in `TableReferenceNode.computePhysical`.
- `rowsRead` / `readMs` helpers in `rule-join-physical-selection.ts`; every candidate's charge per the table above; per-seek drain in `tryIndexNestedLoop`; the zero-latency short-circuit tests both hints.
- The two tests above.
- `NOTE:`s at QuickPick's `estimatePlanCost` and the nested-loop cache size gate; IndexedDB provider NOTE points at `feat-indexeddb-declares-its-read-latency`.

Phase 3 — docs and checks
- `docs/optimizer-costing.md` § First-row latency in cost comparisons: cover both hints and the scale (keep the heading's anchor or update every link to it — `yarn docs:check` finds them).
- `docs/optimizer-joins.md`: the charge table and the cost-model list.
- `docs/progressive-optimizer.md` §5: trim the "Remote reads priced per row" item to the store-provider ticket.
- `docs/module-capabilities.md` § Surface inventory: a row for `expectedRowLatencyMs` beside the `expectedLatencyMs` one (meaning, fallback 0, "declare only measured numbers"). `docs/module-authoring.md` is 85 words under the 12,000-word cap (`yarn docs:check` prints the notice) and the cap has no grace band — give it at most a one-line pointer to the inventory, or move a section to a satellite first.
- `yarn lint`, `yarn test`, `yarn workspace @quereus/store test`, `yarn bench:gate`, `yarn docs:check`.
