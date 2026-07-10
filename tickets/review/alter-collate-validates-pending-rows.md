description: Changing a text column's sort/compare rule inside a transaction now checks the rows that transaction just wrote, and the new rule governs the rest of the transaction and survives commit — previously duplicates slipped through and the change was silently discarded.
files:
  - packages/quereus/src/schema/unique-enforcement.ts          # NEW exported `indexEnforcesUnique`
  - packages/quereus/src/vtab/memory/layer/manager.ts          # alterColumn, validateRekeyedUniqueStructures, adoptSchemaOnOpenLayers
  - packages/quereus/src/vtab/memory/layer/base.ts             # rebuildAllSecondaryIndexes doc; strict paths deleted
  - packages/quereus/src/vtab/memory/layer/transaction.ts      # adoptSchema now replaces, not just adds
  - packages/quereus/src/vtab/memory/index.ts                  # stale doc reference
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts # 13 new cases
  - docs/memory-table.md                                       # § DDL and transactions rewritten
difficulty: hard
----

# Review: `alter column … set collate` sees, and then governs, the issuing transaction's rows

## What the bug was

The memory backend keeps committed rows in a **base layer** and each open transaction's
uncommitted writes in a **transaction layer** stacked on top. `alter table … alter column …
set collate` rebuilt only the base layer's structures. Four consequences, all reproduced on
`main` before the fix:

1. A duplicate that existed only in the transaction's pending rows was invisible to the
   uniqueness re-check, so the change was accepted and duplicates committed.
2. A row the transaction had *deleted* still sat in the base tree and wrongly raised
   `UNIQUE constraint failed`, blocking a legal change.
3. An accepted change never reached the open transaction — later statements kept comparing
   under the old collation.
4. At commit the pending layer *became* the committed head, carrying its old-collation schema
   and old-collation index trees, shadowing the base's rebuilt ones. The change was in effect
   silently discarded whenever it ran inside a transaction that had written anything.

## What changed

**Part 1 — validate over effective rows, then rebuild non-enforcing.**
`MemoryTableManager.alterColumn` now calls a new `validateRekeyedUniqueStructures()` *before any
mutation*, once per index of the new schema that mentions the altered column and enforces
uniqueness. It reuses the sibling fix's `validateUniqueOverEffectiveRows()` — a throwaway
collation-aware `MemoryIndex` populated from `effectiveDdlRows()` (the layer a `select` in the
same transaction would scan), letting `populateIndexFromRows(..., enforceUnique = true, ...)`
raise `CONSTRAINT` on the first duplicate.

The base rebuild then became non-enforcing (`rebuildAllSecondaryIndexes()` instead of the
deleted `rebuildAllSecondaryIndexesStrict()`), because base rows are **not** a subset of
effective rows — bug 2 is exactly a base-resident row the transaction deleted. This is the same
reasoning `addIndexToBase` already documents: the base index is a lookup structure, never an
enforcement one, and `checkUniqueViaIndex` re-validates every candidate against the live
effective row.

`BaseLayer.rebuildAllSecondaryIndexesStrict` and `BaseLayer.populateNewIndex` are deleted (no
callers). `BaseLayer.indexEnforcesUnique` was lifted to an exported
`indexEnforcesUnique(schema, indexSchema)` in `src/schema/unique-enforcement.ts`.

**Part 2 — re-key the open transaction's layers.**
`alterColumn` now calls `adoptSchemaOnOpenLayers(finalNewTableSchema)` on a collation change, and
`TransactionLayer.adoptSchema` learned to **replace** an index, not merely add missing ones. The
discriminator is `IndexSchema` object identity between the layer's old schema and the new one:
every re-keying path rebuilds those objects, every additive path preserves them. A replaced index
is built over the parent's already-re-keyed tree and brought up to date with the existing
`reindexOwnWrites` — identical to the additive path, so `reindexOwnWrites` is unchanged.
`adoptSchemaOnOpenLayers` already walks the chain oldest-first, which is what makes
"build over the parent's tree" valid.

This replacement is not optional even for indexes that don't mention the altered column:
`rebuildAllSecondaryIndexes()` hands **every** index a fresh `MemoryIndex` and BTree, so a layer
that kept its old one would be inheriting an orphaned tree.

**Primary-key carve-out.** A collation change on a PK column keeps the existing
`rebuildPrimaryTreeStrict()` behavior and is explicitly **excluded** from `adoptSchemaOnOpenLayers`
(guard: `collationChanged && !pkColumnRekeyed`). `rebuildPrimaryTreeStrict` swaps the base primary
tree object out from under a pending layer's copy-on-write base, and `adoptSchema` may not rebuild
`pkFunctions`. That whole case is owned by `alter-collate-pk-in-transaction`. Outside a transaction
there are no open layers, so the carve-out is a no-op and
`test/logic/41.7.1-alter-column-collate-unique.sqllogic` still passes unchanged.

## Validation performed

