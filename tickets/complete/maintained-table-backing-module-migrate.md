description: Maintained-table backing-module migration — detect a declared backing-module change on a maintained table, route it to a destructive drop+recreate, and gate `apply` on `allow_destructive`. Closes the post-6.3 silent-no-op regression. REVIEWED.
files:
  - packages/quereus/src/schema/schema-differ.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/src/schema/catalog.ts
  - packages/quereus/src/runtime/emit/schema-declarative.ts
  - packages/quereus/test/declarative-equivalence.spec.ts
  - docs/materialized-views.md
  - docs/schema.md
  - docs/sql.md
----

# Complete: maintained-table backing-module change — surface + migrate (destructive, ack-gated)

The implementation detects a declared `using <module>(args)` change on a both-maintained
name-match (normalized via `normalizeBackingModuleName` / `canonicalBackingModuleArgs`),
routes it to a destructive `DROP TABLE` + `create materialized view … using <newmodule>`
(new incarnation), records it in `SchemaDiff.maintainedModuleMigrations`, and gates
`apply schema` on `options (allow_destructive = true)` (abort-before-DDL). `diff schema`
surfaces the DDL unconditionally. See the original implement handoff (commit
`e131cb4b`) for the full design rationale.

## Review findings

**Verdict: implementation is correct and ships. One major edge-case bug found and filed
as a separate fix ticket; one confirming test added inline; remaining flagged gaps
verified as acknowledged/out-of-scope.**

### Checked — clean

- **Diff routing & DDL ordering.** Verified `computeSchemaDiff` sets the
  `maintainedModuleMigration` signal in `computeTableAlterDiff` *before* the MV-sugar
  early-return (so both MV-sugar and declared-shape forms route), checks it first, adds
  the actual name to the shared `dropSet`, pushes the recreate, and `continue`s
  (suppressing the alter). `generateMigrationDDL` emits DROP (line ~2384) *before* table
  creates (line ~2399), so `DROP TABLE IF EXISTS mv` precedes `create materialized view
  mv … using mem2` — the same-name recreate ordering is correct.
- **Normalization symmetry.** `backingModuleDrifted` compares both sides through the same
  `normalizeBackingModuleName` (absent/`mem` ⇒ `memory`) + `canonicalBackingModuleArgs`
  (sorted-key render, absent ⇒ `''`) the live catalog uses; the live module is carried
  on `CatalogTable.maintained.backingModuleName/Args` via `maintainedDescriptor`. The
  three spellings of the memory default (`using memory()` / `using mem()` / omitted) do
  not register as drift — pinned green by the existing no-drift test.
- **require-hint accounting.** `maintainedModuleRecreates` is subtracted from both table
  create and drop counts, mirroring `viewRecreates` / `indexRecreates` — the deliberate
  recreate pair does not trip the unhinted-rename guard.
- **Apply gate.** `emitApplySchema` throws (naming the table(s), mentioning
  `allow_destructive`) when `maintainedModuleMigrations.length > 0 && !allowDestructive`,
  after `computeSchemaDiff` and before `generateMigrationDDL` — no partial migration.
  `emitDiffSchema` is correctly ungated (read-only preview). This is the first
  enforcement of the previously-parsed-but-unused `allowDestructive` option.
- **Lint / typecheck / tests.** `yarn typecheck` clean, `yarn lint` clean, full
  `yarn test` = **6011 passing, 9 pending, 0 failing** (6010 prior + 1 added below).
- **Docs.** `materialized-views.md`, `schema.md`, `sql.md` re-read end-to-end against the
  new reality — the "known gap" bullet is replaced with the detect+migrate+ack-gate
  description; the `allow_destructive` enforcement and `maintainedModuleMigrations` are
  documented accurately. No stale "out of scope / silent no-op" language remains.

### Found & fixed inline (minor)

- **Declared-shape maintained form was flagged untested ("correct by construction").**
  Verified it is reachable via `declare schema { table … using <mod> (cols) maintained
  as <body> }` (note: the declare-schema grammar puts `using` *before* the column list,
  unlike direct `create table … (cols) using <mod>` DDL). Confirmed end-to-end that the
  recreate renders `create table … using mem2 maintained as …`, carries the moved
  module, and re-materializes rows on a gate-on apply. **Added** a regression test
  (`a backing-module move on a DECLARED-SHAPE maintained table migrates …`) pinning the
  migration entry, the drop, the create-table-maintained-as recreate shape, and the
  applied live backing + rows. Passing.

### Found & filed as new ticket (major)

- **Rename + backing-module move in one apply emits conflicting DDL → hard apply
  failure.** When a maintained table is BOTH renamed (via a `quereus.previous_name`
  hint) AND has its backing module moved in the same re-declaration, the diff records
  both a table rename (`diff.renames`: `mv→mv2`) and a module-move drop+recreate. The DDL
  becomes `ALTER TABLE mv RENAME TO mv2; DROP TABLE IF EXISTS mv; create … mv2`, which
  fails with `Materialized view 'main.mv2' already exists`. The module-move branch does
  not account for the match being a rename match, and the rename op was already pushed in
  bulk before the loop. Not a safe inline fix — naive rename-suppression breaks dependent
  views (which reconcile against `tableRenames.renames` and rely on the RENAME primitive
  to retarget). Filed as **`tickets/fix/maintained-table-rename-and-module-move-conflict.md`**
  with the confirmed repro, root cause, and two resolution options (cooperate, or reject
  at diff time with a clear diagnostic). Exotic combination; pre-feature it silently
  ignored the module move, so this is a new fail-loud rather than a normal-path regression.

### Verified as acknowledged / out of scope (no action)

- **FK-parent maintained table recreate.** The source ticket noted a plain table FK-
  referencing the recreated maintained table could strand the FK across the
  drop+recreate. Exotic (maintained tables as FK parents are unusual); the drop flows
  through `orderDropsByFKDependency` like any other. Left as a documented limitation —
  not re-filed (already acknowledged upstream). If it later proves real, it belongs with
  the rename-conflict fix ticket's FK-aware recreate ordering.
- **`diff schema` direct row-assert.** No standalone `diff schema main` DDL-string
  assertion was added; it is covered indirectly by the diff-shape asserts plus the
  gate-on apply that executes the generated DROP + recreate. A direct assert would harden
  but adds little over the executed path — left as-is.
- **Store path (`yarn test:store`).** The differ/apply logic is store-agnostic; validated
  against the memory backend only, per the source ticket's out-of-band deferral. Not run
  here.
- **Plain-table `using` change stays undetected.** Intentional (plain tables track no
  backing module) and documented; confirmed no regression.
