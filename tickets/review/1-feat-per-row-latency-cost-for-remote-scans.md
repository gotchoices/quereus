description: The query planner charged a full read of a table on slow, remote storage as one network delay no matter how many rows it pulled, and counted each millisecond of delay as one row of in-memory work; it now prices a read by the rows it pulls and converts milliseconds to work units at a measured rate — review the charge arithmetic and the re-derived expectations.
architecture: docs/optimizer-costing.md#first-row-latency-in-cost-comparisons
files: packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts, packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus-plugin-indexeddb/src/provider.ts, packages/quereus/test/optimizer/join-latency-cost.spec.ts, packages/quereus/test/optimizer/index-nested-loop.spec.ts, packages/quereus/test/plan/**/*.plan.json, docs/optimizer-costing.md, docs/optimizer-joins.md, docs/module-capabilities.md, docs/progressive-optimizer.md
difficulty: hard
----

# Price remote reads per row, in the planner's own cost units — implemented

## What landed

**Scale (Decision 2).** `OptimizerTuning.latencyCostPerMs` (default 1000) with the measurement and the no-self-calibration `NOTE:` at the field. `latencyCost(ms, tuning)` in `cost/index.ts` is the one conversion site. `indexNestedLoopJoinCost` / `batchedIndexNestedLoopJoinCost` now take `perSeekLatencyCost` (already converted); the unit-mismatch `NOTE:` there is rewritten to the settled convention. Both callers (`index-nested-loop.ts`, `rule-join-physical-selection.ts`) convert through the helper. The wall-clock gates (`*ThresholdMs`) and the fan-out savings gate are untouched and still read raw milliseconds.

**Per-row hint (Decision 1).** `VirtualTableModule.expectedRowLatencyMs?`, `PhysicalProperties.expectedRowLatencyMs?`, max-merge in `PlanNode.computePhysicalFromChildren`, lift in `TableReferenceNode.computePhysical`. The lift now requires `Number.isFinite` for both hints (before, an `Infinity` first-row declaration would have passed `> 0`).

