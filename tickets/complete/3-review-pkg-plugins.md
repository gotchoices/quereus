---
description: Review of plugins package architecture - registration, contracts, and loader
prereq: review-pkg-plugin-loader
---

# Plugins Package Review Summary

## Scope Covered

Reviewed the plugin system architecture across:
- Core plugin interfaces (`src/types/plugin-interface.ts`, `src/vtab/manifest.ts`)
- Registration helper (`src/util/plugin-helper.ts`)
- Database registration methods (`src/core/database.ts`)
- Plugin loader package (`packages/plugin-loader/`)
- Sample plugins (`packages/sample-plugins/`)
- Real plugin packages (`packages/quereus-plugin-*`)
- Plugin documentation (`docs/plugins.md`)

## Changes Made

### 1. DRY: Extracted generic registration helper in `plugin-helper.ts`

Four nearly identical try/catch/wrap-error loops for vtables, functions, collations, and types were replaced with a single generic `registerItems<T>` helper. Each registration is now a single declarative call.

### 2. Consistent error handling for `registerCollation` and `registerType` in `database.ts`

`registerFunction` already used `registerFunctionWithErrorHandling` with proper error logging and wrapping. `registerCollation` and `registerType` did not wrap errors at all. Both now follow the same pattern: try/catch, log via `errorLog`, re-throw `QuereusError` instances, and wrap other errors.

### 3. Simplified `hookModuleEvents` via extracted `tryGetEventEmitter` helper

The method had verbose inline duck-typing with multiple casts. Extracted a standalone `tryGetEventEmitter` function that centralizes the duck-type check and returns a typed `VTableEventEmitter | undefined`, reducing the method to three lines.

### 4. Fixed pre-existing build errors (bonus)

Four TypeScript compilation errors were blocking `yarn build`:
- `database-assertions.ts`: `BlockNode` was imported as `type` but used as a constructor value — changed to value import
- `filter.ts`: Type narrowing through intermediate variable didn't work — inlined `typeof` checks
- `join.ts`: Dead `joinType === 'full'` comparison after earlier guard excluded it — removed dead branch
- `window.ts`: `RuntimeValue` not assignable to `SqlValue` — added explicit cast for aggregate callback result

## Plugin System Assessment

### Architecture Quality: Strong

- Clean interface hierarchy: `PluginRegistrations` → individual `*PluginInfo` types → core schemas
- Good separation between static registration (`registerPlugin`) and dynamic loading (`loadPlugin`/`dynamicLoadModule`)
- `PluginManifest` provides metadata discovery; `PluginRecord` enables persistence
- Plugin loader supports npm specs, URLs, CDN resolution, and environment detection

### Areas That Are Solid

- No `any` types in plugin interfaces (the only `any` is the unavoidable `AnyVirtualTableModule` type alias)
- Error isolation — plugin registration errors are caught and wrapped with context
- All critical types exported from main `@quereus/quereus` entry point
- Re-export pattern in `plugin-loader/src/manifest.ts` avoids type duplication

### Remaining Observations (Not Addressed)

These are design-level observations, not bugs:

- **Sample plugin `any` usage**: `comprehensive-demo` and `json-table` use `tableSchema: any` in vtable implementations. These are sample/demo code and not part of the core system.
- **Storage plugin registration similarity**: All four storage plugins (`indexeddb`, `leveldb`, `nativescript-sqlite`, `react-native-leveldb`) have nearly identical `register()` functions. A shared factory could reduce this, but each plugin is an independent package with slightly different config requirements.
- **No plugin conflict detection**: `registerModule` silently overwrites if a module name is already registered. This is by design (allows overriding built-ins) but could be surprising.
- **Missing `getEventEmitter` on `VirtualTableModule` interface**: The convention of checking for `getEventEmitter` via duck-typing works but isn't formalized in the interface. This is intentional — not all modules need events, and the interface shouldn't force it.

## Test Coverage

Existing tests provide good coverage:
- `plugins.spec.ts`: End-to-end loading and execution of string-functions, custom-collations, and comprehensive-demo sample plugins via `dynamicLoadModule`
- `config.spec.ts`: Config validation, environment variable interpolation, and config structure parsing
- `exports.spec.ts`: Verifies all critical plugin-related types and functions are exported from the main entry point

## Validation

- Full workspace build: passes (`yarn build` — all packages)
- Full test suite: 809+ tests passing across all packages (quereus: 450, sync-coordinator: 44, store: 134, etc.)
