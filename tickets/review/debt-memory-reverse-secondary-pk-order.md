description: When the in-memory table reads a secondary index backwards, rows sharing one indexed value now come out in reverse primary-key order too, so a backwards read is the exact reverse of a forward read — the documented scan order.
architecture: docs/design-isolation-layer.md
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/test/vtab/scan-layer-descending.spec.ts, docs/memory-table.md, docs/design-isolation-layer.md
----

# Review: reverse PK order inside an index value on a backwards secondary-index read

## What changed

- `scan-layer.ts`, secondary branch of `scanLayerResolved`: the `sortedPrimaryKeys` closure is replaced by a generator `primaryKeysInWalkOrder` that yields the memoized PK-sorted list forward for an ascending walk and by reverse index iteration when `plan.descending` (never `.reverse()` — `getSortedPrimaryKeys` returns its cached array). Both emission sites (point equality and ordered walk) use it; multi-seek recurses through point equality, so it is covered. The comment block above it now states the `(indexKey…, pk…)` contract (fully reversed backwards) without claiming a correctness dependency.
- `scan-layer.ts`, multi-range branch: `NOTE:` tripwire — ranges are visited in SQL-text order; sort them by leading bound (reversed backwards) if a multi-range seek ever advertises an ordering or a backwards walk reaches it.
- `docs/memory-table.md`: new bullet before "Multi-seek key order is sorted" stating the secondary-scan emission order.
- `docs/design-isolation-layer.md` § "Which index is being scanned": one paragraph noting the secondary merge shadows by PK set (within-value disorder only misplaces staged rows inside that value), whereas the PK merge (`mergeStreams`) depends on order.

## Test added

- `scan-layer-descending.spec.ts` › secondary index › "backwards walk is the exact reverse of the forward walk, PK order within a value included": table `sg` with three rows at g=10, two at 20, one at 30; for full walk, range `[10,30)`, `equalityKey: 10`, `equalityKeys: [20, 10]`, asserts backwards ids == forward ids reversed, re-reads forward afterwards (catches a mutated memo), and pins the full backwards walk as `[5,4,2,6,3,1]`. Not run against the pre-change code in this session; by construction the old code yields `[5,2,4,1,3,6]` for the full walk.

## Validation

- `yarn workspace @quereus/quereus test`: 11110 passing, 26 pending.
- `yarn workspace @quereus/quereus lint`: clean.
- `yarn workspace @quereus/isolation test`: 451 passing (note: may resolve `@quereus/quereus` via built `dist`, which was not rebuilt; the change is not observable through isolation anyway, per the plan's impact analysis).

## Known gaps

- Backwards secondary reads remain unreachable from SQL until `feat-reverse-index-walk-for-desc-ordering`; coverage is only the direct `ScanPlan` test.
- No-`secondaryIndex` inline-sort fallback is covered by inspection only (same generator path).
