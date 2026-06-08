---
description: Review of plugin-loader package improvements — DRY, type safety, logging, security, error handling
prereq: review-core-api
---

# Plugin Loader Package Review — Summary

Review and refactoring of `@quereus/plugin-loader`, addressing DRY violations, type safety, logging hygiene, security, and error handling.

## Changes Made

### 1. Eliminated DRY Violation — Manifest Types

`packages/plugin-loader/src/manifest.ts` was a near-complete copy of `packages/quereus/src/vtab/manifest.ts`. Since the core package already exports all these types, the plugin-loader's manifest.ts was replaced with pure re-exports from `@quereus/quereus`. This establishes a single source of truth for `PluginManifest`, `PluginRegistrations`, `PluginRecord`, `PluginSetting`, and all registration info types.

### 2. Fixed `any` Types

- **Core `VTablePluginInfo.module`** was typed `any` — now properly typed as `VirtualTableModule<VirtualTable>`.
- **`extractManifestFromPackageJson`** parameter typed `any` — replaced with a proper `PackageJson` interface.
- **`PluginConfig.config`** typed `Record<string, any>` — narrowed to `Record<string, SqlValue>` matching the runtime contract.
- **`interpolateEnvVars`** parameter typed `any` — replaced with `JsonValue` union type.
- **`validateConfig`** parameter typed `any` — replaced with `unknown` and proper narrowing.

### 3. Replaced `console.log`/`console.warn` with `debug` Library

Added `debug` as a direct dependency. All informational logging now uses `debug('quereus:plugin-loader')` and `debug('quereus:config-loader')` namespaces, consistent with the rest of the project's logging convention. Enabled via `DEBUG=quereus:plugin-loader` or `DEBUG=quereus:*`.

### 4. Security: Removed `http://` from URL Acceptance

`isUrlLike()` previously accepted `http://` URLs, which allows loading untrusted code over insecure connections. Now only `https://` and `file://` are accepted, matching `validatePluginUrl()`.

### 5. Error Handling: `loadPluginsFromConfig` No Longer Swallows Errors

Previously, plugin load failures were silently `console.warn`'d and skipped. Now:
- All failures are collected during the loading loop
- After attempting all plugins, if any failed, an aggregate `Error` is thrown listing all failures
- This prevents silent data loss where an app starts without critical plugins

### 6. Modernized Import Attribute Syntax

Replaced deprecated `{ assert: { type: 'json' } }` with the standard `{ with: { type: 'json' } }` import attribute syntax for JSON module imports (Node 24+).

### 7. Code Quality Improvements

- Decomposed `plugin-loader.ts` into smaller single-purpose functions (`assertValidPluginModule`, `tryLoadManifestFromUrl`, `resolveEnvironment`, `loadFromNodePackage`, `resolveFirstModule`, `tryLoadManifestFromPackage`, `splitSubpath`, `splitVersion`)
- Decomposed `config-loader.ts` similarly (`buildProcessEnv`, `toSqlValue`, `isValidPluginEntry`)
- Removed `eslint-disable` comment that was masking the `any` types

## Files Changed

- `packages/plugin-loader/src/manifest.ts` — Replaced duplicate types with re-exports
- `packages/plugin-loader/src/plugin-loader.ts` — Rewritten with proper types, debug logging, security fix
- `packages/plugin-loader/src/config-loader.ts` — Rewritten with proper types, error propagation, debug logging
- `packages/plugin-loader/package.json` — Added `debug` dependency, `@types/debug` devDependency
- `packages/quereus/src/vtab/manifest.ts` — Properly typed `VTablePluginInfo.module`

## Testing

- All 450 existing tests pass (0 failures)
- Config Loader tests (16 tests) all pass — validates interpolation, config validation
- Sample plugin integration tests (3 tests) all pass — validates end-to-end loading
- Console output is clean — no more stray `console.log` from the loader

## TODO

- [ ] Verify the `loadPluginsFromConfig` error aggregation behavior suits the Quoomb Web and CLI consumers (they may want partial-success semantics)
- [ ] Add unit tests for `validatePluginUrl` edge cases (relative URLs, data: protocol, javascript: protocol)
- [ ] Add unit tests for `parseNpmSpec` covering scoped packages, version ranges, subpaths
- [ ] Add unit tests for `loadPlugin` with mocked `import()` to test Node vs browser paths
- [ ] Consider whether `loadPluginsFromConfig` should support a `continueOnError` option for consumers that want partial loading
- [ ] Review sample plugins for similar `console.log` usage — consider converting to `debug` library
