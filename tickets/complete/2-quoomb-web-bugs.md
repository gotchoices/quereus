description: Fix three bugs in quoomb-web stores and components
prereq: none
files:
  - packages/quoomb-web/src/stores/settingsStore.ts
  - packages/quoomb-web/src/components/SyncEventsPanel.tsx
  - packages/quoomb-web/src/stores/configStore.ts
  - packages/quoomb-web/src/__tests__/configStore.test.ts
  - packages/quoomb-web/src/__tests__/settingsStore.test.ts
----

# Quoomb Web Bug Fixes — Complete

Three bugs fixed in `packages/quoomb-web/`.

## Bug 1: `resetToDefaults` Single Source of Truth

`settingsStore.ts` — `resetToDefaults` now spreads `defaultSettings` instead of hardcoding divergent values. `autoSave`, `wordWrap`, and `defaultPanelSizes` all correctly reset to their declared defaults.

## Bug 2: SyncEventsPanel Hook Ordering

`SyncEventsPanel.tsx` — `useEffect` moved above the conditional `return null`, so all hooks execute unconditionally per React's rules of hooks.

## Bug 3: configStore Array Rejection

`configStore.ts` — `importConfig` validation now includes `Array.isArray(config)` to reject JSON arrays as config.

## Testing

- `settingsStore.test.ts`: `resetToDefaults` test mutates `autoSave`, `wordWrap`, and `panelSizes` then asserts they reset correctly (review strengthened).
- `configStore.test.ts`: `importConfig('[]')` asserts rejection with `'Config must be a JSON object'`.
- Build passes, 59/59 tests pass across 3 test files.
