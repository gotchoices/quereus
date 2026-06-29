---
description: A SQL query that binds a `?` parameter inside a HAVING clause fails to plan with "? isn't a parameter"; the fix is to chain the HAVING scope to the parameter scope so bound parameters resolve there as they do everywhere else.
prereq:
files:
  - packages/quereus/src/planner/building/select-aggregates.ts
  - packages/quereus/src/planner/scopes/registered.ts
  - packages/quereus/src/planner/resolve.ts
  - packages/quereus/test/logic/25.2-having-edge-cases.sqllogic
features: [SCN-NAV]
aspect: lamina-smoke
owner: quereus
difficulty: easy
---

# Fix — anonymous `?` (and named) parameter in a HAVING clause is unresolvable

## Summary

A grouped SELECT whose HAVING clause binds a parameter throws at plan time:

```sql
select entity_id from EntityTag
 where tag in (?)
 group by entity_id
 having count(distinct tag) = ?;   -- params: ['Mesh', 1]
```
→ `QuereusError: ? isn't a parameter`

Parameters in `where`, projection, and the pre-aggregate HAVING-pushdown path all
resolve fine — only the **post-aggregate (grouped) HAVING** path is broken.

## Reproduction (confirmed)

Verified empirically. A `.sqllogic` case:

```
create table et (entity_id integer, tag text);
insert into et values (1,'Mesh'),(1,'Other'),(2,'Mesh');

-- params: ["Mesh", 1]
select entity_id from et where tag in (?) group by entity_id having count(distinct tag) = ?;
→ [{"entity_id":1},{"entity_id":2}]
```

Throws `? isn't a parameter`. Stack (live source):

```
resolveParameter (src/planner/resolve.ts)
buildExpression  (src/planner/building/expression.ts)
buildHavingFilter (src/planner/building/select-aggregates.ts)  ← here
buildAggregatePhase
buildSelectStmt
```

## Root cause

`buildHavingFilter` in `packages/quereus/src/planner/building/select-aggregates.ts`
constructs the scope it uses to build the HAVING expression **with no parent**:

```ts
// Create a hybrid scope that first tries the aggregate output scope,
// then falls back to the original source scope for column resolution
const hybridScope = new RegisteredScope();   // ← no parent argument
```

`RegisteredScope.resolveSymbol` (`scopes/registered.ts`) only delegates to
`this.parent` when set; with `parent === undefined` the chain dead-ends. The
`ParameterScope` — which is what resolves the `'?'` / `':name'` symbol keys
(`resolveParameter` in `resolve.ts` → `scope.resolveSymbol('?')`) — lives near the
root of the planning-context scope chain (`selectContext.scope` chains
table/column → parameter → global). Because `hybridScope` never chains to it,
`resolveSymbol('?')` returns `undefined` and `resolveParameter` throws.

Every other clause builds against `selectContext.scope` (or a child of it), whose
ancestor chain includes the `ParameterScope` — which is exactly why WHERE,
projection, and the `shouldPushHavingBelowAggregate` early-filter path (it calls
`buildExpression(selectContext, ...)` directly) all resolve `?` correctly.

## Fix

Give `hybridScope` the select context's scope as its parent:

```ts
const hybridScope = new RegisteredScope(selectContext.scope);
```

This restores parameter resolution (and named-parameter resolution) via the
ancestor chain, matching WHERE-clause parity, without disturbing the curated
column resolution the hybrid scope already does:

- `RegisteredScope.resolveSymbol` checks its **own** registered symbols first, so
  the GROUP BY columns, aggregate aliases, and source-column fallbacks the function
  registers still take priority over anything in the parent chain. Only symbols the
  hybrid scope does **not** define (parameters; and, incidentally, qualified
  `table.column` refs) now fall through to the parent.
- The post-build `findUngroupedColumnRef` guard in `buildHavingFilter` still runs
  unchanged, so a HAVING reference to a non-grouped / non-aggregated column is still
  rejected with the existing diagnostic — chaining to the parent does not loosen
  that check (it only adds resolution paths; the validation rejects ungrouped
  attribute ids regardless of which scope produced them).

This is the minimal, surgical fix. An alternative — walking the chain to locate and
chain only to the `ParameterScope` — was rejected: there is no uniform parent
accessor across `BaseScope`/`RegisteredScope`, and parity with the WHERE path
(which builds against the full `selectContext.scope`) is the established pattern.

## Validation considerations

- The site-cad trigger SQL (`packages/site-cad/...scene.ts getVisibleEntityIds`,
  noted in the originating fix ticket) is **not** in this repo and needs no change
  once the engine resolves the parameter. Do not add the site-cad inline-integer
  workaround; the engine fix makes it unnecessary.
- Confirm no regression in the existing HAVING and bind-parameter suites
  (`25.2-having-edge-cases.sqllogic`, `02.1-bind-parameters.sqllogic`).

## TODO

- [ ] In `packages/quereus/src/planner/building/select-aggregates.ts`,
      `buildHavingFilter`, change `const hybridScope = new RegisteredScope();` to
      `const hybridScope = new RegisteredScope(selectContext.scope);`.
- [ ] Add a permanent regression case to
      `packages/quereus/test/logic/25.2-having-edge-cases.sqllogic` covering an
      anonymous `?` in HAVING over a grouped query (use the reproduction above; pick
      a shape consistent with that file's existing `he` table, e.g.
      `select grp from he group by grp having count(*) = ? -- params: [2]`), and
      ideally a named-parameter variant (`having sum(val) > :threshold`) to lock in
      both code paths.
- [ ] Run the logic suite (`yarn test` from repo root, or the targeted
      `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
      "packages/quereus/test/logic.spec.ts" --grep "25.2-having-edge-cases"`) and
      the bind-parameter file to confirm green.
- [ ] Run `yarn lint` in `packages/quereus` (single-quote globs on Windows).
