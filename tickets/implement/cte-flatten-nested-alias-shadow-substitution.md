description: Make the multi-level CTE-body flattener's consumer-rewrite alias-shadow-aware so a nested subquery that re-binds the inner CTE's source name as a LOCAL FROM alias is NOT wrongly rewritten to the outer inner-CTE's defining expression (silent-wrong fix). Reuse scope-transform's alias-shadow machinery.
difficulty: hard
files:
  - packages/quereus/src/planner/mutation/cte-flatten.ts          # composeBody / makeSubstitutions — the consumer-rewrite descent to fix
  - packages/quereus/src/planner/mutation/scope-transform.ts      # export transformAliasScopedQuery (alias-shadow descent to reuse)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic       # regressions (place near the multi-level shadow cases ~L3277)
  - docs/view-updateability.md                                    # multi-level CTE body section — note the scope-aware nested descent
---

# Multi-level CTE flatten: nested-subquery alias shadowing of the inner source name

## The bug (confirmed by tracing)

`composeBody` (`planner/mutation/cte-flatten.ts:202`) collapses a single-source
projection-and-filter consumer by substituting each reference to the inner
sibling-CTE source with the inner's defining expression. The descent into the
consumer's subquery operands is **not scope-aware**:

```ts
const descend = (q) => mapQueryExprUniform(q, nestedSubst);   // L216 — blind
const sub     = (e) => transformExpr(e, topSubst, descend);   // L217
```

`mapQueryExprUniform` applies `nestedSubst` at *every* nesting depth, and
`nestedSubst` (`makeSubstitutions`, L326-327) fires on **any** column qualified
by the inner source name:

```ts
const nestedSubst = (col) =>
    col.table && col.table.toLowerCase() === lcSource ? lookup(col.name) : undefined;
```

If a subquery nested inside the consumer re-binds the inner source's name as a
*local* FROM alias, a column qualified by that name is local to the subquery
(innermost-scope SQL rules) — but `nestedSubst` still rewrites it to the outer
inner-CTE's defining expression. When that expression is a renamed/computed base
column, the reference silently binds to the wrong column. No error — wrong result.

### Reproduction (traced through the flattener)

```sql
create table nbase (id integer primary key, color text);
insert into nbase values (1,'red');
create table nother (oid integer primary key, note text, color text);
insert into nother values (1,'red','blue');

with x as (select id, color as note from nbase),
     t as (select id, note from x where exists (select 1 from nother x where x.note = 'red'))
     update t set note='z';
select * from nbase order by id;
-- EXPECTED: [{"id":1,"color":"z"}]   (EXISTS true via nother.note='red')
-- BUG:      [{"id":1,"color":"red"}]  (x.note rewrote to base `color`; in `from nother x`
--                                      that binds nother.color='blue' => EXISTS false)
```

The identity-strip fast path (`innerColumns === null`: `select *` inner, no
rename) is **benign** — its strip only drops the `sourceName.` qualifier and the
resulting bare name resolves to the same local column in the re-bound scope. The
bug is confined to the explicit-projection / renamed-column map path.

## The fix

Replace the blind `mapQueryExprUniform` descent with the **alias-shadow-aware**
descent already living in `scope-transform.ts`. That module owns
`transformAliasScopedQuery` (currently private) / `collectFromAliases`, which
thread a FROM-alias shadow set exactly the way the column-name shadow set is
threaded in `transformScopedQuery`: a select's own FROM aliases join the set for
its clauses and any subquery nested in them; a compound/union leg keeps the
incoming set; VALUES/DML bodies clone through.

The load-bearing subtlety the ticket calls out: the consumer body's OWN single
FROM source *is* `sourceName` (that is precisely what we substitute away), so its
own alias must NOT count as a shadow at the top level. This falls out naturally —
the top consumer scope is rewritten by `transformExpr(e, topSubst, descend)` and
is **not** routed through `transformAliasScopedQuery`. Alias accumulation begins
empty (`NO_ALIAS_SHADOW`) only when `descend` enters a subquery operand, so only
a *nested* FROM alias ever shadows `sourceName`.

