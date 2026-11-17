description: A column default that names a sibling column through its own table name, such as `default (t.b)`, used to be accepted when the table was created or altered and then broke every insert that used it. It is now refused when the default is declared, with a message pointing at `new.<column>`.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/manager.ts  # rejectUnresolvableQualifiedDefaultRefs (new, module-level), declaresMutationContext, rejectIllegalReferences (narrowed), validateOneDefault / validateDefaultDeterminism / validateAlterColumnDefault / validateAddColumnDefault / validateDdlDefault (now take TableSchema)
  - packages/quereus/src/schema/generated-column-refs.ts  # header comment only — classifier reused, not changed
  - packages/quereus/src/planner/building/alter-table.ts  # ADD COLUMN call site
  - packages/quereus/src/runtime/emit/alter-table.ts  # SET DEFAULT call site
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 31
  - packages/quereus/test/logic/03.4-defaults.sqllogic  # t_corr case
  - docs/sql-ddl.md  # Default Values bullets, §2.6.2 sentence
repro: verified
----

## What changed

At INSERT time a column DEFAULT can read only `new.<column>`, the table's mutation-context variables (bare `who` or `context.who`), and columns of a source that a FROM inside the DEFAULT selects from. The declaration-time gate used to miss qualified references on tables with a mutation context, and every qualified reference inside a subquery, so such defaults were stored and then failed every insert that used them.

`validateOneDefault` (manager.ts) now runs a second pre-walk, `rejectUnresolvableQualifiedDefaultRefs`, after the existing bind-parameter / bare-column one. It reuses the scope-aware classifier generated columns use (`collectGeneratedColumnRefs`), which tracks the FROM clauses of subqueries, and per qualified `column` reference:

- `context.<name>` (no schema) where `<name>` is a **declared** context variable → allowed. Checked before the binding, because on a table named `context` the classifier calls it an own-row reference.
- `'own'` binding with unschema'd qualifier `new` → allowed.
- `'own'` otherwise (`t.b`, `main.t.b`) → `DEFAULT for column 'c' in table 't' may not reference 't.b'; use 'new.<column>' …`.
- `'unbound'` (`zz.x`, `old.b`, undeclared `context.x`) → `DEFAULT for column 'c' in table 't' references 'zz.x', which binds nothing: …`.
- `'foreign'` / `'unknown'` → left alone; the existing build-deferral still applies.

The resolver passed to the classifier is a constant `() => false` (`unconsultedColumnResolver`): the classifier only consults it for unqualified names, which this gate ignores.

`rejectIllegalReferences`' column arm now rejects only **bare** names (it used to reject any non-`new` qualified name at depth 0 on no-context tables). Qualified names on no-context tables now get the more specific messages above. The bare-column message (`may not reference a bare column`) is unchanged; the CHECK caller passes `rejectColumns: false` and is unaffected.

Plumbing: rather than adding a schema-name parameter to five methods, the DEFAULT validators now take the owning `TableSchema` and derive name, schema name and the context flag from it (`declaresMutationContext`). Both ALTER call sites lost their duplicated `hasMutationContext` computation. The misplaced `validateDefaultDeterminism` doc comment (it sat above `defaultEmbedsSubquery`) was removed and the rules are now listed once on `validateOneDefault`.

## Beyond the ticket's spec (reviewer: confirm or revert)

The ticket said "`context.<name>` on a table that declares context → allowed". I narrowed that to **declared** variable names: `default (context.nope)` on a context table was verified to be accepted at CREATE and to fail at INSERT with `context.nope isn't a column` — same class, same site, and the gate now has the variable list in hand. Context variables can't change after CREATE (no ALTER path touches `mutationContext`), so the check can't go stale. Covered by the `DqUndeclared` line in Test 31.

## Verification

All rows of the ticket's reproduction table, plus `noctx d.b`, `noctx context.x` and `old.b`, were run against source with a scratch script (deleted) and are refused at declaration time; `ALTER TABLE … ADD COLUMN c … default (d.b)` now gets the `new.<column>` message instead of the incidental backfill error. These stayed legal and produce rows: bare `who` and `context.who` on a context table, `new.b`, `(select max(t.k) from t)`, the `coalesce((select max(rid) from t), 0) + mutation_ordinal()` allocator, and `new.b` inside a correlated subquery.

`yarn workspace @quereus/quereus test`: 11187 passing, 23 pending. `yarn workspace @quereus/quereus lint`: clean. `test:store` not run (the gate is engine-side, before any module call).

## Tests added

- `46-mutation-context.sqllogic` Test 31, context table: `default (DqSelf.b)` at CREATE → own-row message; `default (main.DqSchema.who)` (column and variable both `who`) → own-row message; `default (zz.x)` → unbound message; `default (context.whom)` with only `who` declared → unbound message; `alter … set default (DqAlter.b)` → own-row message (ALTER call site).
- Same test, table named `context`: `default (context.who)` is accepted and reads the variable (insert yields `c = 6` from the envelope while the column `who` is -1) — pins the "check `context.` before the binding" branch; `set default (main.context.who)` → own-row message.
- `03.4-defaults.sqllogic` `t_corr`: no-context table, `default ((select max(k) from t_corr_peer where k = t_corr.b))` → own-row message at CREATE (the correlated-subquery path the old depth-0 walk skipped).

## Known gaps / things to look at

- Only **qualified** references are judged. A bare name on a context table that is neither a variable nor a supplied column (`default (nope)` with context) is still deferred to INSERT, as before; out of this ticket's scope.
- `context.<name>` and `new.<name>` are matched by the lowercased `originalQualifier` string, which is `schema.table` when a schema is present. A quoted table name containing a dot that equals `new`/`context` after joining is theoretically confusable; not handled.
- A reference crossing an opaque source (CTE / subquery / table-valued function in a FROM inside the DEFAULT) classifies `'unknown'` and is still accepted, then judged at INSERT — the same conservative residual the generated-column analysis documents.
- Catalog reload doesn't run this gate (it lives in `createTable`, not `buildTableSchemaFromAST`), so a store holding such a default still opens; its inserts fail as before.
