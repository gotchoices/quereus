description: A query can give two of its data sources the same name, and the engine then disagrees with itself about which one that name means, so a saved view built that way can silently break when a column is renamed. Reject the repeated name when the query is planned, the way standard SQL does.
architecture: docs/sql-select.md#31-from-clause
files:
  - packages/quereus/src/planner/building/select.ts               # buildJoin (~785) — add the check after both sides are built
  - packages/quereus/src/planner/building/select-projections.ts   # buildStarProjections (~57) — qualified star filters by relation name; no change needed once duplicates are rejected
  - packages/quereus/src/schema/rename/column-rename.ts           # bindQualifier (~684) / resolveQualifierBinding (~881) — doc comments describe the duplicate as "legal"; update them
  - packages/quereus/test/covering-structure.spec.ts              # cross-schema describe (~826) plans `t left join s2.t`, which the check rejects
  - packages/quereus/test/logic/11-joins.sqllogic                 # home for the reproduction
  - docs/sql-select.md                                            # § 3.1 FROM Clause — state the rule
repro: verified
----

# Reject a FROM clause that gives two sources the same name

## The defect

The name a FROM source exposes for qualified references (`t.x`, `t.*`) is its alias when it has one, otherwise its own table or function name. Quereus does not require those names to be distinct within one FROM clause, and three parts of the engine answer "which source is `t`?" differently:

