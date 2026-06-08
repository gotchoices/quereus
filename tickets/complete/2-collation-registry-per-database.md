---
description: Per-database collation registry — complete
prereq: none
---

# Per-Database Collation Registry — Complete

## Summary

Moved collation registration from a module-level global `Map` to a per-`Database` instance `Map`. Each `Database` now owns its own collation registry, initialized with BINARY, NOCASE, and RTRIM. `db.registerCollation()` writes to the instance-local registry only. Collation isolation between databases is fully enforced.

## Key Changes

- **`database.ts`**: `private readonly collations = new Map<string, CollationFunction>()` with `registerCollation()`, `_getCollation()`, and `registerDefaultCollations()` operating on the instance map.
- **`emission-context.ts`**: `resolveCollation(collationName)` method with BINARY fast-path, dependency tracking, and fallback to BINARY for unknown collations.
- **10 emitter files**: All use `ctx.resolveCollation()` instead of the global function.
- **`util/comparison.ts`**: Global `registerCollation`, `getCollation`, `resolveCollation` marked `@deprecated`.

## Testing

- **`collation-isolation.spec.ts`**: 3 tests verifying built-in collation availability, cross-database isolation of custom collations, and cross-database isolation of overridden built-ins.
- Full suite: 684 passing, 0 failing.

## Known Limitation

vtab/memory internals (`primary-key.ts`, `index.ts`) still use the global `resolveCollation` for column definition collations. This is safe for built-in collations (always present in the global Map). Custom collations on vtab column definitions would need vtab infrastructure changes to thread a resolver — out of scope.

## Review Notes

- Architecture is clean: single responsibility, good separation of concerns.
- DRY: consistent `resolveCollation` pattern across `EmissionContext` and global fallback.
- Performance: BINARY fast-path avoids map lookup; collation resolved once at emission time.
- Backward compatibility maintained via deprecated global functions.
