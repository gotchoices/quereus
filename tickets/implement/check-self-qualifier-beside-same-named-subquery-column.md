description: A CHECK or generated column whose subquery compares a column of the table to a same-named column of another table, such as `exists (select 1 from v where v.b = t.b)`, is accepted when the table is created and then makes every write fail. Make that spelling reach the written row, as `new.b` already does.
architecture: docs/sql-ddl.md
files:
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # stripColumnQualifier: always fold to OWN_ROW_QUALIFIER; drop the catalog capture loop and the resolver parameter
  - packages/quereus/src/planner/building/constraint-builder.ts  # buildConstraintChecks: register `__quereus_own_row__.<col>` for every column, bare key only for unshadowed ones
  - packages/quereus/src/planner/building/generated-column-scope.ts  # register `__quereus_own_row__.<col>` beside the bare and `new.` keys; drop the resolver argument
  - packages/quereus/src/schema/expr-scope/frame.ts  # hasBarrierFrame (kept as the one stop)
  - packages/quereus/test/logic/40.2-check-extras.sqllogic  # t_selfq_v pins the old failure; flip it and add the repro shapes
  - packages/quereus/test/schema/expr-scope-walk.spec.ts  # strip unit tests pass `() => false` as the resolver
  - packages/quereus/test/schema/clone-expr-isolation.spec.ts  # same
  - docs/sql-ddl.md  # CHECK Constraints bullets (line ~418) and the generated-column spelling table (line ~397)
repro: verified
----

## The bug

Write-time enforcement of a CHECK (and the computation of a generated column) compiles the stored expression in a row scope that registers the row's columns under the bare name and `new.<col>` (plus `old.<col>` for a CHECK). A self-qualified `t.b` is rewritten on a clone before compiling, by `stripSelfQualifierInSchemaExpression`. For an ordinary column it is folded to the bare `b`. Inside a subquery whose FROM source also has a column `b`, the bare name would bind to that source, so the strip leaves `t.b` as written, and nothing in the scope resolves it.

