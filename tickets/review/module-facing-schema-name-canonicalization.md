description: Review the canonicalization of the four SchemaManager module-call frontiers (createIndex, dropIndex, destroy, importTable→connect) so modules always receive canonical stored names, plus the contract docs and tests
difficulty: medium
files:
  - packages/quereus/src/schema/manager.ts                                  # the 4 frontier edits
  - packages/quereus/test/schema/module-name-canonicalization.spec.ts       # NEW recording-module spec (6 tests)
  - packages/quereus-store/test/index-persistence.spec.ts                   # +2 case-divergent drop tests at the tail
  - docs/module-authoring.md                                                # NEW § "Identifier casing in module-facing calls"
  - docs/schema.md                                                          # extended § Schema Change Events naming-contract paragraph

# Review: module-facing schema/object name canonicalization

## What was implemented

Extended the engine-wide stored-name contract (`SchemaManager.canonicalSchemaName`,
docs/schema.md § Schema Change Events) to the **module-call surface**. All four
raw frontiers in `schema/manager.ts` now hand modules **canonical stored names**
(`schemaName` lowercase/canonical, object names in their stored display casing),
never the raw spelling of the triggering DDL statement:

| Frontier | Site | Change |
| --- | --- | --- |
| `vtabModule.createIndex` | `createIndex` ~L2333 | now `(db, tableSchema.schemaName, tableSchema.name, indexSchema)` |
| `module.dropIndex` | `dropIndex` ~L2459 | `storedIndexName` **hoisted above** the call; now `(db, ownerTable.schemaName, ownerTable.name, storedIndexName)` |
| `module.destroy` | `dropTable` ~L1474 | now `(…, tableSchema.schemaName, tableSchema.name)` |
| `module.connect` | `importTable` ~L3064 | now `(…, tableSchema.schemaName, tableSchema.name, …)`; `getOrCreateSchema` and the returned name string also switched to `tableSchema.*` for local consistency |

The as-spelled exception is preserved: `indexSchema.name` (a *new* index's own
name) is left untouched — it *becomes* the stored name. Inline comments at each
site reference the `canonicalSchemaName`/stored-name invariant, mirroring the
existing event-emitter comments.

No store-side change was needed (confirmed by the plan-pass audit and re-verified
here): every physical key is already case-folded in `key-builder.ts`
(`buildDataStoreName`/`buildIndexStoreName` lowercase the full string), so
`lowercase(canonical) === lowercase(raw)` — physical stores are byte-identical,
no migration, no read-side case-fold fallback. The change is observably a
**display/registry fix**, not a key change.

## Why it matters (the behavioral delta)

The store's `StoreTable.indexStores` cache and `provider.deleteIndexStore` /
`deleteTableStores` are invoked with the engine-supplied arg. Before this change a
case-divergent `DROP INDEX iDx` / `DROP TABLE T` handed the module the **raw**
spelling, so against a provider that keys by exact casing (the in-memory test
provider; a real lowercasing disk provider masked it) the wrong store key was
addressed — a leaked/orphaned backing store. Passing the stored name makes the
frontier's verbatim keying correct.

## How to validate / use cases

Run order matters: the store + isolation packages import the **built**
`@quereus/quereus` (`dist`), so `yarn workspace @quereus/quereus build` must
precede the store/isolation suites.

**Primary spec** — `packages/quereus/test/schema/module-name-canonicalization.spec.ts`
(memory-backed, fast). A `RecordingModule` subclasses `MemoryTableModule` and
captures the exact args the engine hands each hook. Covers:
- `createIndex` — `create table MAIN.t` + `create index IDX on T` → asserts
  `main` / stored `t`, and `indexName === 'IDX'` (the as-spelled new-name exception).
- `dropIndex` — created `MyIdx`, dropped `MYIDX` → asserts the arg is the stored
  `MyIdx` (neither all-lower nor all-upper, so unambiguous).
- `destroy` — `create table MAIN.Tbl` + `drop table tbl` → asserts `main` / `Tbl`.
- `connect` — `create table MAIN.t` then `importCatalog([… MAIN.t …])` → asserts
  `main` / `t`.
- `create` control — already-canonical `TableSchema` stays canonical.
- non-`main` current schema (`aux`) — unqualified create/index/drop all canonicalize to `aux`.

**Store round-trip** — `packages/quereus-store/test/index-persistence.spec.ts`
(+2 tests at the tail). The in-memory provider keys stores by exact casing,
directly exposing key drift:
- case-divergent `DROP INDEX` releases the backing store under the stored name
  (no orphan under the raw spelling);
- case-divergent `DROP TABLE` tears down the stored-name data+index stores and a
  reopen does not resurrect.

Validation already run (all green):
- `yarn workspace @quereus/quereus test` → **6216 passing**, 9 pending, 0 failing.
- `yarn lint` (`packages/quereus`) → clean (eslint + `tsc -p tsconfig.test.json`).
- quereus-store package unit tests → **563 passing** (after rebuilding the engine).
- quereus-isolation package unit tests → **126 passing** (forwards args verbatim; unaffected).

## Honest gaps / reviewer attention

- **In-memory `connect` test is a proxy, not a true reopen.** It does
  `create table MAIN.t` then `importCatalog` of the same DDL (the established
  in-memory pattern — memory `connect` requires a prior `create`), so it pins the
  canonicalization of the `connect` arg but not a fresh-DB close→reopen. The
  genuine reopen path is exercised by the store reopen tests
  (`index-persistence.spec.ts` `reopen()` + the new DROP TABLE reopen assertion).
- **The `aux` (non-main current schema) assertions are contract pins, not
  fix-discriminating for createIndex/dropIndex/destroy.** Unqualified DDL already
  resolved to the current schema before the change, so those three `schemaName ===
  'aux'` checks would have passed pre-fix; the discriminating coverage is the
  `MAIN.`-qualified tests. Kept as symmetry/regression pins.
- **Full `yarn test:store` cycle was NOT run** (it re-runs the entire logic
  sqllogic suite against the store and routinely exceeds the agent idle window —
  not agent-runnable per AGENTS.md). The store impact is instead covered by the
  focused `index-persistence.spec.ts` unit tests (the sanctioned cheaper path) plus
  the 563-test store package suite. Recommend CI carry the full `test:store` cycle.
- **`importTable` returned name string casing changed** (`${tableSchema.schemaName}.${tableSchema.name}`
  instead of the raw `${targetSchemaName}.${tableName}`). This is a display-only
  field in the `importCatalog` result array (confirmed not used as a case-sensitive
  key by `importDDL`); the ticket explicitly endorsed switching it. Worth a glance.
- Did not add an `emit/scan.ts` / `runtime/utils.ts` style runtime-connect check —
  those sites already pass `tableSchema.*` (per the plan-pass sweep) and were out
  of scope.
