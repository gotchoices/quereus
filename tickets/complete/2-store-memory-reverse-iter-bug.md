---
description: Fix InMemoryKVStore.iterate() reverse iteration with bounds returning empty results
files: packages/quereus-store/src/common/memory-store.ts, packages/quereus-store/test/memory-store.spec.ts
---

# InMemoryKVStore Reverse Iteration Bug — Complete

## Problem
`InMemoryKVStore.iterate()` returned zero results when called with `reverse: true` and bounds (`gte`/`lte`/`gt`/`lt`). The upper-bound `break` logic fired immediately on the first entry in reversed order (the highest key), terminating the loop before yielding any results.

## Fix
Added a `reverse` branch in the bound-check logic within `iterate()` (`memory-store.ts:84-96`):
- **Forward (ascending):** lower bounds `continue`, upper bounds `break`.
- **Reverse (descending):** upper bounds `continue` (skip entries above range), lower bounds `break` (stop once past lower end).

## Tests
- `'supports reverse with bounds'` — reverse with inclusive `gte + lte`
- `'supports reverse with exclusive bounds (gt + lt)'` — reverse with exclusive `gt + lt`
- `'supports reverse with limit'` — reverse with `limit`
- All 136 tests in `@quereus/store` pass.
