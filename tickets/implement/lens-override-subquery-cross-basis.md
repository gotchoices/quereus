description: Close the subquery/function-source arm of the lens override basis-source check. `validateOverrideBasisSources` only walks top-level `table`/`join` FROM nodes, so a cross-basis table buried in a subquery source (`from (select * from z.Foo)`) is NOT rejected when the override covers every logical column explicitly (no gap-fill to trip the basis-reachability error), letting the body silently re-anchor off its declared `over Y` basis. Replace the shallow FROM walk with a reflective whole-body walk that flags every cross-basis `table` node anywhere in the override body.
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-overrides.spec.ts, docs/lens.md
----

## Problem (confirmed)

`validateOverrideBasisSources` (`lens-compiler.ts:1384`) walks only `table` and
`join` FROM nodes; its `default` case (`subquerySource` / `functionSource`) is a
no-op (`lens-compiler.ts:1409-1411`). When an override's FROM is a subquery
source whose body names a *different existing* schema and the override covers
every logical column explicitly, no gap-fill fires, so nothing rejects it and
the compiled body silently re-anchors off the declared basis.

Reproduced (verified `threw=false` against current HEAD via a throwaway
`mocha` spec):

```sql
declare schema y { table CarCore { id integer primary key, speed integer } }
apply schema y;
declare schema z { table CarCore { id integer primary key, speed integer } }
apply schema z;
declare logical schema x { table Car { id integer primary key, speed integer } }
declare lens for x over y { view Car as select id, speed from (select * from z.CarCore) sub }
apply schema x;   -- deploys WITHOUT error today; reads z.CarCore, not the y basis
```

## Root cause

The FROM walk is structurally shallow: it descends `join` legs but treats
`subquerySource` / `functionSource` as opaque. A subquery body carries its own
`from` (plus optional `with` CTEs and compound legs); a function source carries
argument expressions that may embed subqueries — none are visited, so a
schema-qualified cross-basis `table` inside any of them escapes the check.

## Recommended correction — reflective whole-body walk

Replace the bespoke `table`/`join` switch in `validateOverrideBasisSources` with
a **reflective walk over the entire override `select` AST** that, for every node
with `node.type === 'table'` (the unique discriminant of `AST.TableSource` — see
`ast.ts:404`; `ColumnExpr` is `'column'`, `IdentifierExpr` is `'identifier'`),
applies the existing schema-qualified-outside-basis check. Model it on the
existing safe reflective stack walk in `collectColumnRefNames`
(`lens-compiler.ts:1800-1821`).

This is DRY, needs no new recursion scaffolding, and for free covers every
nesting the shallow walk missed: subquery-source FROM trees, their `with` CTE
bodies, compound (`union`/`intersect`/…) legs, function-source argument
subqueries, and even scalar/`where`/`in`/`exists` subqueries — all of which, per
the design (docs/lens.md § "v1 override body-shape restrictions"), may reference
**only** the declared basis. Catching cross-basis tables in those positions too
is strictly more sound and does not regress any legitimate body.

### Why CTE/alias scope threading is NOT needed (important — do not over-build)

The v1 ticket deferred this work citing a "real recursive-scope walk" to thread
in-scope CTE names so a CTE reference is not mistaken for a basis relation.
On inspection that machinery is **not load-bearing here**, because:

- The check fires only on a `table` node with an **explicit, non-basis schema
  qualifier** (`node.table.schema && schema !== basis`). CTE references and FROM
  aliases are *always bare* (no schema qualifier) — SQL has no `schema.cte`
  form — so they can never trip the schema-qualified check. No false positive is
  possible regardless of CTE scope.
- Bare table names cannot be cross-basis by construction: the lens compiler
  resolves an unqualified FROM table to the basis schema
  (`node.table.schema ?? basisSchemaName`, see `collectOverrideSources`
  `lens-compiler.ts:1345`), so a bare name is either the basis or a CTE — never
  schema `z`.

