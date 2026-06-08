---
description: Generalize createRowSlot pattern to Filter, Project, and Distinct emitters
prereq: None
---

## Summary

Converted all high-frequency streaming emitters from per-row `Map.set`/`Map.delete` helpers to the `createRowSlot` pattern, eliminating 2×N unnecessary Map mutations per query.

### Changes

- **filter.ts** — Single `createRowSlot` for source descriptor with try/finally cleanup.
- **project.ts** — Two `createRowSlot` calls: output slot created first (older), source slot created second (wins in newest→oldest resolution). Ordering rationale documented in comments.
- **distinct.ts** — Single `createRowSlot` for output descriptor.
- **array-index.ts** — Searches context newest→oldest (matching `resolveAttribute`), preventing stale-slot shadowing.
- **join.ts** — Sets right slot to null-padding before yielding unmatched LEFT JOIN rows, preventing stale right-side data downstream.
- **context-helpers.ts** — JSDoc on `withRowContext`/`withAsyncRowContext` recommends `createRowSlot` for streaming.
- **docs/runtime.md** — Key Emitter Patterns section lists `createRowSlot` as preferred for all streaming emitters.

### Review Notes

- All streaming emitters (scan, join, filter, project, distinct) now consistently use `createRowSlot`.
- All have proper try/finally with `close()`.
- `withAsyncRowContext` remains appropriate in sort.ts, constraint-check.ts, and dml-executor.ts (one-off or materializing contexts).
- Build clean. Tests: 667 passing, 7 pending, 0 failing.
