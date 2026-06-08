---
description: Monotonic range-scan recognition rule with diagnostic annotation
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/test/optimizer/monotonic-range-scan.spec.ts, packages/quereus/test/optimizer/predicate-analysis.spec.ts, packages/quereus/test/vtab/test-monotonic-decline-module.ts, docs/optimizer.md
---

## Summary

Added the monotonic range-scan recognition layer over the existing constraint-extraction + advertisement plumbing. Introduces a passive `rangeBoundedOn` annotation on physical access leaves and a defensive `monotonicOn` drop when a Filter sits directly above a leaf carrying an unhandled range/equality on the monotonic column.

## Surface area

- `PhysicalProperties.rangeBoundedOn?: { attrId; lower?; upper? }` (`packages/quereus/src/planner/nodes/plan-node.ts`)
  Symbolic bound annotation for EXPLAIN and downstream rules. Half-open ranges omit `lower`/`upper`. `valueLiteral` is populated when the bound is a literal; absent for parameter / correlated bounds. Non-relational — does not propagate through pass-through nodes.

- `IndexScanNode`, `IndexSeekNode`, `SeqScanNode` each gained two optional constructor parameters (`packages/quereus/src/planner/nodes/table-access-nodes.ts`):
  - `rangeBoundedOn?: PhysicalProperties['rangeBoundedOn']` — merged into the leaf's `computePhysical` output.
  - `suppressMonotonic?: boolean` — when true, the lifted `monotonicOn` and the implied `accessCapabilities` are stripped before being merged. Both fields propagate through `withChildren`.

- `rule-monotonic-range-access` (`packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts`)
  Two responsibilities, dispatched on input node type:
  - **Annotation pass** (input is `IndexScan` / `IndexSeek` / `SeqScan`): if the leaf advertises `monotonicOn(x)` and its `FilterInfo.constraints` carries a handled range/equality on `x`, set `rangeBoundedOn`. Literal extraction reads from `IndexSeekNode.seekKeys` parallel to `FilterInfo.constraints[i].argvIndex`.
  - **Defensive drop pass** (input is `Filter`): if the Filter's source is a leaf with `monotonicOn(x)` and the predicate canonicalises to a range/equality on `x` (extracted via `extractConstraints`), clone the leaf with `suppressMonotonic = true` so downstream rules see a non-monotonic stream.

- Registered in `PassId.PostOptimization` at priority 9 on each of the four targeted node types — `IndexScan`, `IndexSeek`, `SeqScan`, and `Filter` (`packages/quereus/src/planner/optimizer.ts`). Rule ids are individually disable-able via `tuning.disabledRules`:
  - `monotonic-range-access-IndexScan`
  - `monotonic-range-access-IndexSeek`
  - `monotonic-range-access-SeqScan`
  - `monotonic-range-access-filter`

## Recognition coverage

| SQL shape | Recognised | `rangeBoundedOn` set |
| --- | --- | --- |
| `x BETWEEN a AND b` | yes (decomposed to `>=`/`<=` by extractor) | yes |
| `x >= a AND x <= b`, `x >= a AND x < b`, `x > a AND x <= b`, `x > a AND x < b` | yes | yes |
| `x = c` | yes (degenerate range; only fires when leaf advertises `monotonicOn` for equality, which memory module does not) | conditionally |
| half-bound `x >= a` / `x < b` alone | yes | yes (only one side populated) |
| `x IN (c1, c2, …)` | no — multi-IN multi-seek emits non-monotonic; memory module declines `monotonicOn` for it; rule no-ops | no |

## Composition with other rules

`rangeBoundedOn` is a passive annotation today — no other optimizer rule reads it. `monotonic-merge-join`, `monotonic-limit-pushdown`, and `lateral-top1-asof` continue to inspect `physical.monotonicOn` / `accessCapabilities`, so they compose cleanly with range-bounded leaves (a range-bounded merge / asof / slice still operates on the range's emit order).

The defensive `monotonicOn` drop is load-bearing: it is the safety net against a vtab that advertises `monotonicOn(x)` while declining a range filter on `x`.

## Tests

- `packages/quereus/test/optimizer/monotonic-range-scan.spec.ts` — 16 tests covering:
  - All 7 recognition patterns (BETWEEN, ≥/≤, ≥/<, >/≤, >/<, half-bound ≥, half-bound <).
  - Edge cases: empty range, single-element range, multi-IN.
  - Diagnostics: `physical` JSON contains `"rangeBoundedOn"` with the expected shape.
  - Negative cases: no WHERE clause, equality on PK (memory module doesn't advertise `monotonicOn`), rule-disabled tuning.
  - Defensive: a custom test vtab (`packages/quereus/test/vtab/test-monotonic-decline-module.ts`) that advertises `monotonicOn` while declining range filters; the rule must drop `monotonicOn` from the leaf when a residual `FilterNode` sits above it.

- `packages/quereus/test/optimizer/predicate-analysis.spec.ts` — 21 tests total (10 new in the canonical-form audit block pinning the canonical constraint shape produced by `extractConstraints` for each recognition pattern).

## Validation

- `yarn workspace @quereus/quereus exec tsc --noEmit` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — 2623 passing, 2 pending, 0 failing.
- `yarn build` — clean monorepo build.

## Usage notes

- To inspect: run `SELECT node_type, op, detail, physical FROM query_plan('SELECT id FROM r WHERE id BETWEEN 2 AND 5')` and look for `"rangeBoundedOn"` in the `physical` JSON of the leaf row.
- To disable individually: add any of the four rule ids above to `tuning.disabledRules`.
- The annotation reads `FilterInfo.constraints` (handled bounds), not the residual Filter predicate. The defensive drop reads the parent Filter's predicate via `extractConstraints` to detect the unhandled bound.

## Known limitations / follow-ups

- `rangeBoundedOn` is a passive annotation; no other optimizer rule reads it today. Future range-statistics-driven costing rules can plumb it in without further leaf changes.
- `SeqScanNode` does not currently carry an `AccessPathAdvertisement` (the `createSeqScan` helper hard-codes a default `FilterInfo`). The rule's annotation pass on `SeqScanNode` is therefore effectively dead code today — it only fires when `physical.monotonicOn` is set, which `SeqScanNode` never is in current vtab modules. If a future module advertises `monotonicOn` on a seq scan, the rule already handles it.
- The defensive drop re-canonicalises the Filter's predicate via `extractConstraints` on every match. For dense plans this is cheap, but a future optimisation could thread the parent Filter's already-extracted constraints into the rule via the `OptContext`.
