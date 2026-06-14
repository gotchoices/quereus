description: Store DML + isolation-merge UNIQUE enforcement for a CREATE UNIQUE INDEX … (col COLLATE x)-derived constraint now resolves each column's comparison collation from the index's per-column COLLATE (falling back to the declared column collation), matching the memory module (checkUniqueViaIndex), the store's own buildIndexEntries build-time dedup, and SQLite. The store's ALTER COLUMN SET COLLATE now also propagates the new collation into derived-index columns (memory already did). Reviewed, validated, and completed.
files:
  - packages/quereus-store/src/common/store-table.ts                  # uniqueEnforcementCollations helper; findUniqueConflict + findUniqueConflictViaCoveringMv use it; enforceSecondaryUniqueForMaintenance inherits via findUniqueConflict
  - packages/quereus-store/src/common/store-module.ts                 # alterColumn SET COLLATE propagates the new collation into derived-index columns (metadata-only)
  - packages/quereus-isolation/src/isolated-table.ts                  # uniqueEnforcementCollations helper; findMergedUniqueConflict uses it
  - packages/quereus-store/test/unique-constraints.spec.ts            # "index-derived UNIQUE honors the index per-column collation" describe block (+2 UPDATE-interaction cases added in review)
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic       # §9 cross-module parity (per-scan path)
  - docs/schema.md                                                    # store-collation § "Index-derived UNIQUE enforcement collation" note
  - tickets/backlog/covering-mv-index-derived-unique-collation.md     # follow-up filed for the engine-side covering-MV residuals
----

# Store index-derived UNIQUE honors the index's per-column collation — completed

## Summary

A `CREATE UNIQUE INDEX ix ON t (col COLLATE x)` synthesizes a `derivedFromIndex` UNIQUE
constraint. The store's DML write path previously compared constrained columns under the
**declared column collation**, ignoring the index's `COLLATE` — diverging from the memory
module (`checkUniqueViaIndex`), SQLite, and the store's own `buildIndexEntries` build-time
dedup. The implement stage resolved one comparison collation per `uc.column`
(`index.columns[i]?.collation ?? schema.columns[col].collation`) and applied it at all three
enforcement sites: `StoreTable.findUniqueConflict` (per-scan DML; also inherited by
`enforceSecondaryUniqueForMaintenance`), `StoreTable.findUniqueConflictViaCoveringMv`
(covering-MV re-validation), and `IsolatedTable.findMergedUniqueConflict` (isolation overlay).
A discovered prerequisite — the store's `ALTER COLUMN SET COLLATE` not propagating the new
collation into derived-index columns (memory does) — was also fixed, metadata-only.

## Review findings

**Method.** Read the implement diff (e56bed81) fresh before the handoff: the three enforcement
sites, the ALTER-propagation branch, the memory `checkUniqueViaIndex` reference for parity, the
ADD-CONSTRAINT / ALTER existing-row re-validation (`validateUniqueOverExistingRows`), the
covering-MV candidate-generation seam, the new spec, the §9 sqllogic, and the schema.md note.

### Correctness — verified sound
- **Parity with memory.** `checkUniqueViaIndex` uses `index.specColumns[i]?.collation ??
  schema.columns[col].collation`; the store/isolation helper uses the structurally-equivalent
  `index.columns[i]?.collation ?? schema.columns[col].collation`. Positional alignment of
  `uc.columns[i]` ↔ `index.columns[i]` holds via `appendIndexToTableSchema`. Graceful fallback
  (non-derived constraint, absent index metadata, no explicit index COLLATE) → byte-for-byte
  unchanged behaviour. Confirmed.
- **`enforceSecondaryUniqueForMaintenance` inheritance.** Confirmed it routes through
  `findUniqueConflict`, so maintenance writes pick up the index collation for free.
