description: Review the fix for non-idempotent `apply schema` under a non-BINARY `default_collation` when ADDing a column. Two composable fronts landed: (A) the declarative differ emits an explicit resolved `COLLATE` for added columns, and (B) the execution-layer ADD COLUMN path (memory/store/isolation) honors the session `default_collation`. RENAME COLUMN deliberately stays BINARY-resolving (derived-DDL path) and was NOT touched.
files: packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/logic/43.1-default-collation.sqllogic, docs/schema.md
----

## What was wrong (recap)

`default-collation-pragma` made the differ resolve an omitted `COLLATE` on the *declared* side
via the live `default_collation`, but the ADD COLUMN paths still resolved an omitted `COLLATE` to
fixed `BINARY`. So an `apply schema` that needed to *add* a text column under
`default_collation = nocase` created the column as `BINARY`, while the declared side resolved to
`NOCASE` — every re-apply emitted a spurious `ALTER TABLE … SET COLLATE NOCASE`. Non-idempotent.

## What changed (both A and B landed, as the ticket specified)

**A — differ emits explicit resolved COLLATE for added columns**
(`schema-differ.ts`). New helper `withResolvedAddColumnCollation(col, defaultCollation)`: for an
added column with **no** explicit `collate` constraint whose
`resolveDefaultCollation(inferType(col.dataType), defaultCollation) !== 'BINARY'`, it returns a
**clone** (never mutates the declared AST — clones the `constraints` array) with an explicit
`{ type: 'collate', collation: <resolved> }` appended, then `columnDefToString`s it. The
`columnsToAdd` loop now routes every added column through this helper. This makes emitted ADD
COLUMN DDL self-contained (portable across sessions with different defaults) and restores
idempotency at the emit layer regardless of B.

**B — execution layer honors `default_collation` on ADD COLUMN only**. Threaded
`db.options.getStringOption('default_collation')` as the 3rd arg of `columnDefToSchema` at the
three ADD COLUMN sites:
- memory `manager.ts` `addColumn` (line ~1425)
- store `store-module.ts` `addColumn` case (line ~702)
- isolation `isolation-module.ts` `deriveAddColumnBackfill` (line ~900) — symmetry only; this site
  reads only `.notNull`/`.name`, the underlying memory/store table materializes the real column.

`resolveDefaultCollation` type-gates non-text types to `BINARY`, so a non-text ADD COLUMN under a
non-BINARY default is automatically correct.

**RENAME COLUMN explicitly left alone** (the CRITICAL CORRECTION in the source ticket). Both rename
sites (`manager.ts:1606`, `store-module.ts:884`) still call `columnDefToSchema(def, defaultNotNull)`
(no 3rd arg → defaults to `'BINARY'`). RENAME COLUMN reconstructs its AST from the live column via
`buildConstraintsFromColumn`, which appends an explicit `COLLATE` ONLY for non-BINARY columns — so a
renamed NOCASE column carries explicit `COLLATE NOCASE` (preserved), and a renamed BINARY column
carries none (genuinely BINARY). Threading the default there would silently flip an existing BINARY
column to NOCASE on rename — a regression. **Verify the reviewer agrees this carve-out is correct.**

## Why the two fronts don't conflict

On the differ path, A emits `ADD COLUMN extra TEXT COLLATE NOCASE`; the execution layer honors the
explicit COLLATE, so B's omitted-COLLATE fallback is never exercised there (no double-apply). On the
direct user `ALTER TABLE … ADD COLUMN c TEXT` path (no COLLATE), B resolves it to match a CREATE-d
column. Verified that `runAddColumn` (`emit/alter-table.ts`) returns the schema produced by
`module.alterTable` (the vtab `addColumn`) and spreads it into the engine catalog — no
re-resolution to BINARY at the engine layer.

## Use cases to validate / review focus

1. **The original repro (idempotency):** `default_collation = nocase`; live `create table t (id …,
   name text)`; `declare schema main { … name TEXT, extra TEXT }`; `apply schema main` → `extra`
   lands `NOCASE`, re-diff `tablesToAlter === []`. (Test: "an apply that ADDs a text column under
   nocase lands NOCASE and re-diffs empty".)
2. **Type-gate:** same but `extra INTEGER` → lands `BINARY`, re-diff empty.
3. **RENAME guard:** under nocase, `create table t (… b text collate binary, c text collate nocase)`;
   rename both → `b` stays `BINARY`, `c` stays `NOCASE`.
4. **Direct ALTER + store round-trip (sqllogic `43.1`, also run under `test:store`):**
   `alter table t_add add column name text` → NOCASE comparison semantics; `add column qty integer`
   → BINARY. Store mode exercises the store `addColumn` path + a persisted-DDL reopen implicitly.

## Validation performed (all green)

- `yarn workspace @quereus/quereus run build` → EXIT 0; store + isolation builds → EXIT 0.
- `yarn workspace @quereus/quereus run test` (memory): **5406 passing**, 9 pending, EXIT 0.
- Targeted spec-reporter run of the `default_collation` block: all new cases pass.
- `yarn workspace @quereus/quereus run lint`: clean (only quereus has a lint script).
- `node packages/quereus/test-runner.mjs --store` (LevelDB store mode): **5401 passing**, 14
  pending, EXIT 0, ~3m (well under the idle limit).
- `yarn workspace @quereus/isolation run test`: 126 passing. `yarn workspace @quereus/store run
  test`: 382 passing (trailing "Failed to rehydrate DDL" lines are a deliberate negative test).
- `docs/schema.md` collation paragraph updated to document ADD COLUMN now honoring the default and
  RENAME COLUMN deliberately not.

## Known gaps / things a reviewer should probe (tests are a floor, not a ceiling)

- **Cross-session portability is asserted structurally, not by an explicit test.** A migration
  emitted under `nocase` now always carries an explicit `COLLATE` (front A), so executing it under a
  `BINARY` session must still land `NOCASE`. There is no test that literally emits under one default
  and executes under another. Low risk (the explicit COLLATE wins in `columnDefToSchema`), but worth
  a dedicated assertion if the reviewer wants belt-and-suspenders.
- **Only NOCASE exercised for ADD COLUMN.** `default_collation = rtrim` follows the identical code
  path (text supports RTRIM) but is not separately tested on the ADD COLUMN path.
- **JSON/temporal ADD COLUMN under a non-BINARY default** falls back to BINARY (empty
  `supportedCollations`); covered for CREATE in `43.1` but not specifically for ADD COLUMN
  (INTEGER is the only non-text ADD COLUMN case tested). Same `resolveDefaultCollation` gate, so
  behavior is implied, not directly asserted.
- **isolation threading is inert by design** — confirm the reviewer is comfortable that threading
  `default_collation` into `deriveAddColumnBackfill` is harmless symmetry (it only reads
  `.notNull`/`.name`); the underlying memory/store table is what actually materializes the column's
  collation.
- The store-mode test output ends with a stack trace from a negative rehydrate test
  (`THIS IS NOT VALID SQL`); EXIT 0 confirms it is expected, but a reviewer skimming the log might
  mistake it for a failure.