- A **qualified column** `t.x` goes through `MultiScope` first-match: the first same-named source *that has a column `x`* wins. (So it is not even "first source": `select t.x from u as t join t on 1=1` reads the second source's `x` because `u` has none.)
- A **qualified star** `t.*` (`buildStarProjections`) filters attributes by relation name, so it returns the columns of *every* source named `t`.
- The **column-rename walk** (`column-rename.ts`, `bindQualifier`) binds a qualifier to the first source in FROM order.

Measured against the current engine with `t(id, x) = (1, 5)` and `u(id, y) = (2, 7)`:

```
select t.x from t join u as t on 1=1          => [{"x":5}]
select t.x from u as t join t on 1=1          => [{"x":5}]          (u has no x; falls to the second source)
select t.* from t join u as t on 1=1          => [{"id":1,"x":5,"id:1":2,"y":7}]   (both sources)
select * from t join t on 1=1                 => accepted (unaliased self-join)
select * from main.t join t on 1=1            => accepted
select * from t join (select id from t) as t on 1=1        => accepted
select * from t join generate_series(1,2) as t on 1=1      => accepted
with c as (select 9 as x) select a.x from c a join t a on 1=1  => [{"x":9}]
```

The user-visible failure (verified):

```sql
create table t (id integer primary key, x integer);
create table u (id integer primary key, y integer);
create view v as select t.* from u as t join t on 1=1;   -- v publishes u.id, u.y, t.id, t.x
create view w as select x from v;
select * from w;                       -- {"x": 5}
alter table t rename column x to z;    -- accepted
select * from w;                       -- ERROR: Column not found: x
```

The rename walk models `t` as `u` (first source), so it does not see `v` as republishing `t.x`, and `w` is never re-targeted.

## The fix

Enforce the SQL rule: the exposed names of the sources in one FROM clause must be distinct. One check in `buildJoin` (`planner/building/select.ts`), after both sides are built:

- Collect the exposed names of each side from the AST (`joinClause.left` / `joinClause.right`), walking nested joins:
  - `table` → `alias ?? table.name`
  - `functionSource` → `alias ?? name.name`
  - `subquerySource` → `alias` if present; an unaliased subquery exposes no name
  - `join` → union of both sides
- Lowercase the names (identifiers are case-insensitive here; `AliasedScope` lowercases too).
- If any right-side name is already on the left side, throw `QuereusError` with `StatusCode.ERROR`, naming the repeated name and pointing at the source. Suggested message, modelled on PostgreSQL: `table name "t" specified more than once in FROM clause` — mention that an alias distinguishes them. Use the source's `loc` for line/column if the AST carries one (the ambiguous-column error in `building/expression.ts:103` shows the pattern).

Checking at each join node over the full leaf sets of both sides catches every duplicate exactly once; the sets are tiny, so there is no cost concern. A single-source FROM needs no check, and `buildSelectStmt` already rejects more than one top-level FROM entry (comma lists are parsed into joins — see `11.2-comma-join.sqllogic`). Only SELECT carries a FROM in the AST, so UPDATE/DELETE need nothing.

Scope boundaries — these stay legal:

- A correlated subquery or a LATERAL subquery reusing an outer name (`select * from t where exists (select 1 from t join u on 1=1)`) — different FROM clause, ordinary shadowing.
- A CTE and a table sharing a *name* but given distinct aliases.

**Schema-qualified same-named tables are rejected too.** `from main.t join s2.t` exposes `t` twice. PostgreSQL allows that because `main.t.x` / `s2.t.x` can tell them apart, but Quereus rejects every three-part column reference at bind time (`AliasedScope.resolveSymbol` comment), so nothing can distinguish the two and the star/column disagreement is the same. Compare names schema-blind. Leave a `NOTE:` at the check: if three-part column references are ever supported, unaliased tables from different schemas become distinguishable and the check should compare `(schema, name)` for them.

Rejected alternative: align `buildStarProjections` with the column rule. That fixes this one instance but leaves the class open (the column rule itself is "first source that has the column", which nothing else models), and keeps duplicate synthesized output names (`id:1`).

## Blast radius (measured)

A probe of exactly this check (schema-blind) was run against `node test-runner.mjs` in `packages/quereus` (1373 passing, 1 failing). The only failure:

- `covering-structure.spec.ts` › `coverage prover — cross-schema qualifier resolution (defense-in-depth)` › `lookup-schema-qualified (s2.t.uc) does NOT cover` — its fixture body `select t.uc, t.id from t left join s2.t on lkref = pkid order by uc` is planned by `bodyRoot(db, BODY)`. The sibling tests in that describe block plan the same body and will fail the same way (the probe ran mocha with `min` reporter; only one was listed, but all three call `proveWithOrderSchema`).

Recommended handling: keep the test meaningful. The prover reads ORDER BY/WHERE qualifiers from the stub's `selectAst` (parsed only, never bound — `collectBaseTableQualifiers` / `columnRefParts` in `coverage-prover.ts`) and the join shape from the plan root. So plan the root from a variant body with the lookup aliased (e.g. `… left join s2.t as l on lkref = pkid …`) and keep the stub `selectAst` parsed from the original duplicate-named body with the hand-built three-part ORDER BY term. Confirm the three tests still exercise the `(schema, table)`-aware arm (the `s2` case must still report `ordering-mismatch`, the `main` and schema-absent cases must still cover). Update the describe's doc comment: the duplicate-named body is now unplannable from SQL as well, which makes this arm doubly unreachable — defense-in-depth for the day three-part column references and the schema-aware duplicate check arrive together. If the split root/AST cannot keep the tests meaningful, delete the describe block and leave a `NOTE:` in the coverage-prover module doc's cross-schema paragraph saying so — do not loosen assertions.

No `.sqllogic` file failed under the probe, so no logic test relies on an unaliased self-join or a repeated alias.

## Follow-on cleanup

- `column-rename.ts`: the doc comments on `bindQualifier` and `resolveQualifierBinding` say a duplicated qualifier "is legal and resolves to the FIRST such source" and reference this ticket. Rewrite them: the planner now rejects a duplicate exposed name, so a qualifier binds at most one source per frame; the first-wins guard stays as harmless defense (a stored body that predates the check would fail to plan anyway). Remove the ticket slug reference.
- `docs/sql-select.md` § 3.1 FROM Clause: add one sentence — each source's exposed name (its alias, else its table/function name) must be distinct within one FROM clause; a self-join needs an alias on at least one side; an unaliased subquery exposes no name.

## Test

One reproduction in `packages/quereus/test/logic/11-joins.sqllogic` (check that file's error-expectation syntax first): the duplicate-alias case (`from t join u as t`), the unaliased self-join (`from t join t`), and the legal case that must keep working (`from t join t as t2`, plus a correlated subquery reusing the outer name). One block, not one per shape. The view/rename scenario above needs no separate test: `create view v as select t.* from u as t join t on 1=1` now fails at create time, which the join test already covers.

## TODO

- Add the exposed-name collection helper and the duplicate check in `buildJoin` (`planner/building/select.ts`), with the `NOTE:` about three-part references.
- Add the reproduction block to `test/logic/11-joins.sqllogic`.
- Rework the cross-schema describe in `test/covering-structure.spec.ts` as described (split plan root from stub AST), and update its doc comment and the coverage-prover module doc's cross-schema paragraph.
- Update the `bindQualifier` / `resolveQualifierBinding` doc comments in `schema/rename/column-rename.ts`.
- Add the rule to `docs/sql-select.md` § 3.1.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
