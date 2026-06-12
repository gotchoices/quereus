description: Surface a backing-module (`using <module>(...)`/args) change on a maintained table and migrate the backing via a destructive drop+recreate, gated on the `allow_destructive` apply option. Closes the post-6.3 silent-no-op regression.
files:
  - packages/quereus/src/schema/schema-differ.ts                    # computeSchemaDiff table loop + applyMaintainedTransition: detect module drift, schedule drop+recreate, new SchemaDiff bucket; generateMigrationDDL needs no new verb (reuses drop table + create-MV render)
  - packages/quereus/src/schema/view.ts                             # normalizeBackingModuleName / canonicalBackingModuleArgs — the normalized comparison helpers (already exported)
  - packages/quereus/src/schema/catalog.ts                          # CatalogTable.maintained.backingModuleName/backingModuleArgs (already populated, normalized) — the live side of the compare
  - packages/quereus/src/runtime/emit/schema-declarative.ts         # emitApplySchema: gate on applyStmt.options.allowDestructive; emitDiffSchema: surface only (no gate)
  - packages/quereus/src/parser/ast.ts                              # ApplySchemaStmt.options.allowDestructive (already parsed; currently unenforced)
  - packages/quereus/test/declarative-equivalence.spec.ts           # flip the two "NOT auto-detected (documented gap)" pins (~1447, ~1505); keep the using memory() no-drift pin (~1479)
  - docs/materialized-views.md                                      # § Declarative-schema integration "Backing-module change (known gap)" (line ~658)
  - docs/schema.md                                                  # § Declarative Schema destructive-ack note (line ~566)
  - docs/sql.md                                                     # § 2.0 allow_destructive — promote from "future" to enforced-for-this-case
difficulty: medium
prereq:
----

# Maintained-table backing-module change: surface + migrate (destructive, ack-gated)

## Goal

A declared backing-module change on a maintained table (`materialized view m using
<module>(args) as …`, or the `create table … maintained as … using <module>` form)
currently diffs **empty** — a silent no-op regression from the pre-6.3 standalone-MV
bucket, which drop+recreated to migrate the backing. Restore the migrate behavior
inside the unified table model: **detect the drift, schedule a destructive
drop+recreate that re-materializes the backing into the newly declared module, and
refuse to execute it on `apply` unless the user acknowledges via `allow_destructive
= true`.** `diff schema` surfaces the migration DDL unconditionally (it is a
non-executing preview).

This was triaged (human sign-off, in the source plan ticket): **surface + migrate,
behind the destructive-change acknowledgement.**

## Why this is destructive (and distinct from a re-attach)

A body change with an unchanged shape is a *content refresh* — `alter table … set
maintained as <body>`, which preserves the table's physical [backing-host]
incarnation and unrelated rows' identity (non-destructive). A **backing-module move**
physically relocates the table to a different store module; there is no in-place move
primitive, so it is realized as `drop table` + `create materialized view … using
<newmodule>`, which **mints a new incarnation** (fires `materialized_view_removed`
then `materialized_view_added`). For a replicated/synced table this changes row
identity — exactly why it must be opt-in and clearly distinct from the body re-attach.

## Design (resolved)

### 1. Detect drift in the differ

A maintained table is name-matched into `computeTableAlterDiff` /
`applyMaintainedTransition` (`schema-differ.ts`). The live backing is on
`CatalogTable.maintained.backingModuleName` / `.backingModuleArgs` (already produced
by `normalizeBackingModule` in `catalog.ts` — absent ⇒ memory default). The declared
backing is on `declaredTable.tableStmt.moduleName` / `.moduleArgs` (both the MV-sugar
and `create table … maintained as` forms land their `using` clause there;
`materializedViewToDeclaredTable` threads it from `mv.moduleName`/`mv.moduleArgs`).

Compare **only when both sides are maintained** (a table↔maintained transition is an
attach/detach, never a module move). Use the same normalization the pre-6.3 MV loop
did — `normalizeBackingModuleName(name)` (absent/`mem` ⇒ `memory`, lowercased) for the
name and `canonicalBackingModuleArgs(args)` (stable sorted-key render, absent ⇒ `''`)
for the args, both exported from `schema/view.ts`:

```
backingModuleDrifted =
     normalizeBackingModuleName(declared.moduleName)        !== normalizeBackingModuleName(live.backingModuleName)
  || canonicalBackingModuleArgs(declared.moduleArgs)        !== canonicalBackingModuleArgs(live.backingModuleArgs)
```

This is the **incarnation-minting** signal. The module is deliberately NOT folded into
`bodyHash` (catalog.ts already keeps it separate), so the body re-attach path is
untouched.

### 2. Schedule a drop+recreate (not an alter)

When `backingModuleDrifted` on a name-matched maintained table, in `computeSchemaDiff`'s
table create/alter loop:

