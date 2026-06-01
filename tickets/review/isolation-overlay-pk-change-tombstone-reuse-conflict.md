description: Review the fix for a PK-changing UPDATE colliding with an overlay tombstone left by an earlier PK change in the same txn. The relocated-row write now overwrites a tombstone at the new PK (operation:'update') instead of inserting onto it. Code + 4 regression tests landed; full workspace suite green.
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## What changed (the diff to review)

`packages/quereus-isolation/src/isolated-table.ts`

- **New helper `writeRelocatedRow(overlay, newPK, overlayRow, tombstoneIndex, effectiveOR)`** (~line 1006–1044).
  Point-looks-up the overlay at `newPK`; if it finds a **tombstone** there, it overwrites
  it with `operation: 'update'` (logical reuse of a PK freed earlier in the same txn);
  otherwise it does `operation: 'insert'`. The tombstone special-case mirrors the existing
  plain-INSERT tombstone conversion (`existingRow[tombstoneIndex] === 1` branch, ~line 649).
- **`existingOverlayRow && pkChanged` branch** (~line 740): the final relocated-row insert was
  replaced by `writeRelocatedRow(...)`.
- **No-existing-overlay-row `pkChanged` branch** (~line 777): PK-change path uses
  `writeRelocatedRow(...)`; the same-PK path keeps the plain `operation: 'insert'`
  (newPK === targetPK, so there is never an overlay row at newPK to reuse).

## Root cause (for context)

The overlay is itself a `StoreTable`. Its INSERT / PK-change paths treat a **tombstone**
row sitting at the target key as a live PK conflict and throw `_overlay_<table> PK`
(`packages/quereus-store/src/common/store-table.ts` ~648, ~757). The isolation layer's
`checkMergedPKConflict` returns `{}` ("no conflict") whenever an overlay row exists at the
new PK — tombstone **or** live — deferring to the overlay to enforce. The two PK-changing
UPDATE branches then did a plain `insert` at the new PK, which collided with a tombstone
that an earlier same-txn PK change had left there. The plain-INSERT path already converted a
tombstone-at-target into an `update`; the PK-change branches never got the same treatment.

## How to validate

Build + run (all green at handoff):

```
yarn workspace @quereus/isolation run build      # tsc, exit 0
yarn workspace @quereus/store    run build       # tsc, exit 0
yarn workspace @quereus/store    run test         # 287 passing
yarn workspace @quereus/isolation run test         # 68 passing
yarn test                                          # full workspace: all passing, 0 failing
```

(Note: `yarn test` runs under Node type-stripping, which does **not** type-check — that's why
the explicit `build`/tsc step is listed separately.)

## Regression tests added (the testing floor — extend, don't trust as ceiling)

`packages/quereus-store/test/isolated-store.spec.ts`, in the
`cross-layer UNIQUE / PK conflict detection` describe block (~line 344+):

- **`PK-changing UPDATE reusing a PK tombstoned earlier in the same txn commits`** — the core
  repro: `UPDATE t SET id=9 WHERE id=1` (frees PK 1) then `UPDATE t SET id=1 WHERE id=2`
  (reuses freed PK 1). Asserts `[[1,'b'],[9,'a']]`.
- **`two-row PK swap via a temporary PK`** — three-step swap through PK 99; asserts names swap
  to `[[1,'b'],[2,'a']]`.
- **`PK-changing UPDATE onto a PK holding a LIVE overlay row still raises a constraint error`**
  — guards that the tombstone special-case does **not** weaken genuine PK-conflict detection:
  an INSERT creates a live overlay row at PK 3, then `UPDATE … SET id=3` must raise a UNIQUE
  constraint error.
- **`PK reuse combined with a freed secondary-UNIQUE value within one txn commits`** — the
  relocated row also claims a UNIQUE value freed in the same txn; exercises the merged-view
  UNIQUE check + trusted-write flush alongside the tombstone-reuse PK write. Asserts
  `[[1,'a'],[9,'tmp']]`.

## Honest gaps / where a reviewer should push

- **`UPDATE OR IGNORE` / `UPDATE OR REPLACE` are not parser-supported** (`updateStatement` has
  no conflict-clause slot), so the statement-level IGNORE/REPLACE behavior of the PK-change
  path cannot be exercised via SQL and is **not** tested. `effectiveOR` passed into
  `writeRelocatedRow` *can* still be non-undefined via column/table-level
  `PRIMARY KEY … ON CONFLICT <action>` defaults — but on the tombstone-overwrite branch the
  target is a tombstone (not a live row), so there is no real conflict for `onConflict` to
  resolve and the `update` proceeds regardless. Worth a reviewer eye: confirm that's the
  intended/desired semantics for a table declared `… ON CONFLICT REPLACE/IGNORE` whose
  PK-change lands on a same-txn tombstone (no SQL-level test covers it).
- **LevelDB-backed `yarn test:store` was not run** (slower path; deferred). The in-memory KV
  provider exercises the overlay→underlying flush, but a reviewer wanting full confidence on
  the store flush path against a real KV backend could run `yarn test:store` out-of-band.
- **Possible redundant point-lookup**: in the `existingOverlayRow && pkChanged` branch,
  `checkMergedPKConflict(overlay, newPK, …)` already does `getOverlayRow(overlay, newPK)`,
  and `writeRelocatedRow` then does it again. Both are O(log n) point lookups so the cost is
  small, but a reviewer might fold the lookup result through to avoid the second probe. Pure
  efficiency, not correctness.
- **No multi-statement / savepoint interaction test** for tombstone reuse straddling a
  savepoint boundary (e.g. free PK 1 before a savepoint, reuse it after, then roll back to
  the savepoint). The overlay savepoint machinery is separate code, but the interaction with
  freed-PK reuse is unverified.

## Status at handoff

Fix implemented and validated; full workspace suite passes with no failures; both edited
packages type-check clean. No new `tickets/.pre-existing-error.md` was needed — no unrelated
failures surfaced.
