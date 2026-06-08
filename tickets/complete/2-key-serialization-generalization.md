----
description: Shared key serialization utility and window collation bug fixes — reviewed and complete
----

## Summary

Extracted bloom join's key serialization into a shared utility (`util/key-serializer.ts`) and fixed two window function bugs where collation-unaware serialization caused incorrect partitioning and ranking.

## What Changed

### `packages/quereus/src/util/key-serializer.ts` (new)
Shared key serialization with type-tagged, collation-aware string keys:
- `resolveKeyNormalizer(collationName)` — BINARY/NOCASE/RTRIM normalizers
- `serializeKey(values, normalizers)` — returns null on NULL (equi-join semantics)
- `serializeKeyNullGrouping(values, normalizers)` — NULL sentinel for PARTITION BY / ranking
- `serializeRowKey(row, indices, normalizers)` — row-indexed variant for bloom join

### `runtime/emit/bloom-join.ts` (refactored)
Replaced local serialization with shared imports. Functionally identical.

### `runtime/emit/window.ts` (bug fixes)
- **Bug 1**: `groupByPartitions` used `JSON.stringify` — now uses `serializeKeyNullGrouping` with per-column collation normalizers.
- **Bug 2**: `getOrderByKey` used `String(val).join('|')` — now uses `serializeKeyNullGrouping` with order-by collation normalizers.
- Pre-resolved `partitionKeyNormalizers` and `orderByKeyNormalizers` at emit time.

### Docs updated
- `docs/window-functions.md` — added collation-aware partitioning note and new test categories.

## Testing

- New tests in `packages/quereus/test/logic/07.5-window.sqllogic`: NOCASE PARTITION BY, NOCASE ORDER BY ranking, NULL PARTITION BY grouping
- All bloom join tests pass (refactor-only, no behavior change)
- Full suite: 668 quereus tests, 86 sync tests, all packages green
- TypeScript type-check and build pass

## Review Notes

- Code is DRY — single serialization implementation shared across bloom join and window functions
- Type tags (`s:`, `n:`, `b:`, `x:`, `o:`, `N:`) prevent cross-type key collisions
- `\0` separator prevents multi-column key collisions
- `IDENTITY_NORMALIZER` constant avoids per-call allocations for BINARY collation
- `database-transaction.ts` `serializeKeyTuple` correctly left as-is (PK change tracking uses exact-value equality, not SQL collated equality)
