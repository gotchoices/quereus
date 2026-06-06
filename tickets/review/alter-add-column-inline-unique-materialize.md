description: Review the fix that materializes + enforces an inline column-level UNIQUE on `ALTER TABLE … ADD COLUMN <col> … UNIQUE` (previously silently dropped). Inline UNIQUE now routes through the same module `addConstraint` UNIQUE path as `ALTER TABLE … ADD CONSTRAINT … UNIQUE`. A latent `dropColumn` bug (dangling unique constraint over a dropped column) was also fixed, since the revert path depends on it.
files:
  - packages/quereus/src/schema/constraint-builder.ts            # NEW extractColumnLevelUniqueConstraints (@~168) — emits synthetic table-level UNIQUE AST per inline `unique` ColumnConstraint
  - packages/quereus/src/runtime/emit/alter-table.ts             # runAddColumn: inline-UNIQUE block after addColumn (@~344), try/catch dropColumn revert; stale comment fixed (@~286)
  - packages/quereus/src/vtab/memory/layer/manager.ts            # dropColumn: prune uniqueConstraints over dropped col + clear implicitCoveringStructures (@~1507)
  - packages/quereus-store/src/common/store-module.ts            # dropColumn arm: prune uniqueConstraints over dropped col (@~758)
  - packages/quereus/test/logic/41.3-alter-add-column-unique.sqllogic   # NEW cross-module logic test (memory + store)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic        # Phase 24: stale comment fixed + c5 inline-UNIQUE-tag round-trip case (@~626)
  - docs/sql.md                                                  # ADD COLUMN section: note inline UNIQUE is now materialized (@~1272)
----

# Review: materialize + enforce inline UNIQUE on ALTER TABLE ADD COLUMN

## What changed (and why)

Before: `alter table T add column u int unique` accepted the statement, added the column, but
**silently dropped** the inline UNIQUE — never materialized, enforced, or rejected. The
`runAddColumn` runtime extracted only the new column's inline CHECK and FK; column-level UNIQUE
fell through (`manager.extractUniqueConstraints` is the CREATE-time schema-build path, never
reached by the imperative ADD COLUMN runtime).

Fix (the ticket's chosen Option 1 — symmetric, no new module work):

1. **`extractColumnLevelUniqueConstraints(columnDef)`** (constraint-builder.ts) — mirrors the
   sibling CHECK/FK extractors but returns `AST.TableConstraint[]` (not schema objects), one
   single-column table-level UNIQUE per inline `unique` ColumnConstraint, preserving the
   constraint's name / `ON CONFLICT` / tags. (`buildUniqueConstraintSchema` reads only those
   fields + `columns[].name`.)

2. **`runAddColumn`** (alter-table.ts) — **after** `module.alterTable(addColumn)` materializes
   the column (so it resolves in `columnIndexMap`) and **before** the CHECK/FK merge + first
   `schema.addTable`, each inline UNIQUE is applied via
   `module.alterTable({type:'addConstraint', constraint})` — the **same** path `ADD CONSTRAINT …
   UNIQUE` uses. The returned schema (now carrying the column + unique constraint + memory
   covering index) is threaded into `updatedTableSchema` so the CHECK/FK merge layers on top.
   On failure the just-added column is dropped and the error rethrown (no catalog restore — the
   engine catalog is untouched at that point). Stale comment at the old extraction site fixed.

3. **`dropColumn` uniqueConstraint pruning** (memory `manager.ts` + store `store-module.ts`) —
   `dropColumn` previously filtered `indexes` over the dropped column but **left
   `uniqueConstraints` dangling** (an out-of-bounds column index). This surfaced in the
   combined-revert path (ADD COLUMN with both a UNIQUE that succeeds and a CHECK that then fails
   existing-row validation → existing revert calls `dropColumn` while the unique is live). Both
   `dropColumn`s now prune any UNIQUE referencing the dropped column (shifting indices for the
   rest); memory also clears the matching `implicitCoveringStructures` record. This is the fix
   that makes the combined revert leave **no orphan** in `index_info` / `unique_constraint_info`,
   and it also fixes the general `ALTER TABLE DROP COLUMN <uniquely-constrained-col>` case.

