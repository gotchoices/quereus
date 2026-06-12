description: Review the maintained-table backing-module migration — detect a declared backing-module change on a maintained table, route it to a destructive drop+recreate, and gate `apply` on `allow_destructive`. Closes the post-6.3 silent-no-op regression.
files:
  - packages/quereus/src/schema/schema-differ.ts                    # detection + routing + new SchemaDiff/TableAlterDiff fields + renderFreshTableCreate helper
  - packages/quereus/src/schema/view.ts                             # normalizeBackingModuleName / canonicalBackingModuleArgs (pre-existing, now imported by differ)
  - packages/quereus/src/schema/catalog.ts                          # CatalogTable.maintained.backingModuleName/Args (pre-existing live side)
  - packages/quereus/src/runtime/emit/schema-declarative.ts         # emitApplySchema gate on allowDestructive; emitDiffSchema ungated
  - packages/quereus/test/declarative-equivalence.spec.ts           # flipped pins + gate-off/gate-on/idempotence/module+body tests (~line 1447–1660)
  - docs/materialized-views.md                                      # § Declarative-schema integration backing-module bullet
  - docs/schema.md                                                  # destructive-ack note + maintainedModuleMigrations
  - docs/sql.md                                                     # § 2.0 Safety — allow_destructive enforced for this case
difficulty: medium
prereq:
----

# Review: maintained-table backing-module change — surface + migrate (destructive, ack-gated)

## What changed (and why)

Pre-6.3, a standalone materialized view had its own diff bucket that drop+recreated to
migrate a changed backing module. After the unified-table refactor, a maintained table
is a TABLE, and a declared `using <module>(args)` change diffed **empty** — a silent
no-op regression. This restores the migrate behavior inside the unified table model:

- **Detect** the drift on a both-maintained name-match (live module is carried on
  `CatalogTable.maintained.backingModuleName` / `.backingModuleArgs`; declared on
  `tableStmt.moduleName` / `.moduleArgs`), normalized via `normalizeBackingModuleName`
  + `canonicalBackingModuleArgs` so the two spellings of the memory default never drift.
- **Migrate** via a destructive `DROP TABLE` + `create materialized view … using
  <newmodule>` (re-materializes the body into the new module, minting a new
  incarnation — `materialized_view_removed` then `_added`).
- **Gate** `apply schema` on `options (allow_destructive = true)`; abort (before any DDL
  runs) otherwise. `diff schema` surfaces the DDL unconditionally (read-only preview).

## Implementation summary

In `schema-differ.ts`:
- New `SchemaDiff.maintainedModuleMigrations: Array<{ name; fromModule; toModule }>`
  (interface + initializer).
- New `TableAlterDiff.maintainedModuleMigration?: { fromModule; toModule }` signal.
- `backingModuleDrifted(declaredMaintained, liveMaintained, declaredModuleName,
  declaredModuleArgs)` helper — fires only when BOTH sides maintained; returns
  normalized `from`/`to` labels (`name` or `name(args)`) on drift, else undefined.
  Called in `computeTableAlterDiff` **before** the MV-sugar early-return, so it is set
  for both the MV-sugar (column-less) and declared-shape (columns present) forms.
- `computeTableAlterDiff` sets the signal; `computeSchemaDiff`'s table loop checks it
  FIRST and routes the table to drop (actual name → shared `dropSet` →
  `orderDropsByFKDependency`) + recreate (`renderFreshTableCreate`) +
  `maintainedModuleMigrations` entry, then `continue`s — the alter diff is fully
  suppressed (the recreate subsumes any concurrent body/tag/shape op).
- `renderFreshTableCreate` factored out of the fresh-create branch and shared with the
  module-move recreate (MV-sugar → `createMaterializedViewToString`; else
  `createTableToString` with `maintained as`).
- `require-hint`: `maintainedModuleRecreates` counter subtracted from both table
  create/drop counts (mirrors `viewRecreates` / `indexRecreates`).