### scope-transform.ts

- Export `transformAliasScopedQuery` and give its `aliasShadow` parameter a
  default of `NO_ALIAS_SHADOW` so the flattener can enter a subquery operand at
  the empty top scope without touching the module-private const:

  ```ts
  export function transformAliasScopedQuery(
      query: AST.QueryExpr,
      substitute: (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>) => AST.Expression | undefined,
      aliasShadow: ReadonlySet<string> = NO_ALIAS_SHADOW,
  ): AST.QueryExpr { … }
  ```

  (`NO_ALIAS_SHADOW` at L627 is in scope above the function at L660 — no reorder
  needed. `transformAliasScopedExpr` is already exported and stays the entry for
  expression-rooted callers; the flattener needs the *query-rooted* entry because
  `descend` receives a `QueryExpr`.)

### cte-flatten.ts

- `composeBody`: swap the descent.

  ```ts
  const { topSubst, nestedSubst } = makeSubstitutions(lcSource, innerColumns);
  const descend = (q: AST.QueryExpr): AST.QueryExpr => transformAliasScopedQuery(q, nestedSubst);
  const sub     = (e: AST.Expression): AST.Expression => transformExpr(e, topSubst, descend);
  ```

- `makeSubstitutions`: `nestedSubst` now takes the alias-shadow set and stops
  firing once `lcSource` is shadowed by a nested FROM alias. `topSubst` keeps its
  single-arg signature (the top scope passes no alias set via `transformExpr`).
  Apply the guard to **both** the map path and the strip path (strip is benign
  but the symmetry is correct and harmless):

  ```ts
  // map path
  const nestedSubst = (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>): AST.Expression | undefined =>
      col.table && col.table.toLowerCase() === lcSource && !aliasShadow.has(lcSource)
          ? lookup(col.name) : undefined;

  // strip path (innerColumns === null) — topSubst stays qualified-only single-arg;
  // nestedSubst additionally honours the shadow:
  const nestedStrip = (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>): AST.Expression | undefined =>
      col.table && col.table.toLowerCase() === lcSource && !aliasShadow.has(lcSource)
          ? { type: 'column', name: col.name } : undefined;
  ```

  Update the return type of `nestedSubst` in the function signature to
  `(col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>) => AST.Expression | undefined`.
  Note the strip path previously returned the *same* closure for top and nested;
  now the two differ in arity (top single-arg, nested two-arg), so split them.

- Drop the now-unused `mapQueryExprUniform` import; add `transformAliasScopedQuery`.

### Why this is exactly right (traced)

