description: A PK-changing UPDATE that relocated a row onto a PK freed earlier in the same txn collided with the overlay tombstone left there (`_overlay_<table> PK`). Fixed by `writeRelocatedRow`, which overwrites a tombstone-at-newPK via `operation:'update'` instead of inserting onto it. Reviewed: fix is correct and well-covered; one extra regression test added inline; no major findings.
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## Summary

The isolation overlay is itself a `StoreTable`; its INSERT path treats a **tombstone**
row sitting at the target key as a live PK conflict and throws `_overlay_<table> PK`.
`checkMergedPKConflict` returns `{}` ("no conflict") whenever *any* overlay row exists at
the new PK (tombstone **or** live), deferring enforcement to the overlay. The two
PK-changing UPDATE branches then did a plain `operation:'insert'` at the new PK, which
collided with a tombstone left there by an earlier same-txn PK change (or DELETE).

The plain-INSERT path already converted a tombstone-at-target into an `update`; the
PK-change branches never got the same treatment. The fix extracts a `writeRelocatedRow`
helper that point-looks-up the overlay at `newPK`: a **tombstone** there is overwritten
via `operation:'update'` (logical reuse of the freed PK); anything else falls through to
`operation:'insert'` so a genuine live-row conflict is still raised by the overlay.

Both PK-change branches now call the helper; the same-PK path (newPK === targetPK, no
overlay row to reuse) keeps the plain insert.

## Review findings

### Diff reviewed
`packages/quereus-isolation/src/isolated-table.ts` (new `writeRelocatedRow` helper + the
two PK-change branches in `update`) and the regression tests in
`packages/quereus-store/test/isolated-store.spec.ts`. Read with fresh eyes against the
surrounding `update`/`checkMergedPKConflict`/`checkMergedUniqueConstraints`/`getOverlayRow`
machinery before reading the handoff.

### Correctness — verified, no issues
- **Tombstone reuse is sound.** `writeRelocatedRow` keys off `existingAtNewPK[tombstoneIndex] === 1`
  and overwrites with a *same-PK* overlay update (`oldKeyValues === newPK`, overlayRow's PK
  === newPK), so no overlay-level PK conflict is possible and `onConflict` is correctly moot
  on that branch.
- **Both branches are exercised.** Traced every added test by hand. The core repro and the
  secondary-UNIQUE test hit the `!existingOverlayRow` branch (line ~778); the **two-row swap**
  hits the `existingOverlayRow` branch (line ~740) on its third step (target PK 99 has a live
  overlay row, dest PK 2 holds a tombstone). Coverage of the new helper is genuine on both
  call sites, not just one.
- **Genuine conflicts still raise.** A live overlay row at newPK → `checkMergedPKConflict`
  returns `{}` → helper sees non-tombstone → `insert` → overlay throws UNIQUE. Tested
  (`…onto a PK holding a LIVE overlay row still raises a constraint error`).
- **IGNORE semantics not wrongly applied.** On the tombstone branch the helper does an
  `update`, never a conflicting insert, so a table declared `… ON CONFLICT IGNORE` does NOT
  silently drop a legitimate freed-PK reuse — which a plain insert-with-IGNORE could have.
  This is the *correct* behavior, confirming the handoff's open question.
- **No ordering regression.** The pre-fix code already did `insertTombstoneForPK(targetPK)`
  then a throwing `insert`; the fix preserves that exact mutation-then-throw ordering, so the
  live-conflict path introduces no new partial-overlay-state behavior. (The overlay
  participates in the engine's savepoint/rollback machinery — `isolation-layer.spec.ts`
  rollback-to-savepoint tests — so ABORT cleanup is the engine's pre-existing concern, not
  this diff's.)
- **Type safety / DRY / SPP.** Helper is small and single-purpose, mirrors the existing
  tombstone-conversion branch, no `any`, imports (`UpdateResult`, `ConflictResolution`)
  already present. Clean.

### Tests
- Implementer's 4 tests cover the core repro, two-row swap, live-row conflict, and PK+UNIQUE
  co-reuse — a solid floor.
- **Added inline:** `PK-changing UPDATE reusing a PK freed by a DELETE earlier in the same
  txn commits` — the reusable tombstone can also originate from an explicit `DELETE`, a
  distinct user-facing scenario flowing through the identical `writeRelocatedRow` tombstone
  branch. Closes a documented coverage gap (tombstone origin independence).
- Store suite now **288 passing** (was 287); isolation **68 passing**. Both packages
  `tsc`-clean.

### Minor (noted, not changed)
- **Redundant point-lookup** (handoff-flagged): `checkMergedPKConflict` does
  `getOverlayRow(newPK)` and `writeRelocatedRow` does it again. Both are O(log n) on a
  small overlay and on the cold PK-change path. Folding the row through would require
  widening `checkMergedPKConflict`'s discriminated-union return (used by 3 call sites, only
  one of which needs it) for negligible gain — judged not worth the added API surface.

### Coverage gaps left open (none warrant a ticket)
- **UPDATE OR IGNORE / OR REPLACE** is not parser-supported (`updateStatement` has no
  conflict-clause slot), so statement-level IGNORE/REPLACE on the PK-change path is
  unreachable via SQL and untestable. Not actionable until the parser grows the slot.
- **Savepoint-straddling reuse** (free a PK before a savepoint, reuse after, roll back) is
  unverified, but the fix adds no savepoint-specific state and the overlay's savepoint
  behavior is separately tested — low risk.
- **LevelDB-backed `yarn test:store`** not run (slow path; in-memory KV exercises the
  overlay→underlying flush). Out-of-band confidence check only.

### Docs
`packages/quereus-isolation/README.md` describes overlays/tombstones at the conceptual level
(tombstones = deleted/freed rows). The fix makes the implementation *match* that model rather
than diverging from it; no contradiction introduced. Detailed semantics live in the
`writeRelocatedRow` JSDoc. No README change needed.

### Lint
The `eslint` script exists only for `packages/quereus`; this diff touches
`quereus-isolation` and `quereus-store` (no lint script). N/A.

## Validation at completion

```
yarn workspace @quereus/isolation run build   # tsc, exit 0
yarn workspace @quereus/store    run build     # tsc, exit 0
yarn workspace @quereus/isolation run test     # 68 passing
yarn workspace @quereus/store    run test       # 288 passing (added 1 regression test)
```

No `tickets/.pre-existing-error.md` needed — no unrelated failures surfaced. The "boom" /
"THIS IS NOT VALID SQL" lines in store test output are intentional negative-path fixtures
(`events.spec.ts`, DDL-rehydrate), not failures.