Measured on the `dist` build (built after HEAD's last source commit), memory module:

| statement | result today |
|---|---|
| `check (exists (select 1 from v where v.b = t.b))`, `v(b)` holding 1, insert `(1, 1)` | `t.b isn't a column` |
| same, insert `(1, 2)` (should be a CHECK failure) | `t.b isn't a column` |
| same with `new.b` | works |
| `check on delete (exists (select 1 from v where v.b = t.b))`, then `delete from t` | `No row context found for column b` — the leftover `t.b` binds to the DELETE statement's own target table instead |
| `check (exists (select 1 from generate_series(1, f.b) g where g.value = 2))` | `f.b isn't a column` (a function source is opaque, so the strip refuses) |
| generated `c as ((select count(*) from v where v.b = t.b))` | `t.b isn't a column` |
| generated `c as ((select count(*) from generate_series(1, t.b)))` | `t.b isn't a column` |
| generated / CHECK with `new.b` in either shape | works |

`bug-self-qualified-check-reads-context-variable` (landed) introduced `OWN_ROW_QUALIFIER` (`__quereus_own_row__`) for a column that a mutation-context variable shadows: the strip folds `t.who` to `__quereus_own_row__.who`, and the CHECK scope registers that key instead of the bare one. A qualified name cannot be captured by a subquery's source, so that path already works for every shape above.

## The fix (maintainer decision, 2026-11-10)

Use `OWN_ROW_QUALIFIER` for every self-qualified column name, in CHECKs and in generated columns (they share the strip). Keep the `hasBarrierFrame` stop: inside a CTE body, a derived-table body or a nested INSERT/UPDATE/DELETE the name stays qualified and fails as it does today, because a materialized CTE holds one buffer per execution, and correlating into it would judge every row on the first row's value.

### `stripColumnQualifier` (self-qualifier-strip.ts)

Order of checks after this change:

1. Sealed frame → leave (unchanged).
2. Unqualified → leave (unchanged).
3. Qualifier rebound by an inner FROM / WITH → leave (unchanged).
4. Not the owning table, or a schema other than the owning one → leave (unchanged).
5. `context.<name>` with no schema, on a table literally named `context`, where `<name>` is a shadowed column → leave for the variable (unchanged; still needs `shadowedColumns`).
6. Barrier frame on the stack → leave (now applies to every column, not just shadowed ones; for unshadowed columns this matches today's outcome, since a barrier frame also has `hasOpaque`).
7. Fold to `OWN_ROW_QUALIFIER.<name>`, schema cleared.

The `realSources` / `hasOpaque` capture loop goes away, and with it the `resolveColumnInSource` parameter and `StripState.resolve`. Update the doc comments on the function, `OWN_ROW_QUALIFIER` (its comment says it is only for shadowed columns), and the header comment in `constraint-builder.ts` near the strip call. `realSources` stays in the frame model; `generated-column-refs.ts` still uses it for bare names.

Folding a top-level `t.qty > 0` to `__quereus_own_row__.qty` rather than `qty` is equivalent. Checked: the CHECK failure message renders the stored expression (`CHECK constraint failed: pos (t.b > 0)`), and `ColumnReferenceNode.toString` prints only the column name, so the reserved qualifier does not leak into messages or plans.

### Scope registration

- `constraint-builder.ts` `buildConstraintChecks`: for INSERT/UPDATE (new image) and DELETE (old image), register `${OWN_ROW_QUALIFIER}.${col}` for every column, and the bare `col` only when the column is not in `shadowedColumns`. Today the code picks one of the two keys (`ownRowKey`).
- `generated-column-scope.ts`: register `${OWN_ROW_QUALIFIER}.${col}` with the same `makeRef` as the bare and `new.` keys; call the strip without the resolver.

The reason the code avoids seeding `<table>.<col>` keys (a join peer's parent-chain lookup would resolve an inner relation's same-named qualified columns against the outer row) does not apply to the reserved qualifier: no inner relation is named `__quereus_own_row__` unless a user writes that alias, which the existing NOTE on `OWN_ROW_QUALIFIER` already records.

### Consistency with other analyses (checked, no change needed)

- `generated-column-refs.ts` `classifyQualified` already classifies an unrebound `t.b` as `'own'` regardless of intervening sources, so the dependency graph already matches the new meaning.
- The existing-row CHECK scan (`requalifyOwnRowRefsInSchemaExpression`) rewrites `t.b` to its scan alias without a capture question, so ALTER … ADD CONSTRAINT already accepts these CHECKs; after this fix writes agree with it.
- `bug-add-column-per-row-check-refuses-spellings-the-scan-accepts` (backlog) is about `ALTER … ADD COLUMN` compiling the CHECK without the strip at all. It is separate; this change does not close it.

## Tests

The one test that pins the old behavior is `t_selfq_v` in `40.2-check-extras.sqllogic` (`-- error: t_selfq_v.n isn't a column`), with a comment above it describing the capture rule. Flip it: the insert that satisfies the CHECK succeeds and one that violates it fails with the constraint name. Rewrite the comment above it, and the one above `t_selfq_v2`.

Add to `40.2-check-extras.sqllogic`, beside the self-qualifier block (one case each):

- `exists (select 1 from v where v.b = t.b)`: an accepted and a rejected insert.
- `check on delete (...)` of the same shape: a delete that passes and one that is refused.
- `generate_series(1, t.b)` in a CHECK subquery's FROM.

Add one generated-column case (find the generated-column logic file, e.g. `grep -l "generated always" packages/quereus/test/logic/*.sqllogic`): `c as ((select count(*) from v where v.b = t.b))` computing the right value over two rows with different `b`.

Keep, unchanged in meaning: `SqCte` in `46-mutation-context.sqllogic` (CTE body, still `isn't a column`) and the "rewrites none of them" case in `expr-scope-walk.spec.ts` (DML / CTE / derived bodies). The strip unit tests in `expr-scope-walk.spec.ts` and `clone-expr-isolation.spec.ts` drop the `() => false` argument; where they assert `not.contain('t.qty')`, assert the folded form contains `__quereus_own_row__.` instead, so the test says what the strip produces.

## Docs

- `docs/sql-ddl.md` *CHECK Constraints*, first bullet: add that `<table>.<column>` (and `<own-schema>.<table>.<column>`) means the same as the unqualified name, including inside a subquery whose FROM has a same-named column, where the unqualified name would bind to that source; the exception is a CTE body, derived table or nested INSERT/UPDATE/DELETE, where it is not resolved.
- Generated-column spelling table, row `<table>.<column>`: "the self-qualifier is folded away" becomes "reaches the row's column even inside a subquery over a source with a same-named column", with the same body exception (the paragraph below the table already describes those bodies).

## TODO

- Change `stripColumnQualifier` and `stripSelfQualifierInSchemaExpression` as above; drop the resolver parameter and update both callers and the two unit specs.
- Register `__quereus_own_row__.<col>` for every column in `buildConstraintChecks` (new and old images) and in the generated-column scope.
- Update the doc comments named above.
- Flip `t_selfq_v`; add the CHECK, DELETE-op, `generate_series` and generated-column cases.
- Update `docs/sql-ddl.md`.
- `yarn workspace @quereus/quereus run lint`, then `yarn test`. Run `yarn test:store` only if a store-specific difference shows up.