For the reproduction, `descend` enters the EXISTS subquery `select 1 from nother x
where x.note='red'` with `aliasShadow = {}`. `transformAliasScopedQuery` adds the
subquery's FROM alias `x`, so its WHERE sees `aliasShadow = {x}`; `nestedSubst(x.note,
{x})` returns `undefined` (lcSource `x` is shadowed) → the ref stays `x.note` and
binds to `nother.note='red'` → EXISTS true → write fires → `[{"id":1,"color":"z"}]`.

A genuine correlation (`exists (select 1 from nother where nother.color = x.note)`,
`x` NOT re-bound) enters with FROM aliases `{nother}`; `nestedSubst(x.note, {nother})`
fires (lcSource not shadowed) → still rewritten to the inner base term. Preserved.

## Edge cases & interactions

- **Primary collision (the bug):** nested subquery re-binds `sourceName` as a FROM
  alias and references `<sourceName>.<col>` where `col` is a renamed/computed inner
  output. Must stay local → EXISTS/IN evaluates against the *nested* source. Regression
  in reproduction above.
- **Genuine correlation preserved:** a `<sourceName>.<col>` ref inside a nested
  subquery that does NOT re-bind `sourceName` must STILL be substituted to the inner
  base term. Add a positive regression (see TODO) — this is the over-suppression guard.
- **Identity-strip path unchanged:** `select *` inner, no rename — verify a nested
  re-bind produces the same result as before (the ticket's "benign" claim). No new
  diagnostic, no behavior change.
- **Deeper nesting:** a re-bind two+ subquery levels down — alias accumulation must
  persist downward (`onNested` threads `inner` forward). A `<sourceName>.<col>` ref
  below the re-bind stays local; above it (sibling scope) still substitutes.
- **Compound / union leg inside a nested subquery:** a leg correlates to the SAME
  outer scope, so it keeps the *incoming* alias set, NOT the select's own FROM aliases
  (`onLeg` in `transformAliasScopedQuery`). A `<sourceName>.<col>` in a leg of a
  re-binding select should still see the re-bind only if the re-bind is an *enclosing*
  FROM, not a sibling leg's. Covered by reusing the shared descent — assert by reading,
  optional test.
- **VALUES / DML operand:** `in (values …)` keeps the alias set (no FROM); an embedded
  `INSERT/UPDATE/DELETE … RETURNING` subquery clones through structurally — byte-identical
  to the prior `mapQueryExprUniform` path (`cloneDmlStmt`). No correlation rewrite there.
- **Multi-level chain (CTE-over-CTE):** the fix sits in `composeBody`, which runs once
  per consumer level. Each level's own nested subqueries are rewritten when that level is
  the consumer; inner CTE bodies are flattened recursively and carry their own nested
  descent. A re-bind in an OUTER consumer over a two-level inner must still shadow.
- **Schema-qualified / aliasless sources:** a FROM alias is never schema-qualified;
  `collectFromAliases` uses `alias ?? table.name` (lowercased). `from main.nother` (no
  alias) binds alias `nother`, which does not shadow `x`. A qualifier `x.note` carries no
  schema, so comparison stays lowercase-name only. Consistent with existing lowercasing.
- **Bare names in nested scopes:** `nestedSubst` is qualified-only (never touches bare
  names) — unchanged from today. A bare correlated reference to the consumer source inside
  a nested subquery is out of scope for this fix (pre-existing behavior).
- **topSubst arity:** `transformExpr` calls `substitute(col)` with ONE arg; do NOT give
  `topSubst` a two-arg body that dereferences a (would-be-undefined) alias set. Keep top
  and nested as distinct closures.

## TODO

- scope-transform.ts: export `transformAliasScopedQuery`; default its `aliasShadow`
  param to `NO_ALIAS_SHADOW`. Confirm no other intended consumer of the private name.
- cte-flatten.ts: rewrite `composeBody`'s `descend` to use `transformAliasScopedQuery`;
  make `makeSubstitutions`' `nestedSubst` alias-shadow-aware on both the map and strip
  paths (split the strip path's shared closure into single-arg top + two-arg nested);
  update signatures; swap the import (`mapQueryExprUniform` → `transformAliasScopedQuery`).
- Add regressions to `test/logic/93.4-view-mutation.sqllogic` near the multi-level
  shadow cases (after the `base2` self-name shadow at ~L3277):
  - the reproduction above → `[{"id":1,"color":"z"}]`;
  - a genuine-correlation positive (over-suppression guard):
    ```sql
    create table cbase (id integer primary key, color text);
    insert into cbase values (1,'red');
    create table cother (oid integer primary key, color text);
    insert into cother values (1,'red');
    with x as (select id, color as note from cbase),
         t as (select id, note from x where exists (select 1 from cother where cother.color = x.note))
         update t set note='z';
    select * from cbase order by id;
    → [{"id":1,"color":"z"}]
    ```
  - optional: an identity-strip nested-rebind case to pin the "benign" no-change claim.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/cte.log; tail -n 60 /tmp/cte.log`
  (logic suite is the primary gate); then `yarn workspace @quereus/quereus lint`.
- Update `docs/view-updateability.md` (multi-level CTE body section) to note the
  consumer-rewrite nested descent is alias-shadow-scope-aware (reuses scope-transform).
