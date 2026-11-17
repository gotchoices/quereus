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

## What landed

Every source in a FROM clause exposes a name for qualified references (`t.x`, `t.*`): its alias, else its table or function name without the schema. `buildJoin` (`planner/building/select.ts`) calls `assertDistinctExposedNames(joinClause)` after both sides are built; it compares the left subtree's exposed names with the right subtree's (lowercased, schema-blind) and throws `QuereusError` at the repeating right-side source:

```
table name "t" specified more than once in FROM clause; give one of them an alias to tell them apart
```

Before this, `select t.x from u as t join t` read the second source, `select t.* from t join u as t` returned both sources' columns, and the column-rename walk bound `t` to the first source, so a view over such a body could break silently on `alter table … rename column`. Those bodies no longer plan.

Still legal: a self-join with an alias on at least one side; a subquery in WHERE / the select list / a LATERAL subquery's inner FROM reusing an outer name (separate FROM clause, ordinary shadowing); a CTE referenced twice under distinct aliases.

Tests: reproduction block at the end of `test/logic/11-joins.sqllogic`; `covering-structure.spec.ts` cross-schema describe now plans its root from an aliased twin of the body (the stub `selectAst` keeps the duplicate-named body, so the prover's schema-aware guard is still what the test exercises); the `column-scope-body-spellings.spec.ts` test that asserted the old "duplicate is legal, first source wins" behaviour was removed.

## Review findings

Read the `ticket(implement): bug-duplicate-from-qualifier-resolves-inconsistently` diff before the handoff.

- **Correctness — checked by running probes** (throwaway spec, deleted): `from T join t` and `from "T" join t` (case-insensitive) rejected; `t join (select …) as t` rejected; `json_each(…) join json_each(…)` rejected; CTE `c join c` rejected, `c join c as c2` runs; three-way `t join u … join t as u` rejected at the third source; `join … using (id)` and `full join` rejected; `t join lateral (select * from u as t …) as l` runs (inner FROM shadows); `t as a join u as A` rejected. Comma lists (`from t, t`) were already rejected by the "multiple FROM sources not supported" check, so the join path is the only way to put two sources in one FROM. Only SELECT has a FROM in the AST (no UPDATE … FROM / DELETE … USING), so no other entry point needs the check.
- **Name source agrees with scope registration** — `exposedSources` uses the same alias-else-name rule `buildFrom` passes to `registerColumnScope` for tables, views, CTEs, function sources and subqueries. No mismatch.
- **Coverage-prover test still meaningful** — the guard it defends (`coverage-prover.ts` ~line 1039) reads the schema off the stub AST's ORDER BY term, not off the root's relation names, so planning the root from the aliased twin does not make the test pass trivially. All three assertions pass.
- **Blast radius** — regex grep over `packages/**` (`.ts`, `.tsx`, `.sqllogic`) for an unaliased same-name join found only the new rejection test. Bench SQL uses aliased joins.
- **Minor, fixed inline** — the `exposedSources` doc comment said an unaliased subquery "never collides"; the generated alias (`subquery_<offset>` / `mutating_subquery_<offset>`, `parser.ts` ~line 1079) can collide with a user table of that literal name. Corrected the comment and parked the concern as a `NOTE:` tripwire on `exposedSources` (contrived; fix would be marking generated aliases on the AST).
- **Tripwire, already present** — schema-blind comparison (`main.t join s2.t` rejected) carries a `NOTE:` on `assertDistinctExposedNames` saying to compare `(schema, name)` if three-part column references are ever supported. No change.
- **Performance** — each join node re-walks its subtrees (quadratic in join width); trivial at real join sizes, no action.
- **Tests** — the sqllogic block is the bug's reproduction (two forms: repeated alias, unaliased self-join) plus the still-legal correlated case; all three earn their place. Nothing cut, nothing added.
- **Docs** — `docs/sql-select.md` § 3.1 states the rule; coverage-prover and column-rename comments updated in the implement pass and read accurately. No other doc describes duplicate qualifiers as legal (grep of `docs/`, package README).
- **Stored bodies that predate the check** now fail to plan when read; accepted per AGENTS.md (backward compatibility not a goal yet).
- **Validation** — `yarn workspace @quereus/quereus test`: 11178 passing, 23 pending, 0 failing. `yarn workspace @quereus/quereus lint`: clean (re-run after the comment edit). `yarn test:store` not run (planner-only change; no store path involved).
