---
description: Collapsed `PhysicalProperties.uniqueKeys` into `fds`. Unique keys are now encoded as `K → (all_cols \ K)` FDs and at-most-one-row as the `∅ → all_cols` singleton FD. The field is removed from the type and every producer/consumer migrated.
prereq:
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/framework/physical-utils.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/nodes/table-function-call.ts
  - packages/quereus/src/planner/nodes/single-row.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/nodes/limit-offset.ts
  - packages/quereus/src/planner/nodes/ordinal-slice-node.ts
  - packages/quereus/src/planner/nodes/sort.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/src/planner/nodes/retrieve-node.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## What landed

`PhysicalProperties.uniqueKeys` is removed. Unique keys are expressed exclusively through `PhysicalProperties.fds`:

- A unique key `K ⊊ all_cols` is encoded as `K → (all_cols \ K)`.
- The "at-most-one-row" claim is the singleton FD `∅ → all_cols` (replacing the legacy `[[]]` marker).
- The "all-columns is the only key" case (DISTINCT, set-typed inputs without a smaller key) has no non-trivial FD encoding — it lives on `RelationType.isSet`.

### New / changed helpers in `planner/util/fd-utils.ts`

- `superkeyToFd(key, columnCount)` now returns `FunctionalDependency | undefined` (undefined when the key covers every column).
- `singletonFd(columnCount)` builds `∅ → all_cols`.
- `isSuperkey(attrs, fds, columnCount)` — closure-based superkey check (true on the trivial all-cols-superkey-of-all-cols tautology).
- `isAssertedKey(attrs, fds, columnCount)` — stricter: requires an FD whose determinants ⊆ attrs and whose closure covers all columns. Used for strict-monotonicOn detection.
- `hasAnyKey(fds, columnCount)`, `hasSingletonFd(fds, columnCount)`, `deriveKeysFromFds(fds, columnCount)`.
- `AddFdOptions.uniqueKeys` renamed to `AddFdOptions.keyHints` (semantics unchanged — cap-preference hint).

### Behavior changes

- `projectFds` now drops a dependent column when it can't be mapped instead of dropping the whole FD. Lets `∅ → all_cols` survive projection (provably safe: `X → Y` implies `X → Y'` for any `Y' ⊆ Y`).
- `analyzeJoinKeyCoverage` returns `preservedKeys: number[][]` (always non-undefined, possibly empty) instead of `uniqueKeys`. `propagateJoinFds` materializes each preserved key as a `key → all_other_join_cols` FD on the join output via `superkeyToFd`. The physical-key-coverage check is now `isSuperkey(eqSet, phys.fds, colCount)`.

### Cleanup performed during review

- Removed dead helpers `uniqueKeysImplyDistinct` and `projectUniqueKeys` from `planner/framework/physical-utils.ts` — they had no production callers after migration. Their 7 unit tests in `test/planner/framework.spec.ts` were dropped along with the imports.
- Refreshed two stale comments referencing `uniqueKeys` (`reference.ts` PK-FD seeding comment; `project-node.ts` migration-history comment).

## Validation

- `yarn build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus test` — 2888 passing, 2 pending. (Drop from 2895 is exactly the 7 dead-code tests removed.)
- `yarn test` (full repo) — 2 pre-existing failures in `@quereus/sample-plugins` (`key_value_store` delete/update). Confirmed they reproduce on the prior commit and are unrelated to FD work.

## Review findings

### What I checked

1. **Diff read** of `50303be3` end-to-end with no prior assumptions: `fd-utils`, `key-utils`, `plan-node`, `characteristics`, every migrated node, both rule consumers, both docs.
2. **Residual `uniqueKeys` references** in `packages/quereus/src` via Grep. Remaining hits classified:
   - `fd-utils.ts` and `characteristics.ts` — comments documenting the legacy form; legitimate.
   - `analysis/constraint-extractor.ts` — `TableInfo.uniqueKeys` (logical/schema-side, not `PhysicalProperties`); out of scope per ticket.
   - `nodes/filter.ts` — `tableInfo.uniqueKeys` (same — logical schema concept); legitimate.
   - `nodes/project-node.ts:295` — `getLogicalAttributes()` exposes logical keys for plan-debug output; intentional, handoff-acknowledged.
   - `nodes/reference.ts` and `nodes/project-node.ts` migration-history comments — refreshed in this pass.
   - `framework/physical-utils.ts` — dead helpers; removed in this pass.
3. **Per-node FD-encoding correctness** for: TableReference, SeqScan / IndexScan / IndexSeek, Filter, Project, Returning, Aggregate (all three variants), Distinct, Join (inner, outer, semi, anti), Alias, Sort, Window, LimitOffset, OrdinalSlice, AsofScan, Retrieve, SingleRow, EmptyResult, TableFunctionCall.
4. **Project / Returning key projection switched from `sourcePhysical.uniqueKeys` to `source.getType().keys`.** Verified the old physical-keys path is still covered: source FDs (projected through the same mapping) carry the source's key encodings; both paths together preserve the claim. Specifically traced through Project-over-Aggregate, Project-over-Filter-with-PK-equality, and Project-over-Inner-Join-on-FK.
5. **Lint + test** at full repo and per-package level.
6. **Docs** — `architecture.md` and `optimizer.md` updates reflect the new reality (FDs are the canonical surface; `uniqueKeys` field gone; helper inventory current).

### Findings — minor (fixed inline)

- `reference.ts:84` comment claimed PK FDs "duplicate the all-columns implication already carried by `uniqueKeys`" — false post-migration. Rewritten to describe the FD seeding as the canonical encoding.
- `project-node.ts:184` comment ended with "the 'key-ness' claim that was previously emitted via `uniqueKeys`" — migration-history phrasing per AGENTS.md guidance to keep comments timeless. Trimmed.
- `physical-utils.ts` — `uniqueKeysImplyDistinct` and `projectUniqueKeys` had no production callers (only the framework spec referenced them). Deleted both helpers and their 7 unit tests, plus the stale imports. Kept the rest of `physical-utils.ts` intact.

### Findings — major (none)

No major findings. The migration is mechanically thorough and the new FD encoding is correctly applied at every site. Edge cases (zero-column SingleRow, empty-result, full-PK IndexSeek, group-by-derived keys, join-key preservation under all join types, semi/anti shape) are handled.

### Findings — explicit non-findings

- **Performance / cost / cache invalidation**: no behavior change to physical signatures or memoization keys. `PhysicalProperties` shape change is field-removal-only, and `physical.fds` already existed.
- **Type safety**: no new `any` introduced; helpers all typed `FunctionalDependency | undefined`.
- **Resource cleanup**: not applicable — pure type-shape and FD-encoding refactor.
- **Cross-platform**: no platform-specific code touched.

### Known gaps (handoff-flagged, deferred)

- `AsofScanNode` does not re-emit a key FD on the wider asof output column space, even though the left-key claim is provable (each left row appears at most once in the output). Conservative — matches prior behavior. Future ticket.
- The aggregate's group-key FD assumes the contiguous `[0..groupCount-1]` group-by output layout. Verified against `buildAttributes()` of all three aggregate node variants — currently holds. Should be revisited if the aggregate output layout ever changes.
- `BestAccessPlanResult.uniqueRows: boolean` was intentionally not touched (out of scope per the original ticket).

## Out of scope

- `RelationType.keys` (logical, schema-side) — unchanged.
- `BestAccessPlanResult.uniqueRows` — separate cleanup if warranted.
