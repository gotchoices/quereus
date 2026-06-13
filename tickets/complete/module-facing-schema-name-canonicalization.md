description: COMPLETE — canonicalize the four SchemaManager module-call frontiers (createIndex, dropIndex, destroy, importTable→connect) so modules always receive canonical stored names; contract docs + tests added and reviewed.
files:
  - packages/quereus/src/schema/manager.ts                                  # the 4 frontier edits
  - packages/quereus/test/schema/module-name-canonicalization.spec.ts       # recording-module spec (6 tests)
  - packages/quereus-store/test/index-persistence.spec.ts                   # +2 case-divergent drop tests
  - docs/module-authoring.md                                                # § "Identifier casing in module-facing calls"
  - docs/schema.md                                                          # § Schema Change Events naming-contract paragraph

# Module-facing schema/object name canonicalization — COMPLETE

## What landed

All four raw module-call frontiers in `schema/manager.ts` now hand modules
**canonical stored names** (`schemaName` lowercase/canonical, object names in
their stored display casing), never the raw spelling of the triggering DDL:

| Frontier | Site | Change |
| --- | --- | --- |
| `vtabModule.createIndex` | `createIndex` L2343 | `(db, tableSchema.schemaName, tableSchema.name, indexSchema)` |
| `module.dropIndex` | `dropIndex` L2462 | `storedIndexName` hoisted above the call; `(db, ownerTable.schemaName, ownerTable.name, storedIndexName)` |
| `module.destroy` | `dropTable` L1479 | `(…, tableSchema.schemaName, tableSchema.name)` |
| `module.connect` | `importTable` L3082 | `(…, tableSchema.schemaName, tableSchema.name, …)`; `getOrCreateSchema` + returned name string also switched to `tableSchema.*` |

The as-spelled exception (`indexSchema.name` — a new index's own name, which
*becomes* the stored name) is preserved. Docs added: module-authoring.md §
"Identifier casing in module-facing calls" + a sentence extending schema.md's
event naming-contract to the module-call surface.

## Review findings

### Process
Read the implement diff (`9b1927ec`) first with fresh eyes, then traced each
frontier in the current source, verified the underlying stored-name invariant,
audited for missed frontiers, confirmed the store tests are *discriminating*
(not just green), then ran lint + the full suite.

### Correctness — verified, no issues
- **The core invariant holds.** `tableSchema.schemaName` / `ownerTable.schemaName`
  are canonical: `buildTableSchemaFromAST` (manager.ts:1831-1833) sets
  `schemaName` through `canonicalSchemaName` at create time, and the object
  name keeps its declared display casing. So the four edits genuinely change the
  *casing* handed to modules, not just the variable.
- **dropIndex hoist is sound.** `storedIndexName` is computed before the module
  call and reused by the two events below it; `ownerTable.indexes` is not mutated
  until after (the `updatedIndexes` rebuild at L2475), so the `.find(...)!`
  non-null is safe (an owner match was already proven at L2434). The drop event
  + `table_modified` event both use `ownerTable.schemaName` / `storedIndexName`,
  fully consistent with the module call.
- **importTable `getOrCreateSchema` switch is a functional no-op** (the method
  lowercases its arg internally, so `targetSchemaName` and `tableSchema.schemaName`
  resolve the same `Schema`); kept for local consistency. The changed **return
  name string** (`${tableSchema.schemaName}.${tableSchema.name}`) is display-only:
  `importCatalog` just pushes it into a `tables: string[]` informational array
  (manager.ts:2740-2741) — confirmed not used as a case-sensitive key.

### Coverage completeness — verified, no missed frontier
- Enumerated every `module.*` call in manager.ts (create ×2, connect, destroy,
  createIndex, dropIndex). `create` takes the full canonical `TableSchema`, so it
  was already correct.
- The docs claim the contract also holds for `alterTable` / `renameTable` /
  `getBackingHost`. Verified those frontiers (in `runtime/emit/alter-table.ts`,
  `materialized-view-helpers.ts`) **already** pass `tableSchema.schemaName` +
  stored names — e.g. `renameTable` (alter-table.ts:174,193) passes
  `oldName = tableSchema.name` (stored) and `newName` as-spelled, exactly the
  documented rule. The docs are accurate, not aspirational.

### Tests — verified discriminating, all pass
- The two new **store** tests would have looked vacuous (real
  `buildIndexStoreName`/`buildDataStoreName` lowercase the whole key, so physical
  keys are identical pre/post-fix). Confirmed they *do* discriminate because the
  test's `createPersistentProvider` deliberately keys by **exact casing** (its
  `idxKey`/`dataKey` do **not** lowercase — index-persistence.spec.ts:47-49),
  mirroring "a provider that keys verbatim". Pre-fix, a divergent `drop index
  MYIDX` → `deleteIndexStore('main','t','MYIDX')` would orphan the
  `main.t_idx_MyIdx` store; the `indexStoreSize('t','MyIdx') === 0` assertion
  catches it. Same logic for the DROP TABLE (`provider.stores.has('main.t')`)
  test.
- **Minor (left as-is, harmless):** in the DROP INDEX test the secondary
  assertion `provider.stores.has('main.t_idx_MYIDX')).to.equal(false)` is
  *vacuous* — a mixed-case `MYIDX` key is never created (delete-of-absent is a
  no-op), so it is true regardless of the fix. The discriminating assertion is
  the `indexStoreSize('t','MyIdx') === 0` line directly above it, which is
  present and correct, so the test still proves the fix. Not worth a test edit;
  noted so a future reader doesn't over-trust that one line.
- The 6 memory-backed spec tests pin createIndex / dropIndex / destroy / connect
  / create plus a non-`main` (`aux`) current-schema case. The implementer's own
  honesty notes (the `aux` checks are contract pins not fix-discriminating for
  three of the four hooks; the in-memory `connect` test is an `importCatalog`
  proxy not a true reopen) are accurate and acceptable — the discriminating
  coverage is the `MAIN.`-qualified memory tests plus the store reopen tests.

### Docs — verified accurate
Read both touched docs end-to-end against the new code. module-authoring.md §
"Identifier casing in module-facing calls" correctly enumerates the hook surface
and the single as-spelled exception (createIndex `indexSchema.name`,
renameTable `newName`); schema.md's added sentence correctly cross-links it. No
drift.

### Type safety / cleanup
- `RecordingModule` overrides are fully typed (no `any`); imports are precise.
- Comments at each frontier reference the `canonicalSchemaName` invariant,
  matching the existing event-emitter comment style (consistent, not over-DRY'd).

### Not done / out of scope (accepted)
- Full `yarn test:store` cycle (re-runs the whole sqllogic suite against the
  store; not agent-runnable per AGENTS.md). Store impact is covered by the
  focused `index-persistence.spec.ts` unit tests. Recommend CI carry `test:store`.

## Validation run during review (all green)
- `yarn lint` (packages/quereus) → clean (eslint + `tsc -p tsconfig.test.json`).
- New memory spec `module-name-canonicalization.spec.ts` → **6 passing**.
- `index-persistence.spec.ts` (after `yarn workspace @quereus/quereus build`) →
  **19 passing** (incl. the 2 new case-divergent drop tests).
- Full `packages/quereus` suite (`node test-runner.mjs`) → **6216 passing**,
  9 pending, 0 failing.

## Disposition
No major findings → no new fix/plan tickets filed. One harmless minor
observation (the vacuous secondary store assertion) documented above and left
in place. Implementation is correct, complete, and adequately covered.
