description: A CHECK or generated column whose subquery compares a column of the table to a same-named column of another table, such as `exists (select 1 from v where v.b = t.b)`, used to be accepted at CREATE TABLE and then make every write fail. That spelling now reaches the written row, as `new.b` already did; review the change.
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

Before compiling a CHECK or a generated-column body, the planner rewrites a self-qualified `<table>.<col>` / `<own-schema>.<table>.<col>` on a clone (the "strip", `stripSelfQualifierInSchemaExpression`). It used to fold the name to the bare `<col>`. Inside a subquery whose FROM source might also have a `<col>`, it asked the catalog and refused, so the name stayed qualified and nothing resolved it. It now folds every column to `__quereus_own_row__.<col>` (`OWN_ROW_QUALIFIER`). Both row scopes register that key for every column. The CHECK scope registers it for the image the operation judges (new for INSERT/UPDATE, old for DELETE), beside the bare key, which is still left out for a column a mutation-context variable shadows. The generated-column scope registers it beside the bare and `new.` keys. A qualified name cannot be captured by a subquery source, so no catalog question remains. The capture loop (`realSources` / `hasOpaque` scan) and the `ResolveColumnInSource` parameter are gone from the strip; `realSources` stays in the frame model for `generated-column-refs.ts`.

The `hasBarrierFrame` stop now applies to every name. Inside a CTE body, a derived-table body or a nested INSERT/UPDATE/DELETE the name stays qualified and fails as before (`SqCte` in `46-mutation-context.sqllogic` still pins this).

### Deviation from the ticket: the strip takes the table's names instead of nothing

The ticket said to drop the resolver parameter and fold every self-qualified name. That would have broken two cases measured on the pre-change `dist` build, so the resolver was replaced by `OwnRowNames { columns, contextVariables? }`:

- **A self-qualified name that is a context variable and not a column reads the variable** (documented in `docs/sql-ddl.md` § 2.6.2). Example: `check (exists (select 1 from xv where xv.b = vo.ghost)) with context (ghost …)` worked before because the bare `ghost` was not captured. Folding it to the reserved qualifier would fail. It now folds to `context.<name>`, the same as the existing-row scan's `requalifyOwnRowRefsInSchemaExpression`. That also fixes the case the old NOTE on `OwnRowContextVariables` described: a subquery source has a column named like the variable (`SqVar` test), which used to fail every write and now reads the variable. The NOTE was narrowed to the remaining divergence: the scan rewrites inside CTE/derived bodies and the write path does not.
- **A self-qualified name that is neither a column nor a variable** would have produced `Column not found: __quereus_own_row__.nosuch`. It is now left as written, so the error reads `nt.nosuch isn't a column`. Before this change it read `Column not found: nosuch`. No test asserted either message.

Step order in `stripColumnQualifier`: sealed frame → unqualified → rebound qualifier → not the owning table or schema → `context.<variable>` with no schema on a table named `context` (now any variable, not only shadowed columns, which is equivalent) → barrier → fold: a column goes to `OWN_ROW_QUALIFIER`, a variable to `context`, anything else is left.

## Validation

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn test`: all workspaces pass (quereus 11135 passing, 26 pending). `yarn test:store` was not run, since nothing store-specific is involved.
- I ran the ticket's repro shapes on the pre-change `dist` build and on the changed source (a scratch script, not committed). Before: `x.b isn't a column`, `No row context found for column b` (DELETE), `gs.b isn't a column`, `sq.b isn't a column` (generated), `vo.ghost isn't a column`. After: each accepts or refuses on the CHECK.

## Tests added or changed

- `40.2-check-extras.sqllogic` `t_selfq_x`: `exists (select 1 from t_selfq_xv where t_selfq_xv.b = t_selfq_x.b)`. A matching insert is accepted; a non-matching one fails `known_b`.
- `40.2` `t_selfq_xd`: the same shape on `check on delete`. Deleting a matching row passes; a non-matching one fails `del_known`.
- `40.2` `t_selfq_gs`: `generate_series(1, t_selfq_gs.b)` in the subquery's FROM. A function source used to make the strip refuse.
- `40.2` `t_selfq_v`: flipped from `-- error: t_selfq_v.n isn't a column` to an accepted and a rejected insert. The comments above it and `t_selfq_v2` are rewritten.
- `41-generated-column-scope.sqllogic` § 15: `c as ((select count(*) from sq_src where sq_src.b = sq.b))` computes 2 and 1 over two rows.
- `46-mutation-context.sqllogic` `SqVar`: a variable-only self-qualified name beside a same-named subquery column reads the variable. This covers the `context.` fold branch.
- `expr-scope-walk.spec.ts` / `clone-expr-isolation.spec.ts`: they now pass `{ columns: … }` instead of `() => false` and assert the output contains `__quereus_own_row__.`. The "rewrites none of them" comment now cites barrier frames instead of `hasOpaque`.

## Things worth a reviewer's look

- A top-level `t.qty > 0` now compiles as `__quereus_own_row__.qty`. The ticket checked that CHECK failure messages render the stored expression and that `ColumnReferenceNode.toString` prints only the column name. I did not look for other places that print the stripped AST, such as plan output.
- `OwnRowNames` is not re-exported from `rename-rewriter.ts`; callers pass object literals.
- `bug-add-column-per-row-check-refuses-spellings-the-scan-accepts` (backlog) is separate: `ALTER … ADD COLUMN` compiles the CHECK without the strip. This change does not close it.
