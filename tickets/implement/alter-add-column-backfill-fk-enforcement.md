description: Validate existing (backfilled) rows against a column-level FOREIGN KEY added via ALTER TABLE ADD COLUMN, for every default kind. Today the new FK is merged into the table's constraint set for future INSERT/UPDATE only; existing rows whose backfilled value has no matching parent are silently admitted. Fix by running the engine's existing post-scan FK validator (`validateForeignKeyOverExistingRows`) once after the module appends the column, for both the literal-default and per-row (evaluator) default paths, reverting the column add on a violation — exactly mirroring the literal-default CHECK revert.
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/constraint-builder.ts, packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic, docs/runtime.md
----

## Problem

`ALTER TABLE … ADD COLUMN c <type> REFERENCES parent(pk) [DEFAULT …]` merges the
new column-level FK into the table's `foreignKeys` set (`runAddColumn` in
`runtime/emit/alter-table.ts`) so future INSERT/UPDATE enforce it — but the
**existing rows** are never validated against the parent. A backfilled value with
no matching parent row (and not NULL) is silently admitted, for **both** default
kinds:

- **Literal-default path** (`!backfill`): the post-`alterTable` scan only checks
  CHECK constraints (`validateBackfillAgainstChecks`), never FKs.
- **Per-row (evaluator) default path** (`backfill` present): the per-row hook
  enforces CHECK / NOT NULL but does no FK existence lookup.

Confirmed empirically against the current branch: both paths admit an orphan with
**no throw**; a NULL backfill is correctly admitted (MATCH SIMPLE).

## Expected behavior

Adding a column-level FK validates existing rows against the referenced parent the
same way a future INSERT would (MATCH SIMPLE synthetic `NOT EXISTS`): a fully
non-NULL backfilled value with no matching parent row aborts the ALTER and leaves
the table unchanged (column not added, catalog restored). A NULL backfilled value
satisfies the FK. No-op when `pragma foreign_keys` is off. Behavior is identical on
the memory and store modules (no module code changes).

## Resolved design

**Use one post-scan for both default kinds — do NOT put FK in the per-row hook.**

The engine already owns the canonical "validate existing child rows against a new
FK" primitive: `validateForeignKeyOverExistingRows(db, childSchema, fk)` in
`schema/constraint-builder.ts`. It is exactly what the `ALTER TABLE ADD CONSTRAINT
… FOREIGN KEY` path calls on both the memory module
(`vtab/memory/layer/manager.ts addForeignKeyConstraint`) and the store module
(`quereus-store/.../store-module.ts addConstraint`). It:
- is `pragma foreign_keys`-gated (no-ops when off),
- implements MATCH SIMPLE (only fully-non-NULL child rows can violate),
- handles the parent-absent case (any fully-non-NULL row is an orphan),
- is alias-correlated so a **self-referential** FK (parent == child) is correct,
- "does not take any module schema-change latch, so it is safe to call while a
  module holds its own schema-change lock" — i.e. it is designed as a post-scan,
  run after `module.alterTable` returns.

`runAddColumn` already builds `resolvedForeignKeys` (the new column-level FKs with
the child column index resolved against the freshly-returned schema) and registers
the enhanced schema with `schema.addTable(enhancedTableSchema)` **before** the
existing CHECK post-scan. The fix slots in right there: after schema registration,
for each `resolvedForeignKeys` entry, call
`validateForeignKeyOverExistingRows(rctx.db, enhancedTableSchema, fk)`; on throw,
revert (drop the column via `module.alterTable({type:'dropColumn'})` + restore the
original catalog entry with `schema.addTable(tableSchema)`) and rethrow — the same
revert the literal-default CHECK path already performs.

### Why a single post-scan, not the per-row hook the original ticket hinted at

The plan ticket suggested reusing the per-row backfill hook (as the CHECK work
did). That is the wrong shape for FK and was rejected after investigation:

1. **FK is a cross-table existence check, not a per-row predicate.** Enforcing it
   in the hook would require a parent lookup *per backfilled row* while the module
   holds the child's schema-change latch and is mid-tree-rebuild. For a
   **self-referential** FK the parent *is* the child being altered — querying it
   mid-alter is unsafe/inconsistent. The engine's whole FK-over-existing-rows idiom
   is deliberately a post-scan precisely to avoid this.

2. **The "stale snapshot" concern that justified the CHECK hook does not hold for
   FK here — verified empirically.** A throwaway probe confirmed that a
   post-`alterTable` `db.prepare(...)._iterateRowsRaw()` scan **sees the per-row
   (evaluator) backfilled values**, and a `NOT EXISTS` post-scan correctly flags
   the evaluator-path orphan. So the single post-scan is correct for the per-row
   default path too — no per-row hook needed. (The CHECK code's "stale" comment is
   over-cautious for this scan; leave it alone — CHECK enforcement is unaffected.)

3. **DRY.** Reusing `validateForeignKeyOverExistingRows` means the ADD COLUMN FK
   path and the ADD CONSTRAINT FK path can never drift, and the memory/store
   modules need no changes (the scan goes through `db.prepare`, backend-agnostic).

### FK schema shape compatibility (already correct)

`extractColumnLevelForeignKeys` builds each FK with `columns: []` (resolved to
`[newColIdx]` by the caller into `resolvedForeignKeys`), `referencedColumns: []`,
and `referencedColumnNames: fk.columns` (the parent column names from
`REFERENCES parent(col…)`, or `undefined` for a bare `REFERENCES parent`).
`validateForeignKeyOverExistingRows` resolves the parent columns via
`resolveReferencedColumns`, which uses `referencedColumnNames` when present and
**falls back to the parent primary key** otherwise — matching write-time behavior.
No FK-shape changes are required.