- Stale "module move out of scope" comments updated (computeSchemaDiff note +
  `applyMaintainedTransition` docstring).

In `schema-declarative.ts`: `emitApplySchema` throws a sited
`StatusCode.ERROR` mentioning `allow_destructive` and naming the table(s) when
`diff.maintainedModuleMigrations.length > 0 && !applyStmt.options?.allowDestructive`,
after `computeSchemaDiff` and before `generateMigrationDDL`. `emitDiffSchema` untouched
(no gate). `allowDestructive` was already parsed onto `ApplySchemaStmt.options` but
previously consumed nowhere — this is its first enforcement.

## Validation done

- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn workspace @quereus/quereus test` — **6010 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` — clean.

New/changed tests in `test/declarative-equivalence.spec.ts` (MV describe block):
- **Flipped** the two `… is NOT auto-detected (documented gap)` pins → now assert the
  drop+recreate is scheduled (`tablesToDrop = ['mv']`, `tablesToCreate` has the `mem2`
  recreate, `maintainedModuleMigrations` has one entry, no `mv` alter). One for the
  module-name move, one for the args-only move.
- **Kept** the `using memory()` / `using mem()` no-drift pin green.
- **Added** apply-gate-off: `apply schema main` over a module drift throws an
  `allow_destructive` error naming `mv`, and the live backing is unchanged
  (`backingModuleName` still undefined = memory default).
- **Added** apply-gate-on: `apply … options (allow_destructive = true)` migrates —
  captures schema-change events asserting `materialized_view_removed` then `_added`
  (new incarnation), rows re-derive from `t` into the new backing
  (`backingModuleName === 'mem2'`), and a subsequent re-diff is empty (idempotent).
- **Added** module + body changed together → exactly one migration, one drop+recreate,
  no separate `set maintained as`.

## Use cases for the reviewer to probe (tests are a floor, not a ceiling)

- **Declared-shape maintained form module move (UNTESTED — correct by construction).**
  Tests cover the MV-sugar form. A declared-shape maintained table (`create table … {
  columns } maintained as … using <mod>`) sets the same signal before the MV-sugar
  branch split and routes identically (recreate via `createTableToString`, alter fully
  suppressed → no orphaned column-alter ops). I reasoned this is correct but did not add
  a test (the declare-schema surface syntax for a declared-shape maintained table was
  not exercised here). Worth a confirming test if the reviewer can construct the form.
- **diff schema DDL shape.** No standalone `diff schema` row-assert was added; it is
  covered indirectly (the diff-shape asserts + the successful gate-on apply, which runs
  the generated `DROP TABLE IF EXISTS mv` + `create materialized view mv … using mem2`).
  A direct `diff schema main` row assertion would harden this.
- **FK-parent maintained table (exotic, NOT handled).** If a plain table FK-references
  the maintained table being recreated, the drop ordering could strand the FK. Noted as
  a limitation in the source ticket; not blocked on and not tested (maintained tables as
  FK parents are unusual). The drop flows through `orderDropsByFKDependency` like any
  other drop, but the recreate re-mints the table after dependents may have been
  considered — verify the reviewer agrees this is acceptable / out of scope.
- **store path.** Validated only against the memory backend (`yarn test`); the
  differ/apply logic is store-agnostic. `yarn test:store` is out-of-band per the ticket.
- **Plain-table module change stays undetected** (plain tables track no module) — this
  boundary is intentional and documented; confirm no regression there.

## Docs updated

- `docs/materialized-views.md` § Declarative-schema integration: the backing-module
  bullet now describes detection + destructive migrate + ack gate (vs the old "known
  gap").
- `docs/schema.md`: added `maintainedModuleMigrations` to the diff-types list and
  rewrote the destructive-ack note to point at this enforced case (other drops still
  ungated — general gate is future work).
- `docs/sql.md` § 2.0 Safety: `allow_destructive` promoted from "future" to
  enforced-for-this-case, with a worked refuse/ack example and the asymmetry note.
