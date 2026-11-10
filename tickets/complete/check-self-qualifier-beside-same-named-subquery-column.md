description: A CHECK or generated column whose subquery compares a column of the table to a same-named column of another table, such as `exists (select 1 from v where v.b = t.b)`, used to be accepted at CREATE TABLE and then make every write fail. That spelling now reaches the written row, as `new.b` already did.
architecture: docs/sql-ddl.md
files:
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # stripColumnQualifier, OwnRowNames, OWN_ROW_QUALIFIER doc, requalify docs/NOTE
  - packages/quereus/src/planner/building/constraint-builder.ts  # buildConstraintChecks: registerOwnRow, ownRowNames
  - packages/quereus/src/planner/building/generated-column-scope.ts  # OWN_ROW_QUALIFIER key, strip call
  - packages/quereus/test/logic/40.2-check-extras.sqllogic  # t_selfq_x, t_selfq_xd, t_selfq_gs, t_selfq_v (flipped), t_selfq_v2 comment
  - packages/quereus/test/logic/41-generated-column-scope.sqllogic  # § 15
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # SqVar
  - packages/quereus/test/schema/expr-scope-walk.spec.ts
  - packages/quereus/test/schema/clone-expr-isolation.spec.ts
  - docs/sql-ddl.md  # CHECK Constraints first bullet; generated-column spelling table
----

## What changed

Landed in `ticket(implement): check-self-qualifier-beside-same-named-subquery-column`.

Before compiling a CHECK or a generated-column body, the planner rewrites a self-qualified `<table>.<col>` / `<own-schema>.<table>.<col>` on a clone of the stored expression (`stripSelfQualifierInSchemaExpression`). It used to fold the name to the bare `<col>`, and inside a subquery whose FROM source might also have a `<col>` it asked the catalog and refused, so the name stayed qualified and every write failed with `<table>.<col> isn't a column`. It now folds a column to `__quereus_own_row__.<col>` (`OWN_ROW_QUALIFIER`), a key both row scopes register for every column (the CHECK scope for the image the operation judges: new for INSERT/UPDATE, old for DELETE). A qualified name cannot be captured by a subquery's source, so the catalog question and the `ResolveColumnInSource` parameter are gone from the strip. The strip now takes `OwnRowNames { columns, contextVariables? }`: a self-qualified name that is a context variable and not a column folds to `context.<name>`; a name that is neither is left as written. Inside a CTE body, derived-table body or nested INSERT/UPDATE/DELETE (barrier frames) every name is left qualified, as before.

## Review findings

**Diff read first, then the handoff.** All three source files, the docs hunk and the test changes were read in full.

**Correctness, checked by running code** (scratch scripts against `src` and against the pre-change `dist` build, deleted afterwards):
- Top-level `check (t.qty > 0)`: the failure message still renders the stored expression (`CHECK constraint failed: pos (t.qty > 0)`), not the folded one.
- `query_plan(...)` of an insert with a correlated CHECK subquery: the correlated `ColumnReference` detail prints `b`, not the internal qualifier. No other user-visible printing of the stripped AST was found.
- Subquery over a same-named table column: INSERT and UPDATE both accept/reject correctly; on `dist` both failed with `w.b isn't a column`.
- `group by <table>.<col>` inside a CHECK subquery: works. `select-aggregates.ts` builds qualified group keys from `expression.table`, and the fold produces a consistent `__quereus_own_row__.b` key.
- Own table re-selected in the subquery (`from s where s.b = 99`): the qualifier is rebound and left alone, same as `dist`. Aliased own table (`from u as u2 where u2.b = u.b`): `u.b` reaches the written row.
- CHECK over a column shadowed by a same-named context variable, self-qualified inside a subquery: reads the column.
- Generated columns: a subquery body over `sq.b` where `b` is itself generated gets the right evaluation order (the dependency collector in `generated-column-refs.ts` already classifies the qualified spelling as `'own'`, so it matches the new fold). Also checked: ADD COLUMN backfill of such a body, RENAME COLUMN rewriting it, and a later UPDATE.

**Found, pre-existing, filed:** a generated column added by `ALTER TABLE … ADD COLUMN` computes NULL on every later write once any column of the table is renamed (also reproduces with a plain `a + 100` body and on the pre-change build, so this ticket did not cause it). This is a silent wrong result, reachable in normal use, so it is filed as `tickets/fix/generated-column-null-after-add-column-then-rename-column.md` with a verified repro and a static guess at the site (`runRenameColumn` stores the module-returned schema without `withGeneratedColumnGraph`).

**Error handling / messages:** a self-qualified name that is neither a column nor a variable now errors as `nt.nosuch isn't a column` instead of `Column not found: nosuch`. Both name the problem. No test pins either message, and none was added, since message wording is not specified behaviour.

**Type safety, DRY, modularity:** `OwnRowNames` is a readonly interface. `ownRowNames` is built once per `buildConstraintChecks` call, outside the per-constraint loop. `registerOwnRow` keeps the registration of the bare and qualified keys in one closure, so they cannot drift apart. The deleted capture loop leaves `realSources` / `hasOpaque` in the frame model, and those are still used by `generated-column-refs.ts` and the scope-walk tests, so nothing is dead. No inline fixes were needed.

**Performance / resource cleanup:** the strip no longer queries the catalog per name. The per-build `Set` of column names in `generated-column-scope.ts` sits beside an existing `NOTE:` about re-stripping on every build, which already covers it.

**Tripwires:** the existing `NOTE:` on `OWN_ROW_QUALIFIER` (a user alias spelled `__quereus_own_row__` inside a CHECK subquery would capture the fold) now applies to every column, not only shadowed ones. It is still contrived, and the NOTE already names the revisit condition. Left as is. The narrowed `NOTE:` on `OwnRowContextVariables` (the existing-row scan rewrites inside CTE/derived bodies while the write path does not) is accurate.

**Tests:** all seven added or changed sqllogic cases are distinct behaviours: table source, DELETE image, function source (previously refused as opaque), the flipped view case, generated column, the variable fold branch, and the `SqCte` barrier case that was kept. None restates the implementation. The two spec edits only adapt to the new signature and output. None were cut and none added.

**Docs:** `docs/sql-ddl.md` (the CHECK bullet, the generated-column spelling table and § 2.6.2 on context variables), `docs/sql-alter.md` and `docs/sql-alter-rename.md` were read; they match the new behaviour. `docs/optimizer-fd.md`'s statement that the self-qualified spelling of a context-variable name is screened from fact extraction still matches `check-extraction.ts` (accepted-tradeoff NOTE there, not revisited).

**Out of scope, already tracked:** `bug-add-column-per-row-check-refuses-spellings-the-scan-accepts` (backlog), where ADD COLUMN compiles its CHECK without the strip. This change does not close it.

**Validation:** `yarn workspace @quereus/quereus run lint`: exit 0. `yarn test`: every workspace passes (quereus 11135 passing, 26 pending). `yarn test:store` was not run because no store-specific path changed.