- Push the **actual** table name into the drop set (so it flows through
  `orderDropsByFKDependency` like any other drop) — realized as `DROP TABLE IF EXISTS
  <name>`. `emitDropTable` already drops a maintained table's derivation cleanly
  (`dropMaintainedTable`, fires `materialized_view_removed`), so **no separate `drop
  maintained` detach is needed** — the triage's "drop-maintained → drop" was
  over-specified; plain `DROP TABLE` is the undeclared-MV-drop path and suffices.
- Push the **recreate DDL** into `tablesToCreate`, rendered by the SAME fresh-create
  branch used for a brand-new maintained table (lines ~466–472:
  `createMaterializedViewToString(declaredMv.viewStmt)` for the sugar form, else
  `createTableToString(effectiveStmt)` which carries the `maintained as` clause). The
  recreate re-materializes the body into the new module. Factor that fresh-create
  rendering into a small helper so the module-move path and the create path share it.
- **Do NOT push a `TableAlterDiff`** for this table — the recreate subsumes any
  concurrent body / tag / shape change (the recreate carries the new body + new tags).
- Record the migration in a new `SchemaDiff` bucket for gating + diagnostics:
  `maintainedModuleMigrations: Array<{ name: string; fromModule: string; toModule: string }>`.

Drops run before creates in `generateMigrationDDL`, and the body's source tables are
not dropped, so `DROP TABLE m` → `create materialized view m as <body> using <new>`
converges: the name is freed, then re-created and re-materialized against live sources.

### 3. require-hint exclusion

A same-name drop+create would trip the `require-hint` table guard
(`enforceRequireHint('table', tablesToCreate.length, tablesToDrop.length)`). A
module-move is a deliberate recreate of a matched object, not an ambiguous unhinted
rename — exclude it from both counts, exactly as `viewRecreates` / `indexRecreates`
already do. Track a `maintainedModuleRecreates` count and subtract it from both
arguments.

### 4. Acknowledgement gate (apply only)

In `emitApplySchema` (`schema-declarative.ts`), after `computeSchemaDiff` and before
`generateMigrationDDL`/`runBatchedMigrationLoop`:

```
if (diff.maintainedModuleMigrations.length > 0 && !applyStmt.options?.allowDestructive) {
  throw new QuereusError(
    `apply schema '${schemaName}': backing-module change on maintained table(s) ` +
    `${names} is destructive (drop + recreate, new incarnation). ` +
    `Re-run with options (allow_destructive = true) to migrate the backing.`,
    StatusCode.ERROR);
}
```

`allowDestructive` is already parsed onto `ApplySchemaStmt.options.allowDestructive`
(parser.ts ~3885) but currently consumed nowhere — this wires it up for this case.
`emitDiffSchema` does **not** gate: `diff schema` is a read-only preview and should
show the full `DROP TABLE …` / `create materialized view …` DDL so the user sees what
`apply` would do.

> Scope note: a *general* `allow_destructive` gate over all drops remains future work
> (docs/todo.md already lists it). This ticket enforces the flag specifically for the
> incarnation-minting maintained-table backing-module move, which is the uniquely
> dangerous case for replicated/synced tables (the motivation in the source ticket).
> Other drops stay ungated for now — document this asymmetry in sql.md.

### 5. Idempotence

Both spellings of the memory default must produce an empty diff: declared `using
memory()` / `using mem()` / `using memory` / omitted, against a default-backed live
table. `normalizeBackingModuleName` maps all of those to `memory`, and the live
`backingModuleName` is `undefined` (also → `memory`); args both render `''`. So no
drift, no migration entry. (This is the existing "no-drift" pin at ~line 1479 — keep
it green.) An explicit `using memory(k='a')` with non-empty args round-trips: the live
side stores `backingModuleName='memory'`, `backingModuleArgs={k:'a'}`, and the declared
side normalizes to the same — no churn; only a real arg change drifts.

## Edge cases & interactions

- **Idempotence after migrate.** After an acknowledged migrate, re-applying the same
  declaration (`using mem2()` now matching the live `mem2` backing) must diff empty —
  no second drop+recreate. Verifies the live catalog re-imports the new module.
- **Explicit-default vs default-backed (no drift).** `using memory()`/`using mem()`/
  omitted against a default-backed table ⇒ empty diff (§5). Pin retained.
- **Args-only change.** `using mem2(k='a')` → `using mem2(k='b')` drifts on the args
  half alone (name unchanged) ⇒ migrate. (Flip the existing args-gap pin at ~1505.)
- **Module + body changed together.** When both the backing module AND the body drift
  in one re-declaration, the table takes the drop+recreate (new module + new body);
  assert NO separate `set maintained as` re-attach is also emitted for it (the recreate
  subsumes it) and the migration appears once.
- **Module + concurrent shape change.** A declared-shape maintained table (columns
  present) whose module moves recreates via the create rendering (body owns the final
  shape); confirm no orphaned column-alter ops are emitted alongside the recreate.