**Drains (Decision 3).** In `rule-join-physical-selection.ts`: `sideRows` (the one place the `|| 100` unknown default is spelled), `rowsRead` (leaf count via `peelToSeekableAccessLeaf`, else the side's rows), `readMs = firstRowMs + rowsRead × rowMs`. Every candidate is charged per the ticket's table; `nestedLoopInnerLatency` takes the inner's drain and its short-circuit therefore tests both hints. `IndexNestedLoopCandidate.perSeekLatencyMs` is the per-seek drain in milliseconds (`firstRowMs + rowsPerSeek × rowMs`), so the batched `=== 0` short-circuit still works; `tryBatchedIndexNestedLoop` takes the whole tuning and converts the per-seek term itself.

**NOTEs** at QuickPick's `estimatePlanCost` (no latency in `getTotalCost()`), the nested-loop cache rule's size gate (blind to inner latency), and the IndexedDB provider (now points at `feat-indexeddb-declares-its-read-latency` and explains why the bench's ratio arms are not a per-row measurement).

**Docs.** `optimizer-costing.md` § First-row latency in cost comparisons rewritten for both hints, the units, the drain definition (heading kept so the two tickets' anchors still resolve). `optimizer-joins.md`: cost-model list, the charge table (now in drains), the four consequences, and the crossover sentence re-derived (see below). `progressive-optimizer.md` §5 item trimmed to the store-provider ticket. `module-capabilities.md`: static-field list and an inventory row for `expectedRowLatencyMs`. `module-authoring.md` deliberately untouched: it never mentioned `expectedLatencyMs` either, the inventory covers both, and it sits 85 words under its cap.

## Validation run (all from repo root, 2026-11-01)

| command | result |
| --- | --- |
| `yarn lint` | clean (eslint + test-file tsc pass) |
| `yarn test` | quereus 10,838 passing / 25 pending (pre-existing); every other workspace green |
| `yarn workspace @quereus/store test` | 1,958 passing |
| `yarn bench:gate` | passed — every gated work counter matches the reference; `execution/full-scan-10k` timed 8.53 ms, consistent with the 7.8–8.1 ms the knob's default was derived from |
| `yarn docs:check` | OK (links, anchors, ratchet, tiers) |

`yarn typecheck` was not run (it needs `yarn build` first); the lint step's `tsc -p tsconfig.test.json` pass covered the quereus sources and specs, and the only cross-package change is one added optional field plus a comment.

## Tests added (only these)

In `test/optimizer/join-latency-cost.spec.ts`, `describe('per-row read latency')` over `PerRowLatencyMemoryModule` (25 ms first-row, 1 ms per row), a 50-row analyzed outer joined on the primary key of a 5,000-row analyzed inner, both tables on the fixture module:

- `R = 1: the index-nested-loop wins` — pins that a per-row latency reaches hash's drain of the whole inner and the seek plan's per-seek term: hash ≈ 5,102,040 against index-NL ≈ 1,375,090 (arithmetic in the comment). Also asserts no hash join and executes the plan.
- `R = 0 (control): hash wins` — the same shape on the 25 ms-only fixture: 52,040 against 1,275,090, pinning that first-row latency alone can never favor the seek plan (why IndexedDB withheld its declaration).

## Existing latency specs: re-derived, outcomes unchanged

Every existing fixture passes with no change to data or expectations; only the arithmetic comments were rewritten to the new scale. The reasons, per spec, for the reviewer to check:

- `join-latency-cost.spec.ts` arm 1 (exists join, 100 × 20, inner 25 ms): cached NL 25,300 vs index-NL 2,500,180 → NL; uncached NL 2,500,300 vs index-NL 2,500,180 → index-NL. Both contestants pay 100 opens, so engine work (300 vs 180) decides at any scale — the same 120-unit margin as before. Arm 2: the right's drain is a constant across hash, merge and the mirror, so it cancels regardless of scale; the hi-lat-left case only widens. Arm 3 (2 × 40): 25,010 vs 25,017.6 — same 7.6 margin as before.
- `index-nested-loop-batched.spec.ts`: batched = 4 × (1.8 + 25,000/16) ≈ 6,257 against merge ≈ 25,077 / hash ≈ 25,083; the chain test's second join inherits the fan-out's 25 ms as its outer drain (25,000 on every candidate) and still picks batched (≈ 29,693 vs ≈ 50,063). Its unit tests of `batchedIndexNestedLoopJoinCost` pass positional values, so the parameter rename is invisible to them.
- `quereus-store/test/expected-latency-plan.spec.ts` (30 ms): batched ≈ 7,507 vs ≈ 30,077 → batched; undeclared → serial index-NL. Unchanged.
- `parallel-eager-prefetch-probe.spec.ts`, `parallel-side-effect-refusal.spec.ts`: their hash joins still win (both sides unknown-size → 100 rows each; hash 25,120 vs NL 26,100 vs index-NL ≈ 2.5 million). The gate specs (`parallel-fanout*`, `parallel-async-gather*`) form their fan-outs/gathers in Structural before physical selection runs and compare milliseconds; untouched and passing.

No old expectation turned out to be the miscalibration itself (the ticket anticipated one might) — every existing contest was either N opens vs N seeks or a cancelling constant.

## Flags for the reviewer (honest gaps)

- **Six golden plans changed** (`test/plan/**/*.plan.json`, 46 insertions, 0 deletions, all `"expectedRowLatencyMs": 0`). The goldens serialize the full `physical` block, which already carried `expectedLatencyMs: 0`, so the default max-merge's new zero shows up beside it. Plan shapes are byte-identical otherwise. The alternative — omit the field when 0 — would make the two hints asymmetric and was rejected. The ticket's "golden-plans.spec unchanged" verify item holds for shape, not for bytes.
- **Two hand-built `OptContext` doubles** in `test/optimizer/index-nested-loop.spec.ts` gained `tuning: db.optimizer.tuning` because `tryIndexNestedLoop` now converts through `context.tuning`. Duck-typed doubles are `debt-planner-test-doubles-duck-typed`'s concern; not expanded here.
- **`rowsRead` on a measured-empty leaf** falls back to the side's rows and then to 100 via `||` — the same sentinel collapse the work terms already make; `bug-measured-empty-table-costed-as-thousand-rows` (implement queue) revisits both together since `sideRows` is now the single spelling.
- **Non-peelable sides** (a join or aggregate subtree) use their own estimate for `rowsRead` and the max over leaves for `rowMs`, under-counting rows read beneath an inner filter or aggregate. Stated in `docs/optimizer-joins.md`; not modelled further.
- **Crossover numbers in `docs/optimizer-joins.md`** (1.25 billion → 78 million inner rows at 25 ms first-row only; about 3 million at 0.01 ms per row; about 32,000 at 1 ms per row, 20,000-row outer, one row per seek, local outer) were evaluated by hand from the formulas — worth a spot check: batched = `20,000 × (1.8 + (25,000 + 1,000R)/16)`, hash = `16,000 + 0.4M + 25,000 + 1,000·R·M`.
- **The per-row hint reaches only join selection.** QuickPick scoring, access-path selection and the cache rule's size gate do not read it (NOTEs at the first and third). The IndexedDB provider still declares nothing; `store-provider-declares-per-row-latency` (next in the implement queue) adds the store surface, then `feat-indexeddb-declares-its-read-latency` measures.
- **`cost/index.ts` now type-imports `OptimizerTuning`** (for `Pick<OptimizerTuning, 'latencyCostPerMs'>`). Type-only, erased at compile time, no runtime cycle; `optimizer-tuning.ts` imports nothing.
- **No runtime change.** Estimates and costs only; the executed rows in every latency spec are compared against the plain-memory answer.

## How to exercise by hand

```sql
-- in a host that registers a module declaring expectedLatencyMs = 25 and expectedRowLatencyMs = 1:
create table po (id integer primary key, k integer) using <module>;
create table pi (id integer primary key, v integer) using <module>;
insert into po select value, value * 7 % 5000 + 1 from generate_series(1, 50);
insert into pi select value, value from generate_series(1, 5000);
analyze;
explain select po.id, pi.id from po join pi on pi.id = po.k;   -- correlated IndexSeek under a JoinNode
```

Drop `expectedRowLatencyMs` from the module and the same statement plans a hash join. Setting `latencyCostPerMs` to 1 via `optimizer.updateTuning` reproduces the pre-change pricing (a millisecond worth one scanned row).
