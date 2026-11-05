description: When a table has a column and a per-statement context value with the same name, a CHECK on that name governs the context value, but the query optimizer treats it as a fact about the column. Queries can then silently miss stored rows, so the optimizer must stop drawing column facts from CHECKs that read context values.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts  # getCheckExtraction, extractCheckConstraints, walkConjunction, containsOldRowImageRef (the screen to copy)
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # add the reproduction
  - docs/optimizer-fd.md  # "Check-derived contributions", the row-invariant gate
repro: verified
----

## The defect

§2.6.2 of `docs/sql-ddl.md` says a bare name in a CHECK means the context variable when a table declares both a column and a variable of that name, and `context.<name>` always means the variable. Enforcement follows this. The optimizer's CHECK extraction does not: `columnIndexFromExpr` (`planner/analysis/predicate-shape.ts`) resolves by name and ignores the qualifier, so `who > 0` and `context.who > 0` both become a domain fact on the column `who`. `ruleFilterContradiction` then folds away any query that contradicts that fact.

Measured on the `dist` build of the current tree, memory module:

```sql
create table t (a integer primary key, who integer null, check (who > 0)) with context (who integer null);
insert into t values (1, -1);        -- accepted: the variable reads NULL, so the CHECK passes
select * from t;                     -- [{"a":1,"who":-1}]
select * from t where who <= 0;      -- [] (wrong: should return the row)
```

The same wrong result was measured with `check (context.who > 0)`, and with `who` declared NOT NULL and the row written `with context who = 5`.

`bug-alter-check-validation-cannot-reference-mutation-context` makes ALTER accept these same CHECKs over such rows, so this lands first.

## The fix

Screen each AND-conjunct in `walkConjunction`, next to the `old.` screen and for the same reason: a conjunct that reads a context variable is not a fact about the stored row, while each sibling conjunct free of variables still holds under ternary logic (`C1 AND C2` is FALSE whenever `C2` is).

A conjunct is screened when it contains a reference to a declared variable, meaning either of:

- an unqualified `column` or `identifier` node with no schema, named like a declared variable;
- a `column` node qualified `context` (case-insensitive), named like a declared variable.

`new.<name>` and `<table>.<name>` stay extractable, because they always reach the column. `context.<name>` with an undeclared name is left to the ordinary path, so a table literally named `context` keeps its self-qualified facts.

The screen is depth-blind, like `containsOldRowImageRef`. A bare name inside a subquery may really bind to the subquery's own source, in which case the screen skips a conjunct it did not have to. That is sound, and subquery conjuncts contribute no facts anyway.

`extractCheckConstraints` gains an optional set of lower-cased variable names, supplied by `getCheckExtraction` from `tableSchema.mutationContext`. `assertion-hoist-cache.ts` passes nothing, because a hoisted assertion has no context. `getTrustedCheckExtraction` covers the other consumers (`TableReferenceNode`, `lens-prover`).

## TODO

- Add the screen and thread the variable names through `getCheckExtraction`, `extractCheckConstraints` and `walkConjunction`.
- Add the reproduction above to `46-mutation-context.sqllogic`, plus one case showing a sibling conjunct still lifts or `new.who > 0` still folds, so the screen is not simply disabling extraction on these tables.
- Document the screen in `docs/optimizer-fd.md` beside the `old.` leg, and in the `isRowInvariantCheck` doc comment.
- Run `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus run test`.
