description: Fix the isolation merged-view UNIQUE false-positive on an in-txn cross-row value swap. Statement-time merged-view UNIQUE check evaluates the overlay (merged) row instead of the stale committed value; commit-time overlay→underlying flush applies the validated final state as "trusted writes" that skip the underlying's per-write PK/UNIQUE re-enforcement.
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus/src/vtab/table.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/design-isolation-layer.md
----

## What landed

### Part 1 — statement-time merged-view check (`isolated-table.ts` `findMergedUniqueConflict`)
When a non-tombstone overlay entry supersedes the scanned committed row, the UNIQUE
columns, the collation comparison, AND the partial-UNIQUE predicate are evaluated against
the merged (overlay) row (`overlayRow.slice(0, tombstoneIndex)`), not the stale underlying
value. The returned conflict row is the merged row. This both removes false positives (a
row moved *off* a value earlier in the txn no longer conflicts) and adds correct detection
(a row moved *onto* a value now does conflict).

### Part 2 — commit-time trusted-write flush
- `UpdateArgs.trustedWrite?: boolean` added (`packages/quereus/src/vtab/table.ts`): "caller
  already validated all PK/UNIQUE for the final committed state; skip re-checks and persist."
  Inert for modules that ignore it.
- `store-table.ts` `update()` honors it at 4 guard sites: INSERT pk-existence + UNIQUE check,
  UPDATE pkChanged-conflict + UNIQUE check. A trusted INSERT that hits an existing PK throws
  `QuereusError(INTERNAL)` (flush routes existing PKs to update, so this is an invariant
  violation). Secondary-index maintenance and the single insert/update CDC event are preserved.
- `flushOverlayToUnderlying` passes `trustedWrite: true` (+ `preCoerced: true`) on insert/update
  flushes. Deletes (tombstones) and `assertFlushWriteOk` unchanged.

Why safe: index keys are suffixed with the PK (`{index_cols}{pk}`), so a transient duplicate
UNIQUE value during a swap produces distinct physical index keys — incremental per-write
secondary-index maintenance stays consistent; the merged-view pre-check is the sole authority
for the final logical state.

## Review findings

### Validation (all re-run this pass, full green)
- `yarn build` — **exit 0** (all packages).
- `yarn workspace @quereus/store test` — **283 passing, 0 failing** (incl. the new value-swap
  and partial-UNIQUE regression tests; the partial test's `CREATE UNIQUE INDEX ... WHERE` DDL
  fix is confirmed green — the implement-stage "could not reconfirm" caveat is resolved).
- `yarn workspace @quereus/quereus run lint` — **exit 0**.
- `yarn test` (all workspaces) — quereus core **4124 passing**, store **283**, every other
  workspace green, **0 failing** anywhere. (The `boom` / `THIS IS NOT VALID SQL` /
  `failingKv.iterate` lines in output are intentional negative-path test fixtures, not failures.)

### Correctness — verified
- **Part 1 merged-row logic**: `overlayRow.slice(0, tombstoneIndex)` strips the appended
  tombstone column correctly (tombstoneIndex = schema column count); tombstoned overlay rows
  are skipped before this. Both swap directions handled. Genuine underlying-only conflicts
  (no overlay entry) still use the underlying row and are still rejected — confirmed by the
  pre-existing `detects … UNIQUE/PK conflict` tests in the same describe block.
- **Part 2 trusted flush**: secondary-index delete-old/add-new maintenance and the single
  `update` (not delete+insert) CDC event survive the guards; `evicted` is always empty on a
  trusted write (evictions were resolved at statement time via overlay tombstones), so
  `evictedRows` is correctly undefined. The `pkChanged && !trustedWrite` guard is defensive
  (flush never changes a PK). `QuereusError`/`StatusCode` already imported in store-table.ts.
- **Transient-duplicate safety**: confirmed via `buildIndexKey` — index keys include the PK,
  so no physical index collision during a swap.

### Type safety / DRY / style
- Minor: `mergedRow` uses `as Row` cast where the parallel slice at line ~1209 does not — left
  as-is (both are correct; not worth churn). The `overlayRow.slice(0, tombstoneIndex)` pattern
  recurs in three sites but each context differs slightly; acceptable.

### Tests — fixed inline (minor)
- The two new regression tests were placed **above** the describe block's `beforeEach`/`afterEach`
  hooks and `let isolatedModule`. Mocha hooks apply regardless of declaration order so they
  passed, but this is unconventional and misleading. **Moved them below the hooks** to match
  every other describe block; store suite re-run still **283 passing**.

### Docs — fixed inline (minor)
- `docs/design-isolation-layer.md` was stale. Updated two sections: (1) the Commit flow now
  documents `trustedWrite` (why the underlying skips per-write re-checks, that the merged-view
  pre-checks are the sole authority, and the PK-suffixed-index safety argument); (2) the non-PK
  UNIQUE conflict section now documents merged-row evaluation of constrained columns and the
  partial predicate. `docs/module-authoring.md` uses `UpdateArgs` only illustratively (it does
  not enumerate fields — `preCoerced` is absent too), so the JSDoc on `UpdateArgs.trustedWrite`
  plus the design doc is the correct home; left unchanged.

### Major finding — new ticket filed
- **PK reuse / swap within one transaction is broken** (pre-existing, distinct from this fix).
  A PK-changing UPDATE onto a PK that was freed (tombstoned) earlier in the same txn throws a
  spurious `_overlay_<table> PK` conflict. Root cause: the PK-change-UPDATE branches in
  `isolated-table.ts` (~lines 738 and 775) write the relocated row at `newPK` via
  `operation: 'insert'`, which collides with the pre-existing overlay tombstone — whereas the
  plain-INSERT path (~lines 649–659) already converts a tombstone via `operation: 'update'`.
  Confirmed with a minimal repro (move a row onto a freed PK) and a full two-PK swap; both fail
  today. The handoff flagged this as "PK-swap not covered / verify or file a follow-up" — now
  verified as a genuine bug. Filed `tickets/fix/isolation-overlay-pk-change-tombstone-reuse-conflict.md`.

### Documented trade-off (accepted, not a defect)
- Trusted writes skip the underlying's UNIQUE/PK re-validation, making the merged-view
  pre-checks (Part 1 + `checkMergedPKConflict`) the sole authority. A latent bug in those
  pre-checks would no longer be caught at flush. This is the intended design and is now
  documented in `design-isolation-layer.md`. Only the store module honors `trustedWrite`
  today; other underlying modules ignore the flag (inert).
