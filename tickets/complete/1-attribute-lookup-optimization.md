---
description: Optimized resolveAttribute from O(n) linear scan to O(1) direct lookup via RowContextMap attribute index
prereq: None
---

## Summary

`resolveAttribute()` — the hottest path in query execution (called per column reference per row) — was optimized from O(n) linear scan with per-call allocation to O(1) array-indexed lookup with zero allocation on the hot path.

## What Changed

- **New `RowContextMap` class** (`src/runtime/context-helpers.ts`) — wraps `Map<RowDescriptor, RowGetter>` with a secondary `attributeIndex: Array<IndexEntry | undefined>` maintained automatically on `set()`/`delete()`.
- **`resolveAttribute()`** — fast path does a single array index lookup; fallback linear scan for edge cases (slot created but not yet populated).
- **`RuntimeContext.context`** type changed from `Map` to `RowContextMap`.
- **5 construction sites** updated to `new RowContextMap()`.

## Review Notes

- API surface is clean: all existing callers (`set`, `delete`, `get`, `entries`, `size`) work unchanged. `attributeIndex` is only read by `resolveAttribute()` in the same module.
- `descriptorEntries()` correctly handles both array and spread-created plain-object descriptors via `for...in`.
- Delete-rebuild strategy correctly iterates all remaining entries so newest (last in insertion order) wins.
- `RowContextMap` is correctly internal — not re-exported from the public package API.
- Documentation updated: `runtime.md` (type signature and resolveAttribute description) and `optimizer-const.md` (code example).
- All 639 spec tests + 54 sqllogic test files pass. One pre-existing failure in `quereus-isolation` package is unrelated.
- Build compiles cleanly with TS 5.9.3.
