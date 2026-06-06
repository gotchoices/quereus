description: COMPLETE — `ALTER TABLE ADD COLUMN c <type> [CHECK (...) | REFERENCES parent(pk)]` now persists the column-level CHECK/FK into the store catalog DDL, so the constraint still enforces after `rehydrateCatalog`. Previously the store's addColumn arm persisted a column-only schema, so orphan/violating inserts were silently accepted on reopen. The shared AST→constraint extraction helpers were lifted out of the emit layer into `constraint-builder.ts` so the engine's live merge and the store's persisted set cannot drift.
files: packages/quereus/src/schema/constraint-builder.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/index.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-store/test/rehydrate-catalog.spec.ts
----

## What landed (implement)

### The persistence fix (store-module.ts, `alterTable` → `addColumn` arm)

The store's ADD COLUMN arm builds **two** schema values:

- `updatedSchema` — column-only, cached via `table.updateSchema(...)` and **returned** to the
  engine. It must stay column-only: the engine's `runAddColumn` re-merges the column-level
  FK/CHECK it extracts from the same `ColumnDef` into the LIVE in-memory `SchemaManager` *after*
  `alterTable` returns. Returning a constrained schema would merge a **second** copy (duplicate
  FK/CHECK live, and on the next persist, in the DDL).
- `persistedSchema` — `updatedSchema` plus the extracted column-level CHECK/FK merged into
  `checkConstraints` / `foreignKeys`. This is what `saveTableDDL(...)` serializes. The FK child
  column is resolved to `[updatedColumns.length - 1]` (the new column is appended last). The
  merge is **unconditional on the default kind** — extraction reads the AST constraints whether
  the DEFAULT folded to a literal or rides a per-row backfill evaluator. When the column declares
  no CHECK/FK, `persistedSchema === updatedSchema` (common path byte-for-byte unchanged).

No existing-row validation was added in the store — the engine's `runAddColumn` already runs
`validateForeignKeyOverExistingRows` / the CHECK post-scan against the live (un-folded) schema and
reverts on violation. The store's job here is **persistence only**.

### DRY: shared extraction helpers (constraint-builder.ts)

`extractColumnLevelCheckConstraints` / `extractColumnLevelForeignKeys` were **moved verbatim**
from `runtime/emit/alter-table.ts` into `schema/constraint-builder.ts` (the single source of truth
for AST→constraint-schema), re-exported through `packages/quereus/src/index.ts`, and imported by
both the engine emit layer and the store. Bodies unchanged — including the `fk.columns.length !==
1` mismatch error and the `columns: Object.freeze([])` caller-resolves contract. `opsToMask` and
the now-unused `ForeignKeyConstraintSchema` type import were dropped from `alter-table.ts`.

`generateTableDDL` / `emitTableConstraints` already serialize `checkConstraints` + `foreignKeys`
(including auto names `_check_<col>` / `_fk_<col>`), so no ddl-generator change was needed — the
fix is purely getting the constraints into the schema the store persists.

## Review findings

Adversarial pass over the implement diff (commit `84615b83`), read fresh before the handoff.

### Verified correct (checked, no change needed)

- **No-double-merge invariant.** Confirmed the store returns the **column-only** `updatedSchema`
  and only `saveTableDDL` ever sees the constrained `persistedSchema`. The engine merges the live
  copy in `runAddColumn` *after* `alterTable` returns; nothing feeds the persisted DDL back into
  the live schema in the same session. One FK/CHECK live, one in the DDL — no duplication.
- **Engine path behaviorally identical after the helper move.** Diffed the moved bodies against
  the originals — verbatim (FK count-mismatch error, `_check_`/`_fk_` auto-naming, the
  `columns: Object.freeze([])` caller-resolves contract all preserved). `find_references` confirms
  the helpers were never exported before the move, so no external caller/test referenced the old
  location. The 4853-passing engine run is the regression guard.
- **No dangling imports.** `find_references` for `opsToMask|ForeignKeyConstraintSchema` in
  `alter-table.ts` → zero hits; `RowConstraintSchema` is still imported (used by
  `validateBackfillAgainstChecks`). Lint + typecheck clean.
