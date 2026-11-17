description: A query could give two of its data sources the same name, and the engine then disagreed with itself about which one that name meant (so a saved view built that way could silently break on a column rename). The planner now rejects the repeated name, as standard SQL does.
architecture: docs/sql-select.md#31-from-clause
files:
  - packages/quereus/src/planner/building/select.ts               # assertDistinctExposedNames / exposedSources, called from buildJoin
  - packages/quereus/test/logic/11-joins.sqllogic                 # reproduction block at the end ("Exposed source names must be distinct")
  - packages/quereus/test/covering-structure.spec.ts              # cross-schema describe: plan root from an aliased twin, stub AST keeps the duplicate body
  - packages/quereus/src/planner/analysis/coverage-prover.ts      # module doc, cross-schema paragraph
  - packages/quereus/src/schema/rename/column-rename.ts           # bindQualifier / resolveQualifierBinding doc comments
  - packages/quereus/test/schema/column-scope-body-spellings.spec.ts  # removed the test that pinned the old "duplicate is legal" behaviour
  - docs/sql-select.md                                            # § 3.1 FROM Clause — "Source names" paragraph
repro: verified
----

# Reject a FROM clause that gives two sources the same name

## What changed

Every source in a FROM clause exposes a name for qualified references (`t.x`, `t.*`): its alias, else its table or function name without the schema. A subquery's alias is always present in the AST — the parser generates `subquery_<offset>` when none is written — so an unaliased subquery never collides in practice.

`buildJoin` (`planner/building/select.ts`) now calls `assertDistinctExposedNames(joinClause)` right after both sides are built. It collects the exposed names of the left subtree and the right subtree from the AST (walking nested joins), compares them lowercased, and throws `QuereusError` (`StatusCode.ERROR`) on the first right-side name already on the left, at that right-side source's `loc`:

```
table name "t" specified more than once in FROM clause; give one of them an alias to tell them apart
```

Each join node checks its full left set against its full right set, so a repeat anywhere in a nested join is caught once, at the lowest join that contains both. Comparison is schema-blind: `from main.t join s2.t` is rejected, because three-part column references are rejected at bind time and nothing could tell the two apart. A `NOTE:` on the function says to compare `(schema, name)` for unaliased table sources if three-part references are ever supported.

Previously, with `t(id, x)` and `u(id, y)`: `select t.x from u as t join t` read `t.x` from the second source (the first one with an `x`), `select t.* from t join u as t` returned both sources' columns, and the column-rename walk bound `t` to the first source — so `create view v as select t.* from u as t join t on 1=1; create view w as select x from v; alter table t rename column x to z` left `w` unplannable. All of those `create`/`select` statements now fail at plan time.

## Still legal

- A self-join with an alias on at least one side (`from t join t as t2`).
- A subquery in WHERE / select list (or a LATERAL subquery's inner FROM) reusing an outer name — a different FROM clause, ordinary shadowing.
- A CTE and a table sharing a name when given distinct aliases.

## Tests

- `test/logic/11-joins.sqllogic`, final block — the reproduction: an alias repeating another source's name (`from dn_t join dn_u as dn_t`) and an unaliased self-join (`from dn_t join dn_t`) are both rejected; `from dn_t join dn_t as t2` with a correlated `exists (select 1 from dn_t join dn_u … where dn_t.id = t2.id)` still runs and returns the expected row.
- `test/covering-structure.spec.ts`, describe `coverage prover — cross-schema qualifier resolution (defense-in-depth)` — not a new test; reworked because its body `select t.uc, t.id from t left join s2.t …` no longer plans. The plan root now comes from `PLANNABLE_BODY` (lookup aliased `s2.t as l`, same plan shape — `t.uc` binds base `t` either way); the stub `selectAst` is still parsed from the duplicate-named `BODY` with the hand-built three-part ORDER BY term. All three assertions are unchanged and pass: `s2` → `ordering-mismatch`, `main` → covers, schema-absent → covers. Doc comment updated: the path is now doubly unreachable from SQL.
- `test/schema/column-scope-body-spellings.spec.ts` — **removed** `a duplicated qualifier follows the planner — first source in FROM order`. It created views over `from t join u as t` / `from u as t join t` and asserted the rename walk's first-source choice; those views can no longer be created, and the rejection is covered by the logic block above. (This test was not in the ticket's blast-radius probe — it landed after the probe ran.)

Validation run: `yarn workspace @quereus/quereus test` → 9512 passing, 23 pending, 1 failing (the removed test above); after removing it, `column-scope-body-spellings.spec.ts` + `covering-structure.spec.ts` re-run → 165 passing. `yarn workspace @quereus/quereus lint` → clean. `yarn test:store` not run.

## Things a reviewer might check

- **Rename can't manufacture a duplicate.** Probed by hand (not added as a test): with `main.t` and `s2.t2`, `create view v as select t.x, t2.y from t join s2.t2 on t.id = t2.id; alter table t rename to t2` rewrites the body to `from t2 as t inner join s2.t2` (the table-rename walk pins the old spelling as an alias) and the view still runs. Same for a sibling alias (`join u as t2`). So table rename does not produce a body this check rejects; a missed pin would now surface as a loud plan error instead of a silent rebind.
- **Generated subquery alias.** An unaliased subquery's generated `subquery_<offset>` is treated as its exposed name, so a user table literally named e.g. `subquery_14` joined to an unaliased subquery starting at offset 14 would be rejected. Contrived; left as is.
- **Stored bodies created before this check** that repeat a name now fail to plan when read. No migration; backward compatibility is not a goal yet (AGENTS.md).
- **Only the lens compiler synthesizes join ASTs** in `src` (`schema/lens-compiler.ts`, aliases each member by its unique `relationId`), so no internal lowering trips the check. A grep of other packages for unaliased self-joins found none.
- `column-rename.ts`: the first-wins guard in `bindQualifier` is kept as a harmless guard; its comments no longer describe the duplicate as legal and no longer cite this ticket.
