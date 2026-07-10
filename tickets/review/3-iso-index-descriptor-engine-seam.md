---
description: Review the new typed record of the query planner's chosen index — a structured descriptor now travels alongside the old text string, and three modules stopped re-parsing that string by hand.
files:
  - packages/quereus/src/vtab/index-descriptor.ts         # NEW — IndexDescriptor/AccessPath/resolveIndexDescriptor/validateIndexDescriptor
  - packages/quereus/src/vtab/idx-str.ts                  # NEW — encode/decode/retarget/idxStrSentinel/planKind<->code
  - packages/quereus/src/vtab/filter-info.ts              # accessPath field + shared builders (moved from isolation)
  - packages/quereus/src/vtab/best-access-plan.ts         # indexDescriptor field + setter + validation
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # populate accessPath, emit idxStr via encodeIdxStr
  - packages/quereus/src/planner/stats/analyze.ts         # uses makeFullScanFilterInfo
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts   # private parser -> decodeIdxStr
  - packages/quereus-store/src/common/store-table.ts      # resolveIndexFromIdxStr -> decodeIdxStr
  - packages/quereus-isolation/src/filter-info.ts         # now thin wrappers over engine builders
  - packages/quereus/src/index.ts                         # exports
  - packages/quereus/test/vtab/idx-str.spec.ts            # NEW
  - packages/quereus/test/vtab/index-descriptor.spec.ts   # NEW
  - packages/quereus/test/vtab/access-path.spec.ts        # NEW
  - packages/quereus/test/vtab/test-aliased-index-module.ts # NEW test module (aliases PK name)
  - docs/module-authoring.md, docs/optimizer.md           # documented the seam
difficulty: hard
---

## What this ticket did

When Quereus plans a table read, `rule-select-access-path` picks an index and records that
choice only as a free-text `FilterInfo.idxStr` (e.g. `idx=by_name(0);plan=2`). Three modules
re-parsed that string with their own splitters, and nothing typed or validated it. The
isolation overlay in particular parses `idxStr` to decide the sort order it merges in — and
its fallback (any unrecognised index name → merge by primary key) is a *wrong-answer* path,
not a slow one, when a module aliases the PK index name (`_primary_1`, `_primary_a`).

This ticket adds a typed record of the chosen index that rides alongside `idxStr`, and makes
`idxStr` a projection of that record instead of an independent template literal at each site:

- **`index-descriptor.ts`** — `IndexDescriptor` (name, `role: primary|secondary`, full
  `keyColumns`, `unique`), `AccessPath` (`fullScan | empty | index | unresolvedIndex`),
  `primaryKeyDescriptor`, `resolveIndexDescriptor` (supplied descriptor > `_primary_` >
  schema lookup > undefined), `validateIndexDescriptor`.
- **`idx-str.ts`** — one `encodeIdxStr` / `decodeIdxStr` replacing three hand-rolled
  splitters, plus `retargetIdxStr`, `idxStrSentinel`, `planKindFromCode` / `planCodeFromKind`.
- **`BestAccessPlanResult.indexDescriptor`** (optional) + `AccessPlanBuilder.setIndexDescriptor`
  + `validateAccessPlan` checks (name must equal the plan's index name; non-empty in-range
  key columns).
- **`FilterInfo.accessPath`** (optional) + shared builders `makeFullScanFilterInfo` /
  `makeEmptyFilterInfo` / `makeIndexEqSeekFilterInfo` / `retargetFilterInfoIndex`. The
  first two duplicated builders in `quereus-isolation` now delegate to these.
- Every `idxStr` template literal in `rule-select-access-path` (both
  `selectPhysicalNodeFromPlan` and `selectPhysicalNodeLegacy`, seq-scan arms, empty node)
  now goes through `encodeIdxStr` and sets `accessPath`; an unresolvable index name logs at
  warn level and records `{ kind: 'unresolvedIndex' }`.
- `scan-plan.ts` and `store-table.ts` swapped their private parsers for `decodeIdxStr`
  (byte-identical behaviour, incl. the `null ⇒ primary/plan 0` degenerate case).

## How to validate

- `yarn build` — clean.
- `yarn test` — full workspace suite green (**6867 + 901 + others passing, 0 failing**).
  Store logic-vs-LevelDB (`yarn test:store`) was **not** run — see gaps.
