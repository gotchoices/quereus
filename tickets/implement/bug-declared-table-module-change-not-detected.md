---
description: Changing the storage module named on an existing table in a schema declaration does nothing and reports nothing, and a maintained table declared without a module can be flagged as moving when it is not; both come from the schema comparison not knowing which module a declared table should be on.
architecture: docs/sql-ddl.md#diffing-and-applying
files:
  - packages/quereus/src/schema/schema-differ.ts        # computeSchemaDiff (table loop ~line 735), computeTableAlterDiff (~2348), backingModuleDrifted (~2957), movesBackingModule (~2900), applyTableDefaults (~1352), SchemaDiff.maintainedModuleMigrations (~121), TableAlterDiff.maintainedModuleMigration (~320)
  - packages/quereus/src/schema/catalog.ts              # CatalogTable (~35), maintainedDescriptor (~419), tableSchemaToCatalog
  - packages/quereus/src/schema/catalog-rendering.ts    # renderTable / renderMaintained — the unchanged-catalog fast path
  - packages/quereus/src/schema/view.ts                 # normalizeBackingModuleName, normalizeBackingModule, canonicalBackingModuleArgs
  - packages/quereus/src/runtime/emit/schema-declarative.ts  # the allow_destructive gate (~385) and its fast-path comment (~350)
  - packages/quereus/src/schema/manager.ts              # resolveModuleInfo (~1781): what a create with no `using` lands on
  - packages/quereus/test/declarative-equivalence.spec.ts    # existing maintained module-move tests (~1575-1760) to sit beside
  - docs/sql-ddl.md                                     # the allow_destructive bullet and the plain-table bullet after it (~235-249)
  - docs/schema-declarative.md                          # SchemaDiff.maintainedModuleMigrations bullet (~16), gating sentence (~18), fast-path soundness (~35)
  - docs/materialized-views.md                          # § Declarative-schema integration, if it names the field
repro: verified
---

# Declared module changes on tables are not compared consistently

## What was reproduced

Run as a throwaway mocha spec (deleted afterwards), with `db.registerModule('mem2', new MemoryTableModule())`.

**Arm 1 — a plain table's module is never compared.** All three of these produce an empty `computeSchemaDiff` (no alter, no drop, no create, no module migration), `diff schema main` returns no rows, and `apply schema main` succeeds with the table still on `memory`:

```sql
declare schema main { table t (id integer primary key) using memory }
apply schema main;
declare schema main { table t (id integer primary key) using mem2 }                        -- module name change
declare schema main { table t (id integer primary key) using memory (k = 'a') }            -- args-only change
declare schema main using (default_vtab_module = 'mem2') { table t (id integer primary key) }  -- schema-level default change
```

**Arm 2 — a maintained table declared without `using` reports a move that is not happening.** With `db.setOption('default_vtab_module', 'mem2')`:

```sql
declare schema main {
  table t (id integer primary key)
  table m (id integer primary key) maintained as select id from t
  materialized view mv as select id from t
}
apply schema main;
```

Live modules after apply: `t` → mem2, `m` → mem2, `mv` → memory. Re-diffing the unchanged declaration gives `tablesToDrop: ['m']` and `maintainedModuleMigrations: [{ name: 'm', fromModule: 'mem2', toModule: 'memory' }]`, so every later `apply schema` refuses with the allow_destructive error even though nothing changed. The same happens when the module comes from the schema's `using (default_vtab_module = …)` rather than the session option, because `backingModuleDrifted` reads the raw item `moduleName` and never applies the schema default that `freshTableCreate` applies at create time. This bites `yarn test:store`-style setups, where the session default is `store`.

## Root cause

One site: the differ has no single answer to "which module should this declared table be on". `backingModuleDrifted` answers it only for maintained-vs-maintained pairs and answers it as "absent ⇒ memory", which is right for `materialized view …` (its create path, `runtime/emit/materialized-view.ts`, uses `normalizeBackingModuleName`, so absent really is memory) but wrong for the table form (`table … maintained as` and plain tables), whose create path is `applyTableDefaults` (schema `default_vtab_module` / `default_vtab_args`) then `SchemaManager.resolveModuleInfo` (session `default_vtab_module` / args). Plain tables have no comparison at all, and `CatalogTable` carries no module for them (only `maintained.backingModuleName/Args`).

## Decided behaviour

**What a declaration pins.** The declared module of a table item is:

- the item's own `using <module> [(args)]` when present;
- else, for the table form (plain table or `table … maintained as`), the schema's `using (default_vtab_module = …, default_vtab_args = …)` when declared — i.e. exactly what `applyTableDefaults` produces;
- else, for `materialized view …` sugar, `memory` (unchanged — its create path ignores both defaults);
- else (table form, no `using` anywhere): **nothing is pinned** and the module is not compared. The table stays on whatever it is on.

The comparison uses the existing normalization (`normalizeBackingModuleName` for the name — lowercased, `mem` ⇒ `memory`; `canonicalBackingModuleArgs` for args, absent/`{}` ⇒ `''`). A live plain table's `vtabModuleName` is stored as typed, so lowercase it through the same normalizer.

