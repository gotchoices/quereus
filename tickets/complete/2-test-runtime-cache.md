description: Unit tests for runtime shared-cache covering threshold, invalidation, and edge-case streaming paths
prereq: none
files:
  - packages/quereus/src/runtime/cache/shared-cache.ts
  - packages/quereus/test/runtime/cache.spec.ts
  - packages/quereus/src/runtime/emit/cache.ts
----

## Summary

21 unit tests for the shared cache module (`runtime/cache/shared-cache.ts`), covering all public functions and key behavioral paths.

## What was built

Shared cache utility providing streaming-first caching with threshold-based abandonment. Used by `runtime/emit/cache.ts` (CacheNode emitter). Exports: `createCacheState`, `streamWithCache`, `clearCache`, `getCacheMetrics`, `withSharedCache`, `createCacheFunction`.

## Test coverage

- **streamWithCache core**: build pass populates cache, cache hit returns identical data, row copy correctness on both build and cache-hit passes, threshold exceeded/boundary, zero/single row edge cases
- **State management**: clearCache resets and allows rebuild, consumeCount tracks cache hits, 5 sequential consumers identical, partial break keeps cache consistent
- **Cache abandoned path**: subsequent consumers stream directly after threshold exceeded
- **Edge cases**: source throws mid-stream (cache not committed, next consumer rebuilds), large rows (100 cols), diverse SqlValue types (string, number, BigInt, boolean, null, Uint8Array)
- **Utilities**: getCacheMetrics reports initial/cached/abandoned states, withSharedCache wraps iterable+state, createCacheFunction caches across calls

## Validation

- 21/21 tests pass
- Build passes
- No lint regressions (test file not in lint tsconfig, pre-existing project-wide issue)

## Usage

```bash
yarn workspace @quereus/quereus test --grep "Runtime Shared Cache"
```
