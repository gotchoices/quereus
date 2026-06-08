---
description: Review of quoomb-web package — tests, code quality, architecture docs
prereq: all core reviews
---

# Quoomb Web Package Review — Summary

Comprehensive review of `packages/quoomb-web/`: React-based SQL playground for Quereus with Zustand state, Web Workers (Comlink), and Monaco Editor.

## Tests Written

Three test files covering all three Zustand stores (59 tests total, all passing):

- **`src/__tests__/settingsStore.test.ts`** (25 tests) — Theme management, font size clamping (8–32), auto-save delay clamping (500–10000), max history clamping (10–1000), plugin CRUD, storage/sync settings, resetToDefaults
- **`src/__tests__/configStore.test.ts`** (15 tests) — Initial state, setConfig, saveConfig, clearConfig, exportConfig formatting, importConfig validation (rejects non-JSON, non-objects, null; documents array validation gap)
- **`src/__tests__/sessionStore.test.ts`** (19 tests) — Tab lifecycle (create, close, force-close, activate), content/name updates, dirty state tracking, UI state setters, unsaved changes dialog, sync events (status, event prepend, 100-event cap, clear)

## Bugs Found

### 1. `resetToDefaults` Inconsistent Defaults (settingsStore.ts)
`defaultSettings` object has `autoSave: true`, `wordWrap: true`, `defaultPanelSizes: {editor: 50, results: 50}` but `resetToDefaults` hardcodes `autoSave: false`, `wordWrap: false`, `defaultPanelSizes: {editor: 60, results: 40}`.  Should spread `defaultSettings` instead.

### 2. SyncEventsPanel Hook Ordering (SyncEventsPanel.tsx)
Early return at line 20–22 (`if (storageModule !== 'sync') return null`) occurs before `useEffect` at line 25, violating React rules of hooks. Hooks must be called unconditionally before any returns.

### 3. configStore Array Validation Gap (configStore.ts)
`importConfig` validates `typeof config !== 'object' || config === null` but `typeof [] === 'object'`, so array JSON values pass validation and get stored as invalid config.

## DRY Violations

### 1. Duplicate File Save Functions (sessionStore.ts lines 716–794)
`saveCurrentTabAsFile` and `saveTabAsFile` are nearly identical — differ only in how the tab is looked up. Should consolidate into single function taking optional tabId, defaulting to activeTabId.

### 2. Duplicate CSV Formatting (sessionStore.ts + ResultsGrid.tsx)
`exportResultsAsCSV` (sessionStore line 644) and `copyAsCSV` (ResultsGrid line 76) duplicate the same CSV header/row/escape logic. Extract shared `formatRowsAsCSV(rows)` utility.

### 3. Download-as-File Pattern Repeated 3× (sessionStore.ts)
`exportResultsAsCSV`, `exportResultsAsJSON`, and `saveCurrentTabAsFile`/`saveTabAsFile` all repeat the Blob → URL → link → click → cleanup pattern. Extract `downloadBlob(blob, filename)` utility.

## Other Issues

- **Unimplemented TODO**: `handleStop` in EditorPanel.tsx (line 163) — query cancellation not implemented, button exists in UI
- **Fragile coupling**: EnhancedErrorDisplay.tsx uses `(window as any).monaco` and DOM querying (`document.querySelector('[data-uri*="model"]')`) to interact with Monaco editor — brittle and not type-safe
- **Large files**: sessionStore.ts (1267 lines), quereus.worker.ts (1054 lines) — candidates for decomposition

## Architecture Doc Fixes

- Fixed README.md: "PluginStore" → "ConfigStore" in architecture diagram and state management section
- Updated store descriptions to reflect actual responsibilities (configStore handles quoomb.config.json, not plugin CRUD)

## Follow-up Tasks Created

- `tasks/fix/quoomb-web-bugs.md` — Three bugs: resetToDefaults inconsistency, SyncEventsPanel hook ordering, configStore array validation
- `tasks/fix/quoomb-web-dry-refactor.md` — DRY consolidation: file save, CSV formatting, download utility, EnhancedErrorDisplay coupling, large file decomposition

