----
description: Review DRY hoist of maxHLC helper into @quereus/sync clock layer
files:
  - packages/quereus-sync/src/clock/hlc.ts
  - packages/quereus-sync/src/index.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync-client/src/sync-client.ts
----

## Summary

Hoisted the duplicated `maxHLCFromChangeSets` helper into a shared `maxHLC(hlcs: Iterable<HLC>): HLC | undefined` exported from `@quereus/sync`'s clock layer. Both call packages now import and use the shared function.

## Changes made

**`packages/quereus-sync/src/clock/hlc.ts`**
- Added `maxHLC(hlcs: Iterable<HLC>): HLC | undefined` after `hlcEquals` (pure HLC utility, no ChangeSet dependency).

**`packages/quereus-sync/src/index.ts`**
- Added `maxHLC` to the explicit named re-export list from `'./clock/index.js'` (the file uses named exports, not `export *`, so the new symbol had to be listed explicitly).

**`packages/quereus-sync/src/sync/change-applicator.ts`**
- Removed local `maxHLCFromChangeSets` helper.
- Added `maxHLC` to the import from `'../clock/hlc.js'`.
- Updated call site: `watermarkHLC: maxHLC(changes.map(cs => cs.hlc))`.
- Dropped the now-unused `type HLC` import.

**`packages/quereus-sync-client/src/sync-client.ts`**
- Removed local `maxHLCFromChangeSets` helper.
- Added `maxHLC` to the import from `'@quereus/sync'`; removed the now-unused `compareHLC` and `type ChangeSet` from that import.
- Updated all 3 call sites:
  - `handleChanges`: `maxHLCFromChangeSets(changeSets)` → `maxHLC(changeSets.map(cs => cs.hlc))` (renamed local variable `maxHLC` → `maxHlc` to avoid shadowing the import)
  - `pushLocalChanges`: `maxHLCFromChangeSets(changes) ?? null` → `maxHLC(changes.map(cs => cs.hlc)) ?? null`

## Validation

- `yarn workspace @quereus/sync build` — clean.
- `yarn build` — clean across all packages.
- `yarn test` — 34 (core) + 121 (sync integration) tests passing.

## Known gaps / review focus

- The new function signature uses `Iterable<HLC>` while callers always pass `Array<HLC>` from `.map()`. This is intentionally more general than needed but costs nothing and matches the ticket's spec. Reviewer should confirm this broadness is desirable or trim to `HLC[]` if simplicity is preferred.
- `src/index.ts` has a mixed export style (explicit named list rather than `export *`) — adding to that list is the right approach, but the reviewer may want to note this pattern for future contributors.