## How to verify / use cases (this is the test floor — extend it)

Build is required before store tests: store source is consumed as built `dist` in the harness
(`yarn build:engine && yarn build:store`), then `yarn test` (memory) / `yarn test:store`.

Behaviour now (memory **and** store), covered by `test/logic/41.3-alter-add-column-unique.sqllogic`:
- **Enforcement**: `add column u int unique` → duplicate insert rejected with `UNIQUE constraint failed`.
- **Introspection round-trip**: unnamed → `unique_constraint_info` row with `name=null, column_name='u'`; named (`constraint uq_sku unique`) → name round-trips.
- **NULLs distinct**: a nullable column over two existing-NULL rows → add succeeds; forward non-NULL duplicate rejected.
- **Literal-DEFAULT duplicate revert**: `add column u int default 5 unique` over ≥2 rows → fails `CONSTRAINT`; column + constraint + index all reverted; original schema usable.
- **Combined CHECK+UNIQUE revert**: single row, `add column u int default 0 check (u>0) unique` → UNIQUE materializes (1 row, no dup) then CHECK post-scan fails → full revert, no orphan in `unique_constraint_info` / `index_info`; re-adding with a CHECK-satisfying default then succeeds (proves no stale constraint/index lingers).
- **Phase 24** (`50-metadata-tags.sqllogic`): new `c5` case — a named inline UNIQUE on ADD COLUMN now round-trips its **name and constraint tag** through `unique_constraint_info` (closing the gap the prior comment described as "inline UNIQUE is dropped").

All green: engine+store `tsc --noEmit`; full `packages/quereus` memory suite; full store suite (`--store`); `@quereus/store` package tests (315); `@quereus/quereus` lint; documentation.spec. No `.pre-existing-error.md` needed (no pre-existing failures encountered).

## Honest gaps / things to scrutinize (treat tests as a floor)

- **`dropColumn` semantics change is broader than the literal ticket.** It now removes a UNIQUE
  that references the dropped column. For a **multi-column** UNIQUE that includes the dropped
  column, the **entire** constraint is dropped (a UNIQUE missing a column is a different,
  stronger constraint, not a silently-narrowed one). SQLite rejects dropping such a column
  outright; we permit it and drop the constraint. Confirm this is the desired behaviour. (Only
  single-column UNIQUE arises on the ADD COLUMN revert path itself; the multi-column case is
  reachable only via a standalone `DROP COLUMN`.) No dedicated test was added for the standalone
  multi-column DROP COLUMN case — **worth adding**.
- **`ON CONFLICT` on inline UNIQUE** (`add column u int unique on conflict replace`) is threaded
  through (`con.onConflict` → synthetic constraint → `defaultConflict`) but **not explicitly
  tested**. Recommend a test asserting the conflict action is honored on the ADD COLUMN path the
  same as on ADD CONSTRAINT.
- **Per-row (non-foldable) DEFAULT + CHECK on the same ADD COLUMN remains unsupported**
  (pre-existing restriction, docs/sql.md). This UNIQUE change does not lift it; with such a
  default the CHECK fails during the module backfill (inside `addColumn`) before the inline
  UNIQUE block runs, so that combination never reaches the UNIQUE path.
- **Store CHECK-persistence quirk (pre-existing, orthogonal, NOT touched):** the store keeps its
  in-memory table schema column-only on ADD COLUMN and persists CHECK/FK via a separate
  `persistedSchema`; a subsequent `addConstraint`'s `saveTableDDL` rebuilds DDL from the
  column-only in-memory schema (without that CHECK). This happens to make the combined revert
  clean (no dangling CHECK survives the dropColumn re-persist), but the addColumn-CHECK →
  addConstraint persistence interaction is its own latent inconsistency for CHECK across
  reconnect. Out of scope here; flag only.
- **Isolation overlays:** the store-mode tests exercise the isolated store module, so the
  isolation layer's `alterTable` overlay migration for the `addConstraint`/`dropColumn` cycle is
  covered indirectly, but there is no direct test of an ADD COLUMN inline UNIQUE landing while a
  connection holds staged overlay rows. Consider one.