- `yarn workspace @quereus/quereus test` → **6749 passing, 0 failing**.
- `yarn test` (all workspaces) → green.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) → clean, exit 0.
- `test/logic/41.7.1-alter-column-collate-unique.sqllogic`, `41.7.2-alter-column-collate-unique-store.sqllogic`,
  `41.7-alter-column-collate.sqllogic` → all 3 pass (run explicitly).
- **Negative controls** (each half of the fix disabled in turn, then restored) confirm the new
  tests bite rather than pass vacuously:
  - Disabling `adoptSchemaOnOpenLayers` → 6 of the 13 new tests fail.
  - Disabling `validateRekeyedUniqueStructures` → 4 of the 13 new tests fail.
  - The remaining 3 (NULL semantics, sibling `BUSY`, metadata-only `set collate binary`) are
    guard/no-op assertions and pass either way by design.

## Use cases the reviewer should exercise

All new cases live in `packages/quereus/test/ddl-in-transaction-validation.spec.ts`, in the
`describe('alter column … set collate re-keys over the transaction's own rows')` block. Memory
backend only — extending `41.7.x` sqllogic with a transactional section would fail in store mode
until `isolation-ddl-validation-ignores-overlay-rows` lands.

- pending-only duplicate under the new collation → `CONSTRAINT`; transaction still usable; column
  collation still `BINARY`; `'b'`/`'B'` still distinct afterwards (old collation still governs).
- committed row + pending row colliding under the new collation → `CONSTRAINT`.
- pending `delete` of the committed duplicate → accepted; after `commit`, inserting `'A'` next to
  `'a'` is rejected.
- accepted change → a later colliding `insert` **and** a later colliding `update` in the same
  transaction are rejected.
- accepted change → after `commit`, a colliding insert is rejected, and `where v = 'a'` still
  resolves through the re-keyed index.
- multiple `NULL`s in the pending layer do not collide.
- table-level `unique (v)` with no explicit index — the auto-built `_uc_*` covering structure
  (which carries no `unique: true` flag) is validated too.
- a **non-unique** `create index` is re-keyed but never blocks the change; both case-variant rows
  survive and `where v = 'a'` finds both under `NOCASE`.
- duplicate held only in an eager savepoint snapshot is seen.
- after `rollback to savepoint`, the collation change declared *after* the savepoint still governs.
- sibling connection with uncommitted writes → `BUSY`.
- metadata-only `set collate binary` on an already-binary column inside a transaction: flips
  `collationExplicit` only, no re-key, no validation, no adoption.

## Known gaps / things to poke at

Treat the tests as a floor. Specific places I'd look:

- **MV-covered UNIQUE not walked.** `validateRekeyedUniqueStructures` iterates `schema.indexes`.
  `findIndexForConstraint` prefers a linked row-time covering materialized view over the auto-index
  when one exists. I did **not** file a ticket: the auto-index always exists alongside the MV and
  carries the same column set and collations, so the *validation* is still exact. What I did not
  verify end-to-end is whether the MV's own backing structure is re-keyed by the same ALTER
  (`materialized-view-helpers.ts` does map `alterColumn` + `setCollation` onto a backing op). If a
  reviewer can construct a case where the MV is the enforcement path and its backing is stale after
  the ALTER, that is a real bug and deserves a ticket.

- **The `catch` rollback path was kept, not simplified.** The ticket asked me to confirm whether
  the partial-rebuild recovery is now unreachable. It is **not**: `rebuildPrimaryTreeStrict()` still
  throws *after* `rebuildAllSecondaryIndexes()` has re-keyed the secondaries, and the `setDataType`
  arm can throw mid-way through an in-place row conversion. So the unconditional
  `updateSchema(original) + rebuildAllSecondaryIndexes()` in the catch still earns its keep. It does
  mean a validation rejection (which mutates nothing) pays a wasted rebuild that swaps the base's
  index trees for fresh, content-identical ones. I convinced myself this is harmless — a pending
  layer keeps reading its orphaned but content-correct base tree, and the same swap happened before
  this change — but it is the subtlest thing in the diff and worth a second pair of eyes.

- **PK-column collation change inside a transaction is still broken**, deliberately. With an open
  pending layer, `rebuildPrimaryTreeStrict()` swaps the base primary tree and the pending layer's
  copy-on-write base is left pointing at the old one. That is `alter-collate-pk-in-transaction`'s
  scope; I added the guard and did not attempt to fix or `BUSY`-reject it. No new test covers it.

- **`setDataType` does not rebuild secondary indexes** after converting rows in place. Pre-existing,
  outside this diff, no ticket filed — but I noticed it while reading `alterColumn` and it looks
  like a real defect (indexes keep pre-conversion key values).

- **Tripwire parked in code:** `manager.ts` `validateRekeyedUniqueStructures` carries a `NOTE:`
  explaining that the probe index is built with the manager's *pre-change* `primaryKeyFunctions`
  (the new ones cannot exist before the schema swaps). Sound today because duplicate detection fires
  on the index key before any PK is stored, and every effective row has a distinct PK under the old
  encoder. If a probe ever needs to compare PKs semantically, the new functions must be threaded in.

## Review findings

_(to be filled by the review stage)_
