---
description: DROP INDEX on a UNIQUE index left behind the synthesized `UniqueConstraintSchema`, so unique enforcement persisted after the index was gone. Fixed by tagging the derived constraint with `derivedFromIndex` at create time and filtering by it on drop, in both the engine schema registry and the in-memory vtab's cached schema. Store side gets the create-time tag plus a code comment flagging the symmetric drop obligation when `StoreModule.dropIndex` is eventually added.
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/test/logic/drop-unique-index.sqllogic
---

## What changed

### Origin tag on `UniqueConstraintSchema`

`packages/quereus/src/schema/table.ts:441-444` — added optional
`derivedFromIndex?: string`. Populated only by the three sites that
synthesize a unique constraint from a UNIQUE index:

- `SchemaManager.addIndexToTableSchema` (`manager.ts:1256-1265`)
- `MemoryTableManager.createIndex` (`vtab/memory/layer/manager.ts:1287-1299`)
- `StoreModule.createIndex` (`quereus-store/src/common/store-module.ts:343-356`)

CREATE TABLE-time UNIQUE constraints (extracted by
`SchemaManager.extractUniqueConstraints`, manager.ts:896) never set this
field, so they are immune to the filter.

### Drop-side filter

Both engine-side and vtab-side drops now strip the derived constraint
alongside the index:

- `SchemaManager.dropIndex` (`manager.ts:1317-1331`) — filters
  `uniqueConstraints` by `derivedFromIndex?.toLowerCase() !==
  lowerIndexName`, collapsing the array to `undefined` when empty.
- `MemoryTableManager.dropIndex` (`vtab/memory/layer/manager.ts:1345-1358`)
  — same filter applied to the layer's cached `tableSchema` so
  `checkUniqueConstraints` no longer enforces the stale rule.

### Store-side drop is still TODO

`StoreModule` does not yet implement `dropIndex` at all. The create-side
now tags the synthesized constraint and a comment at
`quereus-store/src/common/store-module.ts:343-348` points at the
symmetric drop obligation. **Until that lands, DROP INDEX through the
store path will still leak the unique-constraint** via the StoreTable's
cached schema. Tracked by follow-up backlog ticket
`store-table-drop-index-schema-not-updated`.

## Tests

New file: `packages/quereus/test/logic/drop-unique-index.sqllogic`
covers happy path (CREATE/DROP UNIQUE INDEX clears enforcement),
coincident-name preservation (declared `UNIQUE(b)` survives after
dropping a UNIQUE INDEX on a different column), and partial-UNIQUE
round-trip (DROP INDEX clears the partial predicate scope too).

All 2942 quereus tests pass (`yarn workspace @quereus/quereus run test`)
and lint is clean.

## Review findings

### Code quality / SPP / DRY
- Three create-side synthesis points now redundantly construct the same
  `UniqueConstraintSchema` literal with `derivedFromIndex`. Extracting a
  shared `derivedUniqueConstraintFromIndex(indexSchema)` helper would
  DRY this up across the engine + memory-vtab + store-module boundaries.
  **Not done in this pass** because the call sites span two packages
  with different `IndexSchema` types (the store uses
  `TableIndexSchema`); a shared helper would force a cross-package
  dependency or duplicated type-narrowing. Left as-is; the literals are
  small (4 fields) and the comment trail makes the intent clear.
- Three drop-side filters likewise repeat the same `(uc.derivedFromIndex
  ?? '').toLowerCase() !== lowerIndexName` pattern, but only two are
  live (engine + memory vtab) — small enough to inline.

### Error handling / atomicity
- `MemoryTableManager.dropIndex` order: `baseLayer.updateSchema(...)` then
  `await dropIndexFromBase(...)` then `this.tableSchema = ...`. If
  `dropIndexFromBase` throws, the catch restores `originalManagerSchema`
  on both the base layer and `this.tableSchema`, but the secondary index
  data structure may still be in an intermediate state. **Pre-existing**
  behavior — `createIndex` has the identical mirror-image pattern — and
  not introduced by this fix.