- **Gate off ⇒ no execution.** `apply` without `allow_destructive` raises the sited
  error and performs NO partial migration (the whole apply aborts before the migration
  loop) — assert the live backing is unchanged after the rejected apply.
- **Gate on ⇒ full migrate.** `apply … options (allow_destructive = true)` executes the
  drop+recreate; assert `materialized_view_removed` then `materialized_view_added` fire
  (new incarnation), the rows re-materialize from current sources, and the new module
  is the live backing.
- **diff schema surfaces unconditionally.** `diff schema` over a module drift returns
  the `DROP TABLE IF EXISTS m` + `create materialized view m … using <new>` rows with
  no options/ack required.
- **table↔maintained transition is NOT a module move.** A plain-table→maintained attach
  (or maintained→plain detach) must still take the attach/detach path even if a `using`
  clause appears — module comparison only fires when BOTH sides are maintained.
- **Plain-table module change stays the documented gap.** A `using` change on a
  non-maintained table remains undetected (plain tables track no module) — only
  maintained tables get this treatment. Keep that boundary explicit.
- **require-hint policy.** Under `rename_policy = 'require-hint'`, a module-move recreate
  must NOT trip the unhinted-rename guard (excluded from the table create/drop counts).
- **FK-parent maintained table (exotic).** If a plain table FK-references the maintained
  table being recreated, the drop ordering could strand the FK; maintained tables as FK
  parents are unusual. Note the limitation; do not block on it (no test required unless
  trivially constructible).

## Key tests (TDD targets)

In `test/declarative-equivalence.spec.ts` (alongside the existing maintained-table
backing-module block, ~lines 1447–1531):

- **Flip** `a backing-module change on a maintained table is NOT auto-detected
  (documented gap)` → assert the diff now schedules the drop+recreate
  (`diff.tablesToDrop` contains `mv`, `tablesToCreate` contains a `using mem2` recreate,
  `diff.maintainedModuleMigrations` has one entry, and `tablesToAlter` has no `mv`).
- **Flip** `a backing-module ARGS change … is NOT auto-detected` → same shape, args-only
  drift.
- **Keep** `declaring using memory() / using mem() against a default-backed MV is
  no-drift` unchanged (must stay green).
- **Add** apply-gate-off: `apply schema main` (no options) over a module drift throws a
  sited error mentioning `allow_destructive`; the live backing is unchanged afterward.
- **Add** apply-gate-on: `apply schema main with`/`options (allow_destructive = true)`
  migrates — capture schema-change events to assert `materialized_view_removed` +
  `materialized_view_added` (new incarnation), rows re-derived, new module live, and a
  subsequent re-diff is empty (idempotent).
- **Add** module + body changed together: one drop+recreate, no separate re-attach.

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mv-mod.log; tail -n 80
/tmp/mv-mod.log` and `yarn workspace @quereus/quereus lint`. (The store path is not
required here — the differ/apply logic is store-agnostic; `yarn test:store` is
out-of-band.)

## Docs

- `docs/materialized-views.md` ~line 658: rewrite the "Backing-module change (known
  gap)" bullet — it is now **detected and migrated** via a destructive drop+recreate,
  gated on `allow_destructive`, distinct from the non-destructive body re-attach.
- `docs/schema.md` ~line 566: the destructive-ack note now points at a real enforced
  case (the maintained-table backing-module move); keep the cross-ref to sql.md.
- `docs/sql.md` ~lines 217/247–249: `allow_destructive` is no longer purely "future" —
  it is enforced for the maintained-table backing-module migration. Document that other
  drops remain ungated for now (the general gate is still future work).

## TODO

- Add `maintainedModuleMigrations` to the `SchemaDiff` interface + initializer.
- Add a `backingModuleDrifted` helper (differ-local) over `normalizeBackingModuleName`
  + `canonicalBackingModuleArgs` (import from `schema/view.js`).
- In `applyMaintainedTransition` (or the table loop), detect module drift on a
  both-maintained name-match and signal it (flag on the alter diff, or return signal)
  so `computeSchemaDiff` routes the table to drop+recreate instead of an alter.
- Factor the fresh-create rendering (sugar MV vs `create table … maintained as`) into a
  helper; call it for the module-move recreate.
- Route the module-move into `tablesToDrop` (actual name) + `tablesToCreate` (recreate)
  + `maintainedModuleMigrations`; suppress the alter for that table.
- Exclude module-move recreates from the `require-hint` table create/drop counts
  (`maintainedModuleRecreates`).
- Gate `emitApplySchema` on `applyStmt.options?.allowDestructive`; leave
  `emitDiffSchema` ungated.
- Flip the two pinning tests; keep the no-drift pin; add the apply-gate + migrate +
  idempotence tests.
- Update `materialized-views.md`, `schema.md`, `sql.md`.
- `yarn workspace @quereus/quereus test` + `lint` green.
