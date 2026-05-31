description: UNIQUE enforcement now honors the column's declared collation (e.g. `col text collate NOCASE`) on every enforcement path — memory auto-index, memory covering-MV validator, memory cold scan, store scan, store covering-MV validator, and the isolation-layer merge scan — instead of comparing BINARY. Reviewed and completed.
prereq:
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/index.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/src/util/comparison.ts, packages/quereus/test/logic/102.2-unique-collation.sqllogic, packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic, packages/quereus/test/covering-structure.spec.ts, packages/quereus-store/test/unique-constraints.spec.ts
----

## Summary

A non-PK `unique(col)` over a column with a non-binary declared collation (e.g.
`col text collate NOCASE`) was previously enforced with BINARY comparison, so `'abc'` and
`'ABC'` were stored as distinct rows — a soundness gap. Root cause: the auto-built UNIQUE
index dropped the column's collation, and every direct conflict validator defaulted
`compareSqlValues` to BINARY. The fix threads each column's declared collation
(`ColumnSchema.collation`) into the auto-index spec and into every conflict comparison.

### Enforcement sites fixed (6)

- **Memory** (`manager.ts`): `ensureUniqueConstraintIndexes` (auto-index carries
  `collation`), `checkUniqueViaMaterializedView` (covering-MV validator),
  `checkUniqueByScanning` (cold primary-tree fallback).
- **Store** (`store-table.ts`): `findUniqueConflict` (plain scan),
  `findUniqueConflictViaCoveringMv` (covering-MV validator).
- **Isolation** (`isolated-table.ts`): `findMergedUniqueConflict` (underlying-vs-new merge
  scan). Not in the original 5-site ticket scope; added because `yarn test:store` wraps
  every table in `createIsolatedStoreModule`, which enforces non-PK UNIQUE through this
  merge path rather than `store-table.ts`. Without it, store-mode plain-NOCASE UNIQUE still
  silently accepted the duplicate.

The auto-index mechanism is sound: `MemoryIndex` (`index.ts`) builds its single- and
composite-column comparators from `specCol.collation` via
`createTypedComparator(type, resolveCollation(collation))`, so `checkUniqueViaIndex`
groups `'abc'`/`'ABC'` to the same key once the spec carries the collation.

## Review findings

### Scope / aspects checked

- **Correctness of all 6 sites** — read each in context; `schema` (or `this.tableSchema!`)
  is in scope and the column index used is the correct UNIQUE-member index at every site.
- **Auto-index mechanism** — verified `MemoryIndex.createSingleColumnKeyFunctions` /
  `createCompositeColumnKeyFunctions` resolve the per-column collation, so the index path
  (which does not re-compare values, trusting the BTree grouping) is collation-correct.
- **Non-text safety / no regression** — `compareSqlValues` → `compareSameType` applies the
  collation function **only** to `StorageClass.TEXT`. Passing an explicit collation for a
  numeric/blob/BINARY UNIQUE column is identical to the prior `undefined` (defaults to
  `BINARY_COLLATION`). Corroborated by the full memory suite (4088 passing).
- **No missed enforcement sites** — swept every `compareSqlValues` call in
  `store-table.ts` and `isolated-table.ts`. The remainder are PK-identity (`keysEqual`,
  isolated-table:993) and index sort-key comparators (isolated-table:548/571), correctly
  BINARY and out of scope.
- **`uniqueColumnsChanged` (store UPDATE gate, store-table.ts:961)** — deliberately left
  BINARY and that is **correct**: it gates *whether to re-run* the uniqueness check on
  UPDATE. BINARY equality implies equality under NOCASE/RTRIM, so a BINARY "unchanged"
  result (skip re-check) only fires on byte-identical values — it never wrongly skips a
  needed re-check. A case-only change ('abc'→'ABC') reports "changed" and triggers the
  (now collation-aware) re-check. Conservative-safe, not a bug.
- **102.1 prose correction** — confirmed the root cause it now describes: `table.ts:193`
  does a **case-sensitive** `supportedCollations.includes(constraint.collation)` against
  `['BINARY','NOCASE','RTRIM']`, which is why lowercase `nocase` is rejected with a
  "not supported" message while uppercase `NOCASE` is accepted. Prose is accurate.
- **`covering-structure.spec.ts` note** — the previously-stale comment ("end-to-end nets to
  BINARY") was correctly updated to point at the now-landed enforcement and `102.2`.
- **Backlog spin-off** — `unique-collation-name-case-insensitive-normalization.md` is
  well-formed; the scope split (collation-name parsing is a distinct concern from UNIQUE
  enforcement) is sound. Left as filed.

### Findings & disposition

- **Minor (fixed in this pass):** the handoff flagged two untested-but-correct-by-
  construction combinations. Added regression coverage to
  `102.2-unique-collation.sqllogic` (runs under BOTH memory and store/isolation modes):
  - **§6 composite mixed NOCASE+BINARY UNIQUE** — proves per-column collation threading:
    the NOCASE member case-folds while the BINARY member does not (`('ABC','xyz')` collides
    with `('abc','xyz')`, but `('ABC','XYZ')` inserts).
  - **§7 UPDATE onto a NOCASE-equal value** — proves the conflict validators back UPDATE,
    not just INSERT (an aborted collision leaves both rows unchanged; a distinct update
    still succeeds).
  Both pass under memory (`yarn test`) and store/isolation (`yarn test:store`).
- **No major findings** — no new fix/plan/backlog tickets required from the review itself.
  (The one backlog ticket present, lowercase-collation normalization, was filed during
  implement and is correctly out of scope.)

### Residual gap (accepted, not actioned)

- **`checkUniqueByScanning` (memory cold scan) has no executing test.** It only fires for
  pathological schemas with a declared UNIQUE but no covering structure, which cannot be
  produced from SQL (the auto-index always services a declared UNIQUE). The one-line change
  is the identical per-column `schema.columns[colIdx].collation` thread already proven by
  the two sibling memory validators that ARE covered (`checkUniqueViaIndex` end-to-end and
  `checkUniqueViaMaterializedView`). A white-box harness constructing a UNIQUE-but-no-index
  `MemoryTableManager` would be brittle and low-value; left documented rather than forced.

### Pre-existing failure

- `51-lens-foundation.sqllogic` ("lens: logical table 'appcar.Car' has no basis backing")
  was a pre-existing store-mode failure on this branch, unrelated to this ticket. The
  runner's triage pass **fixed** it (commit `06f803d9`) by forwarding
  `getMappingAdvertisements` through `IsolationModule` to the underlying module. Not a
  concern for this ticket.

## Validation (review run)

- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run build` (typecheck) — clean.
- Full memory suite (`yarn test`) — **4088 passing, 9 pending, 0 failing**.
- `@quereus/store` package suite — **279 passing**.
- Targeted `--grep "102\.2|102\.1|covering"` — **42 passing** under memory.
- `102.2` (incl. new §6/§7) — passes under BOTH memory and store/isolation modes.

## Notes

- Original soundness gap discovered while reviewing
  `covering-structure-mv-rowtime-enforcement`; broader than the covering-MV feature.
- Do **not** "fix" the lowercase-`nocase` normalization here — tracked by
  `unique-collation-name-case-insensitive-normalization` in backlog.
