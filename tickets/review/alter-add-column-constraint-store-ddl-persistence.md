description: REVIEW — `ALTER TABLE ADD COLUMN c <type> [CHECK (...) | REFERENCES parent(pk)]` now persists the column-level CHECK/FK into the store catalog DDL, so the constraint still enforces after `rehydrateCatalog`. Previously the store's addColumn arm persisted a column-only schema, so orphan/violating inserts were silently accepted on reopen. The shared AST→constraint extraction helpers were lifted out of the emit layer into `constraint-builder.ts` so the engine's live merge and the store's persisted set cannot drift.
files: packages/quereus/src/schema/constraint-builder.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/index.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-store/test/rehydrate-catalog.spec.ts
----

## What landed

### The persistence fix (store-module.ts, `alterTable` → `addColumn` arm)

The store's ADD COLUMN arm now builds **two** schema values:

- `updatedSchema` — column-only, exactly as before. Cached via `table.updateSchema(...)`
  and **returned** to the engine. It must stay column-only: the engine's `runAddColumn`
  re-merges the column-level FK/CHECK it extracts from the same `ColumnDef` into the LIVE
  in-memory `SchemaManager` *after* `alterTable` returns. Returning a constrained schema
  would merge a **second** copy (duplicate FK/CHECK live, and on the next persist, in the DDL).
- `persistedSchema` — `updatedSchema` plus the extracted column-level CHECK/FK merged into
  `checkConstraints` / `foreignKeys`. This is what `saveTableDDL(...)` serializes.

The FK child column is resolved to `[updatedColumns.length - 1]` (the new column is appended
last). The merge is **unconditional on the default kind** — extraction reads the AST
constraints regardless of whether the DEFAULT folded to a literal or rides a per-row backfill
evaluator. When the column declares no CHECK/FK, `persistedSchema === updatedSchema` (the
common path is byte-for-byte unchanged).

No existing-row validation was added in the store — the engine's `runAddColumn` already runs
`validateForeignKeyOverExistingRows` / the CHECK post-scan against the live (un-folded) schema
and reverts the column on violation. The store's job here is **persistence only**.

### DRY: shared extraction helpers (constraint-builder.ts)

`extractColumnLevelCheckConstraints` / `extractColumnLevelForeignKeys` were **moved verbatim**
from `runtime/emit/alter-table.ts` into `schema/constraint-builder.ts` (the existing single
source of truth for AST→constraint-schema, already barrel-exported and already consumed by the
store), re-exported through `packages/quereus/src/index.ts`, and imported by both the engine
emit layer and the store. The bodies are unchanged — including the `fk.columns.length !== 1`
mismatch error and the `columns: Object.freeze([])` caller-resolves contract (the store
resolves to `[newColIdx]`; the engine resolves via `columnIndexMap` as before). `opsToMask` and
the now-unused `ForeignKeyConstraintSchema` type import were dropped from `alter-table.ts`.

`generateTableDDL` / `emitTableConstraints` already serialize `checkConstraints` + `foreignKeys`
(including auto names `_check_<col>` / `_fk_<col>`), so **no ddl-generator change was needed** —
the fix is purely getting the constraints into the schema the store persists.

## Use cases / test coverage (the floor)

Three tests added to `packages/quereus-store/test/rehydrate-catalog.spec.ts`, mirroring the
existing `… survives reopen` cases but via ADD COLUMN (all exercise the real StoreModule path:
`saveTableDDL` → `generateTableDDL` → `rehydrateCatalog` re-parse, over the in-memory KV
provider):

- **ADD COLUMN column-level FOREIGN KEY survives reopen** — `add column pref integer null
  references p(pid)`; asserts live orphan-reject pre-reopen, `result.errors` empty after
  rehydrate, orphan rejected + valid child accepted post-reopen.
- **ADD COLUMN column-level CHECK survives reopen** — `add column qty integer null check
  (qty > 0)`; violating insert rejected and satisfying insert accepted post-reopen.
- **ADD COLUMN with per-row (non-foldable) DEFAULT + FK survives reopen** — `add column pref
  integer default (new.id) references pp(pid)`; proves persistence is **not** gated on a
  literal default (this is the path the bug report specifically called out). FK still rejects
  an orphan after reopen.

Note: the added columns are declared `NULL` — the store defaults columns to NOT NULL, and
ADD COLUMN of a NOT NULL column with no DEFAULT on a non-empty table is rejected (pre-existing
engine/store behavior). `NULL` also makes the single existing row's new value NULL, which
MATCH-SIMPLE / CHECK-on-NULL correctly exempt, so the ALTER succeeds.

## Validation run

- `yarn workspace @quereus/quereus run build` → exit 0 (regenerates the engine `.d.ts` the
  store consumes; the helper move changes the barrel surface).
- Store rehydrate spec (`node --import ./packages/quereus-store/register.mjs … mocha
  rehydrate-catalog.spec.ts`) → **12 passing** (9 prior + 3 new), 0 failing.
- `yarn test` (full memory path, all workspaces) → engine **4853 passing / 9 pending**, all
  other workspaces green, `Done in 2m 42s` — confirms the alter-table helper move did not
  regress the engine ALTER suite.
- `yarn workspace @quereus/quereus run lint` → exit 0.
- `yarn workspace @quereus/quereus-store run typecheck` (`tsc --noEmit`) → exit 0 (the store
  test runner uses Node type-stripping, which does NOT type-check; this confirms the store
  edits compile cleanly against the rebuilt engine).

## Honest gaps for the reviewer (floor, not ceiling)

- **In-memory KV provider only.** The new tests use `InMemoryKVStore` (same as the existing
  reopen tests). The DDL serialize/reparse path is backend-agnostic, but no real LevelDB/
  IndexedDB round-trip was exercised. `yarn test:store` (full store logic suite) was **not**
  run — the change is confined to the ADD COLUMN persist arm and is covered by the targeted
  spec; a store full-run in CI is still advisable.
- **Auto-named constraints only.** Tests cover the `_fk_<col>` / `_check_<col>` auto-naming
  path. An explicitly-named column-level constraint (`… constraint my_fk references …`) is
  handled by the `con.name ?? auto` extraction but is **untested** end-to-end.
- **No combined CHECK+FK on a single ADD COLUMN tested.** The store handles each arm
  independently (both merged into `persistedSchema`), but a column declaring both at once has
  no dedicated test.
- **DEFAULT-expression preservation not asserted.** The per-row-default test asserts the FK
  persists and the DDL re-parses cleanly, but does not assert the `default (new.id)` expression
  itself survives reopen — that is orthogonal to this ticket (FK/CHECK persistence) and
  unverified here.
- **Column-level UNIQUE is intentionally out of scope** — not persisted via this path (the
  manager's existing rejection handles inline UNIQUE on ADD COLUMN); not a regression.
- **Pre-existing, untouched:** the `noUnusedParameters` LSP hint on `rebuildViaShadowTable`'s
  unused `schema` param in `alter-table.ts` predates this ticket (confirmed in
  `complete/alter-add-column-backfill-fk-enforcement.md`); it re-surfaced only because the
  helper deletion shifted line numbers. Build + lint are clean.

## Suggested reviewer focus

- Confirm the **no-double-merge** invariant: that the store returns the column-only schema and
  only `saveTableDDL` sees the constrained one — a regression here would duplicate the
  constraint live and in the DDL (rehydrate would build two identical FKs/CHECKs).
- Confirm the engine path is behaviorally identical after the helper move (the bodies are
  verbatim; the 4853-passing memory run is the guard).