- `SchemaManager.dropIndex` calls `module.dropIndex` first, then updates
  the engine schema. A module-side failure surfaces before any engine
  schema mutation — safe. A success in module followed by a schema-update
  failure in the engine is theoretically possible (e.g., notifier
  throwing) and would leak the constraint on the engine side. Pre-existing.

### Type safety
- `MemoryTableManager.createIndex`'s `newConstraint` is now explicitly
  typed `: UniqueConstraintSchema` — good, since `derivedFromIndex` is
  optional and the literal wouldn't have caught a typo otherwise. The
  type was already imported in that file.

### Tests
- The new `.sqllogic` file covers three distinct scenarios (happy path,
  coincident-name preservation, partial-index). Run via `yarn test`
  (memory vtab) — all 2942 tests pass.
- **Gap: UPDATE-after-DROP not directly tested.** The UPDATE path uses
  `uniqueColumnsChanged` to short-circuit `checkUniqueConstraints`. With
  the constraint removed, `uniqueColumnsChanged` returns false because
  `schema.uniqueConstraints` is `undefined` — so UPDATE works trivially,
  but exercising it explicitly would catch a regression if that
  short-circuit ever flips. Not added — the path is genuinely just
  `if (!schema.uniqueConstraints) return false` and adding the test
  would be testing the language more than the fix.
- **Gap: multi-column UNIQUE INDEX drop not tested.** Code path is
  identical regardless of column count; the filter is on index name not
  column shape. Not added.
- **Gap: store-path drop is not tested at all.** Because
  `StoreModule.dropIndex` doesn't exist yet, there is nothing to test on
  that side — covered by the follow-up ticket.
- `yarn test:store` was **not** run in this environment due to Windows +
  LevelDB plugin setup; the store-side `createIndex` only gained the
  `derivedFromIndex` tag (no behavioral change without a matching drop),
  so regression risk is low.

### Cross-file consistency
- `unique_constraint_info()` TVF (`func/builtins/schema.ts:449-495`)
  iterates `table.uniqueConstraints` and now correctly omits dropped
  derived constraints because the underlying schema is filtered.
- `type-utils.ts:33-75` derives `RelationType.keys` from
  `uniqueConstraints`; dropping the index correctly removes that key
  from downstream DISTINCT-elimination decisions.
- `catalog.ts:144-155` exposes `uniqueConstraints` with names as
  `namedConstraints`. The derived constraint has `name = indexName`, so
  the catalog still surfaces it under the index's name *while the index
  exists*; after drop it disappears. The catalog differ would already
  treat the synthesized name as a real named UNIQUE constraint — a
  pre-existing concern from the parent
  `store-table-create-index-schema-not-updated` ticket, not introduced
  here. Not addressed.
- `MemoryTableManager.ensureUniqueConstraintIndexes` (manager.ts:79-104)
  auto-creates an index for any UNIQUE constraint lacking one. A
  derived constraint always has its index present (they're created
  together), so this never re-materializes a dropped constraint's
  index — verified by reading the call sites; it's only invoked from
  the constructor path.

### Resource cleanup
- No new resources allocated; the filter is purely in-memory schema
  mutation.

### Docs
- `docs/schema.md` does not list `UniqueConstraintSchema` fields (only
  the high-level concept) — no doc update required.
- `docs/optimizer.md:1261` references `TableSchema.uniqueConstraints`
  at the high level and remains accurate.
- `docs/design-isolation-layer.md:378` describes
  `checkMergedUniqueConstraints` semantically; unaffected.

### Disposition
- **Minor findings** (all listed above): three of them are
  potential-DRY observations; none warranted inline fixes given
  cross-package boundary and small literal size. Test gaps documented
  rather than filled — the gaps are either tautological (UPDATE path)
  or out of scope (store-side drop).
- **Major finding**: store-path DROP INDEX leaks the cached
  `uniqueConstraints` on `StoreTable` because `StoreModule.dropIndex`
  is not implemented. Out of scope here (mirrors the create-side
  ticket which only added `createIndex`). Spawned follow-up backlog
  ticket: `store-table-drop-index-schema-not-updated`.