- **DDL round-trip is real.** Traced `generateTableDDL` → `emitTableConstraints` →
  `schemaConstraintToTableConstraint`: FK child columns are lifted from `c.columns` **indices**
  (hence the store's `[newColIdx]` resolution is load-bearing — an empty `columns` would mis-emit
  the FK), parent columns from `referencedColumnNames`. `referencedColumns` indices being unset on
  the persisted FK is harmless: DDL generation uses names, and rehydrate re-parses the full CREATE
  TABLE which re-resolves all indices.
- **Schema-name consistency.** Engine passes `tableSchema.schemaName`, store passes `schemaName` —
  the same value (schema of the altered child table). Cross-schema FK qualification is a
  pre-existing, documented fidelity gap (`schemaConstraintToTableConstraint`), not a regression.
- **Docs.** `docs/store.md` describes `rehydrateCatalog` and DDL-generation-from-schema generically
  and correctly; nothing claimed constraints are dropped, so no doc contradicted the new reality
  and no update was required. The behavior the docs imply (constraints persist) is now actually
  true for the ADD COLUMN path.

### Fixed inline (minor)

- **Validate-before-mutate ordering (store-module.ts).** The `extract*` helpers (which **throw** on
  a malformed multi-column column-level FK) ran *after* `migrateRows` + `table.updateSchema`. The
  engine guards this before ever calling `alterTable`, so it is unreachable via the normal path —
  but a direct `module.alterTable` caller would migrate rows and swap the in-memory schema, *then*
  throw. Hoisted both `extract*` calls to immediately after `updatedSchema` is built (before
  `migrateRows`), matching the engine's own validate-before-mutate ordering in `runAddColumn`. No
  behavior change on the common path; `persistedSchema` construction (needs `newColIdx`) stays
  after the migration. Typecheck + all store specs green after the reorder.
- **Test coverage closed (two of the implementer's flagged gaps).** Added to
  `rehydrate-catalog.spec.ts`:
  - *ADD COLUMN explicitly-named column-level FK survives reopen* — exercises the `con.name`
    branch of extraction (vs. the `_fk_<col>` auto-name) end-to-end; orphan rejected + valid
    accepted after reopen.
  - *ADD COLUMN with combined CHECK + FK survives reopen* — a single ADD COLUMN declaring both,
    exercising the store's two independent merge arms at once; CHECK arm (pref=0) and FK arm
    (pref=99, no parent) both reject after reopen, satisfying-both insert accepted.

  Both passed first run — confirming the named-constraint and combined-constraint paths round-trip
  correctly (no hidden bug behind the gaps).

### Filed as new ticket(s)

- None. No major findings — the implementation is correct, DRY, and the persistence path is sound.

### Accepted gaps (checked, not actioned — with reasons)

- **In-memory KV provider only.** New + existing reopen tests use `InMemoryKVStore`. The DDL
  serialize/reparse path is backend-agnostic and `yarn test:store` (full LevelDB logic suite) does
  not specifically target the rehydrate path, so a real LevelDB/IndexedDB round-trip adds little
  signal here for a serialize-only change. Consistent with the existing reopen-test pattern; a
  store full-run in CI remains advisable but is not agent-runnable inline (>10 min).
- **Column-level UNIQUE intentionally out of scope.** Not persisted via this path; the manager's
  existing inline-UNIQUE-on-ADD-COLUMN rejection handles it. Not a regression.
- **DEFAULT-expression preservation not asserted.** The per-row-default test asserts the FK
  persists and the DDL re-parses cleanly but does not assert the `default (new.id)` expression
  itself survives — orthogonal to this ticket (FK/CHECK persistence).

## Validation run (review)

- `yarn workspace @quereus/quereus run lint` → exit 0.
- `yarn workspace @quereus/quereus run build` → exit 0 (regenerates the `.d.ts` the store consumes).
- `yarn workspace @quereus/store run typecheck` → exit 0 (after the inline reorder).
- `rehydrate-catalog.spec.ts` → **14 passing** (12 prior + 2 new), 0 failing.
- `yarn workspace @quereus/store run test` (full store workspace) → **304 passing**, exit 0
  (the `boom` / `batch write failed` lines are deliberate fault-injection inside passing tests).
- `yarn test` (all workspaces) → engine **4853 passing / 9 pending**, all other workspaces green,
  `Done in 3m 20s` — confirms the helper move did not regress the engine ALTER suite.