### Remove the stale FOLLOW-UP comment

The inline `FOLLOW-UP:` comment in `runAddColumn` (just above the
`mergedForeignKeys` construction) documents this exact gap. Delete it once the
validation is in place.

## Edge cases & interactions

- **Literal-default orphan** → abort, table unchanged (column not added, catalog
  restored). Verify a subsequent orphan INSERT still fails freely (FK was never
  installed) — mirrors the ADD CONSTRAINT "not installed" assertion.
- **Per-row (evaluator) default orphan** (`default (new.<col> + k)` that lands on a
  missing parent) → abort, table unchanged.
- **NULL backfill satisfies FK** (MATCH SIMPLE): `ADD COLUMN p int null
  REFERENCES parent` with no default (NULL backfill), or a default folding to NULL
  → allowed regardless of parent contents. (Note: a NOT NULL column with a nullish
  default is already rejected earlier by `validateNotNullBackfill`, so the NULL
  case only arises for a nullable column.)
- **All backfilled values satisfied** → ALTER succeeds; forward enforcement works
  (later orphan INSERT fails via the merged table-level FK).
- **`pragma foreign_keys = false`** → validator no-ops; the ADD COLUMN succeeds
  even over orphan data (parity with ADD CONSTRAINT's pragma-off behavior).
- **Parent table absent** → any fully-non-NULL backfilled row is an orphan ⇒ abort
  (validator's parent-absent branch). A NULL-only backfill still succeeds.
- **Self-referential FK** (`ADD COLUMN p int REFERENCES <same table>(pk)`): the
  validator's `_c`/`_p` aliasing keeps the correlation unambiguous; the post-scan
  (not a per-row hook) reads a consistent post-alter table. Cover the satisfied and
  orphan sub-cases.
- **Composite / named parent column** vs **bare `REFERENCES parent`** (PK fallback
  in `resolveReferencedColumns`) — both must validate. Column-level FK is always
  single-child-column (enforced upstream), so the parent side is one column.
- **Empty table** → backfill loop never runs, no rows to validate; ALTER succeeds;
  forward enforcement still installed. (Structurally identical to the empty-table
  CHECK case already covered.)
- **Revert atomicity** → on a violation the drop-column + catalog-restore must
  leave the table byte-identical to its pre-ALTER state (no lingering column, FK
  not in `foreignKeys`, forward INSERT of an orphan succeeds). Assert this
  explicitly, the same way the CHECK revert is trusted.
- **Cross-subsystem** → runs on both memory and store modules unchanged
  (`41.4` is re-run by `yarn test:store`); the validator is backend-agnostic.
- **Ordering vs CHECK** → keep the FK post-scan in the **same** try/revert region
  as the literal-default CHECK scan so that when both a new CHECK and a new FK
  exist and either fails, the single revert path fires. FK validation runs for all
  default kinds; the CHECK post-scan stays gated on `!backfill` (unchanged).

## Key tests (extend `test/logic/41.4-alter-add-column-constraints.sqllogic`)

Section 2 ("ADD COLUMN with REFERENCES") currently only asserts NULL backfill is
allowed and forward enforcement fires. Add orphan-rejection coverage:

- `add column … references parent(pid) default <orphan-literal>` over populated
  rows → `-- error:` (CONSTRAINT); then assert the column was NOT added (e.g.
  `select … ` still has the old shape / an orphan INSERT succeeds) — table unchanged.
- `add column … references parent(pid) default (new.a + <k>)` where the computed
  value misses the parent → `-- error:`; table unchanged.
- Satisfied literal and satisfied per-row default → ALTER succeeds; backfilled
  values present; forward orphan INSERT `-- error:`.
- Self-referential FK: satisfied case succeeds; orphan case `-- error:`.
- `pragma foreign_keys = false` wrapper: orphan ADD COLUMN succeeds (no scan).
- Parent-absent (drop/never-create parent): fully-non-NULL backfill → `-- error:`;
  NULL backfill → succeeds.

Expected outputs follow the file's existing `→ [...]` / `-- error:` conventions.
All cases run on memory (`yarn test`) and store (`yarn test:store`).

## TODO

- In `runAddColumn` (`runtime/emit/alter-table.ts`), after
  `schema.addTable(enhancedTableSchema)`, add an FK existing-row validation loop
  over `resolvedForeignKeys` calling `validateForeignKeyOverExistingRows(rctx.db,
  enhancedTableSchema, fk)`, inside a try that on throw reverts (drop column +
  `schema.addTable(tableSchema)`) and rethrows. Fold it into the same
  try/revert region as the existing literal-default CHECK scan so a single revert
  path serves both; run FK validation for **all** default kinds (do not gate on
  `!backfill`).
- Import `validateForeignKeyOverExistingRows` from `schema/constraint-builder.js`
  into `runtime/emit/alter-table.ts`.
- Delete the now-resolved inline `FOLLOW-UP:` comment in `runAddColumn`.
- Add the orphan-rejection / NULL-allowed / self-ref / pragma-off / parent-absent
  cases to `test/logic/41.4-alter-add-column-constraints.sqllogic` section 2.
- Update `docs/runtime.md` ALTER-TABLE validation section: document that a
  column-level FK added via ADD COLUMN now validates existing backfilled rows
  against the parent (MATCH SIMPLE, pragma-gated) via the shared post-scan
  validator, for both default kinds, reverting the column add on a violation.
- Validate: `yarn workspace @quereus/quereus run build` (exit 0),
  `yarn workspace @quereus/quereus run lint` (exit 0), `41.4` on memory and store,
  and the full memory logic suite (stream output with `tee`).
