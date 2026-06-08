---
description: Removed withRowContextGenerator — all streaming emitters now use createRowSlot
prereq: None
---

## Summary

Converted all 7 `withRowContextGenerator` call sites to `createRowSlot` (install context entry once, update by cheap field write instead of per-row `Map.set`/`Map.delete`). Deleted `withRowContextGenerator` from `context-helpers.ts`.

## Changed files

- `cte-reference.ts`, `internal-recursive-cte-ref.ts`, `returning.ts`, `update.ts`, `table-valued-function.ts` — Direct `createRowSlot` replacements.
- `window.ts` — Single shared `RowSlot` passed through helper functions.
- `recursive-cte.ts` — Removed dead `withRowContext` wrappers; context managed by downstream cte_ref slots.
- `working-table-iterable.ts` — Simplified to plain row-yielding iterable; context management moved to consumer.
- `context-helpers.ts` — Deleted `withRowContextGenerator`. Updated JSDoc.
- `cte-reference-node.ts` — Fixed attribute ID collision: `buildAttributes()` now always generates fresh IDs.
- `docs/runtime.md` — Removed all `withRowContextGenerator` references.

## Bug fixed

The migration exposed a latent attribute-ID collision between `CTEReferenceNode` and `InternalRecursiveCTERefNode`. Under the old per-row Map reinsertion, the collision was masked. Under `createRowSlot` (install-once), the inner operator's slot permanently shadowed the outer one. Fix: `CTEReferenceNode.buildAttributes()` now unconditionally generates fresh attribute IDs.

## Testing

All 632 tests pass (7 pending). CTE, recursive CTE, and window function test suites provide direct coverage of the converted code paths.
