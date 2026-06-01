description: A PK-changing UPDATE whose new PK was tombstoned earlier in the same txn collided with the overlay tombstone (_overlay_<table> PK error). Fixed by overwriting the tombstone via operation:'update' instead of insert, mirroring the plain-INSERT tombstone conversion. Code + regression tests written and passing; needs final full-suite validation and review handoff.
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## Status

The fix is **already implemented and locally validated** (the bug was fully diagnosed
in the source fix ticket and the change was small). This implement ticket records the
change for verification and hands off to review.

- `yarn workspace @quereus/store run test` → **287 passing, 0 failing** (4 new regression
  tests included).
- `yarn workspace @quereus/isolation run test` → **68 passing, 0 failing**.
- Both `@quereus/isolation` and `@quereus/store` build clean (`tsc`).

## Root cause (confirmed)

In `IsolatedTable.update()` the two PK-changing-UPDATE branches wrote the relocated row at
the **new** PK via `overlay.update({ operation: 'insert', ... })`. `checkMergedPKConflict`
returns `{}` ("no conflict") when the overlay holds a **tombstone** at the new PK — so the
relocation proceeds — but the subsequent `insert` then collided with that pre-existing
tombstone row, because the overlay is itself a `StoreTable` whose INSERT/PK-change paths
treat a tombstone at the target key as a live PK conflict
(`packages/quereus-store/src/common/store-table.ts` ~648, ~757). The plain-INSERT path
already converted a tombstone at the target PK to `operation: 'update'`; the PK-change
branches never got the same treatment.

## Fix applied

`packages/quereus-isolation/src/isolated-table.ts`:

- Added `writeRelocatedRow(overlay, newPK, overlayRow, tombstoneIndex, effectiveOR)`: if the
  overlay already holds a **tombstone** at `newPK`, overwrite it with `operation: 'update'`
  (logical reuse of a freed PK); otherwise `operation: 'insert'`. A **live** overlay row at
  `newPK` is still rejected upstream by `checkMergedPKConflict` / the existing-overlay-row
  branch, and if one ever reaches the helper it falls through to insert so the overlay
  enforces the genuine conflict — the tombstone special-case does not weaken real PK-conflict
  detection.
- `existingOverlayRow && pkChanged` branch (~line 738): final insert replaced with
  `writeRelocatedRow(...)`.
- No-existing-overlay-row `pkChanged` branch (~line 775): PK-change path uses
  `writeRelocatedRow(...)`; the same-PK path keeps the plain `insert` (newPK === targetPK,
  no overlay row there).

## Regression tests added

`packages/quereus-store/test/isolated-store.spec.ts`, in the
`cross-layer UNIQUE / PK conflict detection` describe block:

- PK-changing UPDATE reusing a PK tombstoned earlier in the same txn → `[[1,'b'],[9,'a']]`.
- Two-row PK swap via a temporary PK → names swapped `[[1,'b'],[2,'a']]`.
- PK-changing UPDATE onto a PK holding a **live** overlay row → raises UNIQUE constraint error.
- PK reuse combined with a freed secondary-UNIQUE value in one txn → commits.

Note: `UPDATE OR IGNORE`/`UPDATE OR REPLACE` statement-level conflict clauses are **not
supported** by the parser (`updateStatement` goes straight to the table name), so the
IGNORE/REPLACE-honoring acceptance variant is not exercisable via an UPDATE statement and
was not added. The live-conflict constraint-error test covers the "tombstone special-case
must not weaken genuine PK-conflict detection" requirement.

## TODO

- Run the full workspace suite (`yarn test`) to confirm nothing else regressed.
- Optionally spot-check `yarn test:store` (LevelDB-backed) since this touches the store flush
  path — not strictly required, the in-memory store provider already exercises the overlay→
  underlying flush.
- Hand off to review.