- **UPDATE path.** Confirmed INSERT and UPDATE both route through `checkUniqueConstraints` →
  `findUniqueConflict` with `selfPks=[pk]`; the collation resolution is identical regardless of
  operation. The implementer's spec exercised INSERT and OR IGNORE/REPLACE but **not UPDATE** —
  a real interaction gap. **Fixed in this pass:** added two store-spec cases (UPDATE-into-collision
  under a coarser NOCASE index incl. self-row no-false-conflict + move-to-distinct; UPDATE under a
  finer BINARY index keeping case-variants updatable but rejecting an exact-bytes dup).
- **ALTER propagation.** Correctly guarded by `collationChanged`; metadata-only (store index KEY
  bytes use the table-level key collation, no entry re-encode). Post-propagation the index
  collation == column collation, so `validateUniqueOverExistingRows` (which keys under the
  **column** collation) stays consistent with write-time enforcement (which keys under the
  **index** collation). Audit item 3 holds. §3–§6 of `41.7.2-alter-column-collate-unique-store`
  genuinely require the propagation (a stale index collation would wrongly admit `A@X`).

### Documented gaps — confirmed real, appropriately deferred (no new ticket needed)
- **Covering-MV residuals** (handoff gap 1). The coarser-index-via-covering-MV miss is
  **pre-existing, not a regression**: before this change the store re-validated under the declared
  (BINARY=finer) collation AND candidate generation narrowed under BINARY, so the
  NOCASE-equal/BINARY-distinct conflict was already never generated. The finer-index-via-covering-MV
  store/memory divergence is **newly introduced** but moves the store toward SQLite-correctness
  (store admits the BINARY-distinct case-variant; memory still over-rejects). Both are covered by
  the already-filed `tickets/backlog/covering-mv-index-derived-unique-collation.md`, which I
  reviewed — accurate and well-scoped (candidate-gen widening + memory MV re-validation alignment +
  cross-module covering-MV parity test). The cross-module §9 sqllogic deliberately uses the
  per-scan path, so no parity test exercises the divergent covering-MV path. Confirmed.
- **ALTER clobbers an explicit differing index COLLATE** (handoff gap 2). Matches memory parity
  (memory has always done this). Acceptable; documented.

### Quality
- **DRY.** `uniqueEnforcementCollations` is duplicated across `store-table.ts` and
  `isolated-table.ts` (separate packages, 5 lines each; memory inlines its own variant). No shared
  util home exists across these package boundaries — left as-is (acceptable, minor).
- **Performance.** The helper does one `indexes.find` + `map` per enforcement call (per DML row,
  not per candidate) — negligible.
- **Docs.** `docs/schema.md` store-collation note accurately reflects the new enforcement and the
  ALTER propagation. Confirmed current.

### Disposition
- **Minor (fixed in this pass):** UPDATE-interaction test gap → added 2 store-spec cases.
- **Major (already filed before review):** covering-MV candidate-generation + memory MV
  re-validation policy → `covering-mv-index-derived-unique-collation` (backlog). No further ticket
  required.

## Validation (all green)
- `@quereus/store` package suite: **572 passing** (570 + 2 new UPDATE cases).
- `@quereus/isolation` package suite: **126 passing**.
- `102.2-unique-collation.sqllogic`: passes under memory **and** store mode (store mode exercises
  the `findMergedUniqueConflict` isolation fix).
- `41.7.2-alter-column-collate-unique-store.sqllogic` (ALTER propagation): passes in store mode.
- Typecheck: `@quereus/quereus` test config, `@quereus/store` src + test config, `@quereus/isolation`
  src — all clean (`tsc --noEmit` exit 0). (A transient LSP diagnostic on a pre-existing `db.watch`
  callback at unique-constraints.spec.ts:296 is an incremental-analysis artifact — authoritative
  `tsc` passes.)

## Other storage plugins — no per-plugin work
leveldb / indexeddb / react-native-leveldb / nativescript-sqlite are all `KVStoreProvider`s feeding
the same `StoreModule` / `StoreTable`; none enforce uniqueness themselves. The store-mode logic
suite runs over LevelDB and is green.