- `yarn lint` — clean (real eslint + `tsc -p tsconfig.test.json` on `@quereus/quereus`).

New tests, and what each pins:
- `test/vtab/idx-str.spec.ts` — round-trips all seven planner-emitted shapes byte-for-byte;
  `rangeOps=ge:lt,gt` (value containing `:` and `,`); first-`=`-only split; parameter-order
  preservation; sentinel + garbage → null; `retargetIdxStr` preserves nameArg/unknown
  plan/unknown params; plan-code bijection; `plan=1`/`plan=4` → undefined.
- `test/vtab/index-descriptor.spec.ts` — `resolveIndexDescriptor` precedence; `_primary_extra`
  resolves as **secondary** (no prefix rule); PK-less table → `primaryKeyDescriptor` undefined;
  `validateAccessPlan` throws FORMAT on descriptor/indexName mismatch, empty keyColumns,
  out-of-range column, no-index-named.
- `test/vtab/access-path.spec.ts` + `test-aliased-index-module.ts` — end-to-end that the
  planner populates `accessPath`: PK/secondary eqSeek carry FULL keyColumns; range→rangeSeek;
  IN→multiSeek; prefix-range→prefixRangeSeek; a PK-aliasing module **without** a descriptor
  plans `unresolvedIndex` (and `idxStr` still carries the alias), **with** one resolves to a
  primary walk; unfiltered scan on a no-ordering module → `fullScan`; literal-NULL PK
  equality → `empty`.

Existing regression nets that assert exact `idxStr` text still pass unchanged:
`scan-plan-bounds.spec.ts`, `memory-vtable.spec.ts`, `in-multiseek-incount.spec.ts`.

## Known gaps / where to look hard (treat tests as a floor)

- **`test:store` not run.** The store's `resolveIndexFromIdxStr` refactor is covered only by
  the memory-backed `quereus-store` package unit tests in the default suite, not by the
  slower LevelDB logic path (`yarn test:store`). The change is intended byte-identical, but a
  reviewer with time should run `yarn test:store` — the store secondary-index scan arm
  (`analyzeIndexAccess`) is the one live secondary-index `idxStr` consumer.
- **Isolation `parseIndexFromFilterInfo` / `adaptFilterInfoForOverlay` were left as-is.** The
  ticket scoped the parser de-dup to `scan-plan.ts` and `store-table.ts`; the isolation
  overlay's *third* hand-rolled parser and its two PK-alias regexes (`PK_INDEX_NAME_RE`,
  `SUFFIXED_PK_IDXSTR_RE`) still exist. This ticket makes the correct fix *possible* (the
  overlay can now read `accessPath` / call `retargetFilterInfoIndex`) but does not perform
  it — that is the downstream ticket `iso-index-descriptor-isolation-consumer` (3.1). So the
  `_primary_a` corruption described in the original ticket is **not fixed here**; it is
  unblocked here. Confirm 3.1 actually consumes the seam.
- **`retargetFilterInfoIndex` has no direct unit test** and no in-tree caller yet (exported
  for 3.1 and for the deferred EXPLAIN-usable-index bug). Its `accessPath` rewrite logic
  (index vs unresolvedIndex arms) is only exercised transitively. Worth a direct test when a
  caller lands.
- **`indexInfoOutput.idxStr` staleness is deliberately untouched.** Seek arms still leave the
  spread `indexInfoOutput.idxStr` at `'fullscan'` (wrong `usableIndex` in EXPLAIN). Filed
  separately; `retargetFilterInfoIndex` already rewrites that field so it stays correct once
  fixed. Not a regression from this ticket.
- **`IndexPlanKind` does not model scan direction** by design — `plan=1`/`plan=4` and
  `ordCons=DESC` are decoded/round-tripped but no producer in-repo emits them. If a module
  ever needs descending as structured data, that is new work, not a bug here.

## Tripwires parked (index, not analysis)

- `idx-str.ts` `decodeIdxStr` allocates a fresh `Map` per call with parameters; shares a
  frozen empty map otherwise. NOTE-worthy only if idxStr decoding shows up hot — currently
  per-plan, not per-row. Left as a code-level observation, not filed.
- `resolveIndexDescriptor` does a linear `tableSchema.indexes.find` per plan. Fine at plan
  time; if a table ever carries many indexes and planning is hot, index by name. No comment
  added — plan-time cost, not a live concern.