What IS required (and the reflective walk delivers automatically) is **recursing
into CTE bodies, compound legs, and nested subqueries**, because a CTE/subquery
*body* can itself contain a schema-qualified `z.Foo` that must be flagged, e.g.
`from (with c as (select * from z.CarCore) select * from c) sub`.

Net: keep the check schema-qualified-only (consistent with the top-level wording
and the existing regex tests), just make it reach every `table` node in the tree.
Do not introduce a CTE-name set.

## Message / contract

Keep the existing message verbatim so the established test regex
(`/outside the declared basis|references basis relation 'z/i`) and any external
matchers keep matching:

```
lens: override for logical table '<L>.<T>' references basis relation
'<schema>.<table>' outside the declared basis '<basis>' (the lens is declared
'over <basis>'); an override's FROM may only reference the declared basis
```

(The "FROM" phrasing is now slightly narrower than the broadened coverage, but
the dominant and only-previously-documented case is a FROM source; leave the
wording unchanged to avoid churning the regex tests.)

## Validation expectations

- Negative: the reproduction above throws at `apply schema x`.
- Negative (nested CTE body): `from (with c as (select * from z.CarCore) select * from c) sub` throws.
- Positive (must still deploy): a subquery source over the *basis* schema,
  `view Car as select id, speed from (select * from y.CarCore) sub`.
- Positive guard (no over-reject): the existing override tests
  (`lens-overrides.spec.ts`) all still pass — in particular the cross-basis
  *join* test (`lens-overrides.spec.ts:309`) and the basis-qualified single
  source tests, confirming a bare alias / basis-qualified table is not flagged.

## Reference

- Code: `validateOverrideBasisSources` + its docstring's `KNOWN GAP` note
  (`lens-compiler.ts:1367-1415`); reflective-walk template
  `collectColumnRefNames` (`lens-compiler.ts:1800`). AST shapes:
  `TableSource`/`JoinClause`/`SubquerySource`/`FunctionSource` (`ast.ts:401-433`),
  `SelectStmt.withClause`/`compound`/`union` (`ast.ts:170-187`),
  `SubqueryExpr`/`InExpr`/`ExistsExpr` (`ast.ts:130-156`),
  `WithClause`/`CommonTableExpr` (`ast.ts:548-566`).
- Docs: `docs/lens.md` § "v1 override body-shape restrictions" (header at line
  114). The **"Known gap:"** sentence is the second half of the "Cross-basis FROM
  source" bullet at **line 120** ("the check walks only top-level `table` / `join`
  FROM nodes … tracked by `lens-override-subquery-cross-basis`").

## TODO

- Rewrite `validateOverrideBasisSources` (`lens-compiler.ts:1384`) to perform a
  reflective walk of the override `select` AST, applying the schema-qualified-
  outside-basis check to every `node.type === 'table'`. Reuse the safe walk shape
  of `collectColumnRefNames`. Do not add CTE-name threading (see rationale above).
- Update the function's docstring (`lens-compiler.ts:1367-1383`): drop the
  `KNOWN GAP` paragraph; state that the walk now descends subquery/function/CTE/
  compound bodies and explain the schema-qualified-only invariant that makes CTE
  scope tracking unnecessary.
- Edit the "Cross-basis FROM source" bullet in `docs/lens.md` (line 120): drop
  the "**Known gap:**" sentence and replace it with a statement that the check now
  walks the whole override body, so a cross-basis table in a nested subquery /
  function-source argument / CTE / compound body is rejected too.
- Add to `packages/quereus/test/lens-overrides.spec.ts` (in the
  `lens overrides: cross-basis join` describe block, alongside the defect-5
  tests at `:290`/`:309`):
  - a negative test for the reproduction (subquery source naming `z.CarCore`,
    full coverage → throws, matching `/outside the declared basis|references basis relation 'z/i`);
  - a negative test for a cross-basis table inside a nested CTE body;
  - a positive test that a subquery source over the *basis* schema
    (`from (select * from y.CarCore) sub`) still deploys.
- Run `yarn workspace @quereus/quereus test` (or the targeted
  `test:single` on `test/lens-overrides.spec.ts`) and the lint script; ensure the
  whole suite is green.