Rejected alternative for the last case: comparing against the session `default_vtab_module`. It would make the result depend on a session option that is not persisted with the database, so reopening a store-backed database and forgetting to set the default before `apply schema` would flag every table as moving — refused without the ack, and dropped with it. An exported declaration (`exportSchemaDeclaration` omits `using` when it matches the session default) would also stop being portable between a memory-default and a store-default database. "Unpinned" keeps the export portable and needs no new input to `computeSchemaDiff`.

**What a detected change does.** Same as the existing maintained-table module move, extended to plain tables: drop + recreate in the declared module, surfaced unconditionally by `diff schema`, and refused by `apply schema` unless `options (allow_destructive = true)`. For a plain table this **loses the table's rows** (a maintained table is re-materialized from its body); the error message and docs must say so. Rejected alternatives: (a) copying rows across (create under a temporary name, `insert … select`, drop, rename) — dependents (FKs, views, CHECK reads) bind to the name across the drop, and migration steps are DDL only; out of scope, can be a later feature; (b) always refusing, with no way to carry it out — leaves the declaration permanently unsatisfiable short of manual DDL, while the ack-gated drop already exists and is documented.

**Representation.** Lift the module onto `CatalogTable` for every table (e.g. `module?: { name: string; args?: Record<string, SqlValue> }`, normalized via `normalizeBackingModule`, absent ⇒ default memory with no args — or always present; implementer's call), and drop `maintained.backingModuleName/Args` in its favour so there is one field for both kinds. `CatalogTable` changes are compiler-forced into `renderCatalogForComparison` (`catalog-rendering.ts`): render the module for every table. This is required for correctness, not just the build — without it, moving a table by direct DDL (`drop table t; create table t (…) using mem2`) leaves the catalog rendering unchanged and the apply fast path would skip a diff that now reports drift.

Generalize the diff field: `SchemaDiff.maintainedModuleMigrations` → e.g. `moduleMigrations: Array<{ name; fromModule; toModule; maintained: boolean }>` (and `TableAlterDiff.maintainedModuleMigration` likewise), so the apply gate in `schema-declarative.ts` covers both and its message can distinguish "rows are lost" from "re-materialized, new incarnation". `movesBackingModule` (the `existingColumnsByTable` pre-pass), `tablesRecreatedByModuleMove` (index recreates) and `maintainedModuleRecreates` (require-hint exclusion) already key on the drop+create pair by name and should work for plain tables once the detection feeds them; the "recreated object passes the drop guard" exception in `docs/schema-declarative.md` § Redefining what a rule reads is also name-keyed (`objectsRecreatedByDiff`). The table↔maintained transition (attach/detach) must still never count as a module move — keep that rule: compare modules only when both sides have the same kind, or, if the implementer prefers comparing across kinds too, make sure an attach/detach to the same module is not flagged.

## Things to check while implementing

- A plain table with a declared index, moved: the index is recreated after the drop (the maintained path already does this via `tablesRecreatedByModuleMove`).
- A child table whose foreign key references the moved table: does `DROP TABLE` on the parent succeed and the FK still resolve after the recreate? If the drop is refused, say so in the error rather than failing mid-apply (the gate runs before any DDL).
- The rename-coincident case (hinted rename + module move in one apply) is handled in the existing branch (`dropName`); confirm it works for a plain table.
- `yarn test:store` uses `default_vtab_module = 'store'`; arm 2 is exactly the shape that would misfire there. Running the store suite is optional (slow) but the session-default test below covers it in memory mode.

## Tests

Beside the existing maintained module-move tests in `declarative-equivalence.spec.ts` (they use `computeSchemaDiff` + `collectSchemaCatalog` directly). Keep it to:

- plain table `using memory` → `using mem2`: diff records the move (drop + create using mem2); `apply schema` without the ack throws naming the table and leaves it on memory; with `allow_destructive = true` it lands on mem2 and a re-diff is empty. Fold the args-only and schema-default variants in as extra declarations in the same test only if cheap.
- under `default_vtab_module = 'mem2'`, a plain table and a `table … maintained as` declared with no `using` re-diff empty after apply (arm 2 regression + the "unpinned" rule).

Update the existing maintained-table tests only as far as the renamed diff field requires.

## TODO

- Add a per-table module field to `CatalogTable` (fill in `tableSchemaToCatalog`, retire `maintained.backingModuleName/Args`), and render it in `catalog-rendering.ts`.
- Write one "declared module of a table item" helper in `schema-differ.ts` implementing the rule above (item `using` → schema default for table form → memory for MV sugar → unpinned), reusing `applyTableDefaults` for the schema-default step so create and compare cannot diverge.
- Replace `backingModuleDrifted` with a comparison that uses that helper and the catalog field, for plain and maintained tables alike; keep attach/detach out of it.
- Generalize `maintainedModuleMigrations` / `maintainedModuleMigration` (and their consumers, including `schema-declarative.ts`'s gate and its fast-path comment) to cover plain tables, with an error message that says a plain table's rows are lost.
- Add the two tests above; adjust existing tests for the renamed field.
- Docs: rewrite the `allow_destructive` bullet in `docs/sql-ddl.md` (~235) to cover plain tables and the row loss, replace the plain-table bullet (~249) with the "what a declaration pins" rule, and update `docs/schema-declarative.md` (~16, ~18, ~35) and `docs/materialized-views.md` where they name the field.
- `yarn workspace @quereus/quereus run lint` and `yarn test`.
