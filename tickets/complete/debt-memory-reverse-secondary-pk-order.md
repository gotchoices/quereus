description: When the in-memory table reads a secondary index backwards, rows sharing one indexed value now come out in reverse primary-key order too, so a backwards read is the exact reverse of a forward read — the documented scan order.
architecture: docs/design-isolation-layer.md
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/test/vtab/scan-layer-descending.spec.ts, docs/memory-table.md, docs/design-isolation-layer.md
----

# Complete: reverse PK order inside an index value on a backwards secondary-index read

## What landed (`ticket(implement): debt-memory-reverse-secondary-pk-order`)

- `scan-layer.ts`, secondary-index branch of `scanLayerResolved`: a `primaryKeysInWalkOrder` generator yields each index entry's primary-key-sorted list forward for an ascending walk and backwards (by index, not `.reverse()`, because `MemoryIndex.getSortedPrimaryKeys` returns its memoized array) when `plan.descending`. Used by both the point-equality and the ordered-walk emission sites; multi-seek recurses through point equality.
- `scan-layer.ts`, multi-range branch: `NOTE:` tripwire that ranges are visited in SQL-text order.
- `docs/memory-table.md`: bullet stating secondary-scan emission order `(indexKey…, pk…)`, fully reversed backwards.
- `docs/design-isolation-layer.md`: paragraph noting the secondary-index merge shadows by primary-key set, so within-value disorder only misplaces staged rows, whereas the primary-key merge depends on order.
- Test in `scan-layer-descending.spec.ts`: backwards read equals the reversed forward read for full walk, range, equality and multi-seek, plus a forward re-read that would expose a mutated memo, and a pinned full backwards order.

## Review findings

- **Correctness — checked, no defect.** Read the diff and surrounding branch. Hand-computed the test fixture (g=10: ids 1,3,6; g=20: 2,4; g=30: 5): forward full walk 1,3,6,2,4,5, backwards 5,4,2,6,3,1, matching the pinned value; the old code would have produced 5,2,4,1,3,6, so the test discriminates. Multi-seek backwards visits keys 20,10 via `orderSeekKeys` then reverses within each value — consistent. The memo is never mutated; a mid-scan write invalidates by `sortedCache.delete` and rebuilds a new array, so the generator's local reference stays valid (same as before the change).
- **Doc claims — verified against code.** `mergedSecondaryIndexQuery` (`packages/quereus-isolation/src/isolated-table.ts`) does skip underlying rows by `modifiedPKs.has(...)` set membership before the order-dependent interleave, so the new design-doc paragraph is accurate. `docs/module-authoring.md` states no secondary-scan order contract, so nothing to update there.
- **Stale references — fixed.** `tickets/plan/feat-reverse-index-walk-for-desc-ordering.md` still described this as an open backlog hazard; rewrote that paragraph to say it landed and to suggest an end-to-end isolation check once backwards secondary reads are reachable from SQL (renamed the following "second hazard" to "remaining hazard"). `tickets/backlog/debt-nothing-checks-advertised-row-order.md` called it "a dormant third"; updated to say it was fixed. `tickets/backlog/bug-memory-index-copies-every-key-for-a-repeated-value.md` mentions the overlap only as design context; left as is.
- **Performance — minor, accepted.** A generator per index entry costs slightly more than iterating an array directly; per-entry overhead on a path already doing a B-tree lookup per primary key. Not worth a tripwire.
- **Tests — kept as is.** The one added test pins the contract this ticket exists for and would fail on the old code; no tests restating implementation were added. Coverage is only via a hand-built `ScanPlan`, because no SQL path issues a backwards secondary read yet (noted in the plan ticket above).
- **Tripwire — already parked by the implementer:** multi-range ranges visited in SQL-text order (`NOTE:` in `scan-layer.ts` multi-range branch). Agreed it is conditional (no multi-range seek advertises an ordering).
- **Hygiene.** `scan-layer.ts` is 335 lines (`wc -l`); comments state why (memo aliasing, merge contract), not what. No type-safety, error-handling or resource-cleanup concerns: no new throws, allocations or handles.
- **No tickets filed.** Nothing major found.

## Validation

- `yarn workspace @quereus/quereus test`: 11110 passing, 26 pending.
- `yarn workspace @quereus/quereus lint`: clean.
