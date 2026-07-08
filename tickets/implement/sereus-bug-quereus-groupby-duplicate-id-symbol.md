---
description: Fix a crash when a query groups by two same-named columns from different tables (e.g. `group by i.id, c.id`); it should group correctly instead of failing with a cryptic error.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # createAggregateOutputScope — the crash site
  - packages/quereus/src/planner/scopes/registered.ts            # RegisteredScope — needs Ambiguous support
  - packages/quereus/src/planner/scopes/aliased.ts               # AliasedScope — qualifier→bare stripping (reused)
  - packages/quereus/src/planner/scopes/multi.ts                 # MultiScope — bare-name ambiguity detection (reference)
  - packages/quereus/src/planner/resolve.ts                      # resolveColumn — turns Ambiguous into clear error
  - packages/quereus/src/planner/nodes/aggregate-node.ts         # getGroupByColumnName — attr naming (context)
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic    # add regression cases here
difficulty: medium
---

# GROUP BY of two qualified same-base-name columns crashes at plan time

## Summary

`GROUP BY i.id, c.id` (two *qualified* columns whose base names collide) crashes at
prepare/plan time with:

```
QuereusError: Symbol 'id' already exists in the same scope.   (code 1)
```

Standard SQL permits grouping by two qualified columns with the same base name, and
the sibling query without GROUP BY works. This is a real behavior bug, not just a
message-clarity nit — the fix is to **allow** it.

## Reproduction (confirmed)

```sql
create table items (id integer primary key, name text, category_id integer);
create table categories (id integer primary key, name text, type_id integer);
create table log_entry_items (entry_id integer primary key, item_id integer);

select i.id, i.name, c.id as categoryId, c.name as categoryName, count(lei.entry_id) as usageCount
from items i
join categories c on c.id = i.category_id
left join log_entry_items lei on lei.item_id = i.id
where c.type_id = ?
group by i.id, i.name, c.id, c.name;
```

→ `Symbol 'id' already exists in the same scope.` (Also collides on `name`.)

## Root cause

The AggregateNode advertises one output attribute per GROUP BY key, named by the
key's **base column name** (`aggregate-node.ts` `getGroupByColumnName` → `colRef.expression.name`).
Two qualified keys `i.id` and `c.id` both yield the attribute name `id`.

`createAggregateOutputScope` (`select-aggregates.ts:294-324`) then registers each
GROUP BY output attribute into a **flat** `RegisteredScope` keyed by
`attr.name.toLowerCase()`:

```ts
groupByExpressions.forEach((expr, index) => {
    const attr = aggregateAttributes[index];
    aggregateOutputScope.registerSymbol(attr.name.toLowerCase(), (exp, s) => ...);  // <-- "id" twice → throw
});
```

`RegisteredScope.registerSymbol` (`registered.ts:33`) throws on the second `id`.
That is the sole crash site.

Two coupled problems, not one:

1. **Crash** — duplicate base-name registration throws.
2. **Even without the crash, qualified resolution is broken.** The final projection
   resolves each SELECT-list column against `aggregateOutputScope`. Bare/qualified
   columns (`type === 'column'`) take the *recompute* path
   (`buildFinalAggregateProjections`, the `else` after the fingerprint check) which
   calls `buildExpression(... scope: aggregateOutputScope ...)`. For `i.id`,
   `resolveColumn` probes symbol key `i.id` — but the flat scope only ever registered
   the **bare** `id`, so a qualified key never resolves against the aggregate output.
   A correct fix must make `i.id` / `c.id` resolve to their respective group-key
   output columns, and make a genuinely bare `id` reference *ambiguous* (not silently
   pick one, not fall through to the base-table column below the aggregate).

## Fix design

Rebuild `createAggregateOutputScope` so it mirrors the **source-side** naming
semantics already used for a FROM/JOIN scope (`AliasedScope` per source combined by
`MultiScope`): qualified refs resolve through the matching qualifier; a bare name
shared by two sources resolves to `Ambiguous`; a unique bare name resolves.

For each GROUP BY key that is a `ColumnReferenceNode`, read its original qualifier
from `expr.expression.table` (same field `getGroupByColumnName` reads `.name` from):

- **Register the qualified key** `${qualifier}.${name}` (lowercased) when a qualifier
  is present, pointing at that key's aggregate output column (attr id + index). This
  makes `i.id` and `c.id` resolve distinctly.
- **Register the bare key** `name` **only when it is unique** across all GROUP BY keys.
- **When a bare name is shared by ≥2 GROUP BY keys, mark it ambiguous** so a bare
  reference to it returns `Ambiguous` → `resolveColumn` raises the existing, clear
  `ambiguous column name: id` (see `expression.ts:110`). It must NOT fall through to
  the parent scope (which would wrongly bind to the pre-aggregate base column).
- Non-column GROUP BY keys keep their unique `group_${index}` name — unaffected.
- Aggregate columns keep registering by their alias (unchanged), but a bare name that
  collides with an aggregate alias should likewise be ambiguous, consistent with
  source-side `MultiScope` behavior.

### Recommended implementation

Two viable shapes — pick whichever keeps the diff smallest while passing all cases:

- **(A, recommended) Extend `RegisteredScope` with explicit ambiguity.** Add a small
  API (e.g. `markAmbiguous(key)` recording a `Set<string>`); `resolveSymbol` returns
  `Ambiguous` for a marked key *before* delegating to the parent. Then in
  `createAggregateOutputScope`: count base names first, register qualified keys
  always, register unique bare names, and `markAmbiguous` the colliding bare names.
  Preserves the existing `new RegisteredScope(parentScope)` parent-fallback that
  HAVING / correlated access rely on (per the note at `select-aggregates.ts:318-321`).
  Note the `registerSymbol` duplicate-throw stays as a genuine guard for other
  callers — this path simply stops registering duplicates.

- **(B) Compose `AliasedScope`+`MultiScope`.** One leaf `RegisteredScope` per distinct
  qualifier (bare-keyed), each wrapped in `AliasedScope(qualifier)`, plus one leaf for
  unqualified group keys and one for aggregate aliases, combined via `MultiScope`.
  This reuses existing ambiguity semantics verbatim, but you must re-establish the
  `parentScope` fallback (MultiScope takes no parent) without letting a qualified miss
  in the first leaf leak to the parent before other leaves are tried. (A) avoids that
  wiring hazard, hence the recommendation.

## Message clarity (ticket point 1)

With the behavior fix the reported valid query no longer errors, and the only
remaining error path — a genuinely ambiguous *bare* reference — already yields the
actionable `ambiguous column name: id`. So point 1 is satisfied for the reported case
**without** a bespoke message. Optionally (low priority, out of the hot path once the
above lands), enrich `RegisteredScope.registerSymbol`'s generic
`Symbol '…' already exists in the same scope` to name the clause/columns; treat as a
nice-to-have, not required by this ticket.

## Edge cases & interactions (cover as tests)

- `group by i.id, c.id` (+ `i.name, c.name`) from a JOIN → groups correctly, qualified
  SELECT/aliased columns resolve to the right keys (the exact repro).
- Bare `id` in the SELECT list while two group keys are named `id` → clear
  `ambiguous column name: id`, not a crash and not a silent pick.
- Regression: single-table `group by c.id, c.name` still works.
- Regression: bare `group by grp` (no qualifier) still works — see existing
  `07.3-group-by-extras.sqllogic`.
- Qualified reference in **HAVING** (`having i.id > 0`) and in **ORDER BY**
  (`order by c.id`) resolves to the group key.
- Group-key base name colliding with an **aggregate alias** → ambiguous bare ref.
- Degenerate duplicate key `group by i.id, i.id` → no crash (dedupe or tolerate; the
  qualified key may be registered once).
- Non-column group expr (`group_N`) mixed with qualified column keys → unaffected.
- Two same-named columns both projected **unqualified-but-aliased**
  (`i.id as a, c.id as b`) → output columns `a`,`b` distinct; no crash.
- Physical selection: confirm the fix is at the logical building phase
  (`createAggregateOutputScope`), so both HashAggregate and StreamAggregate paths
  inherit it (they do not rebuild this scope).

## TODO

- Implement the scope fix in `createAggregateOutputScope` per design (A recommended):
  register qualified group-key symbols, register unique bare names, mark colliding
  bare names ambiguous; keep the `parentScope` fallback.
- If choosing (A): add ambiguity support to `RegisteredScope` (`markAmbiguous` + a
  `Set<string>`; `resolveSymbol` returns `Ambiguous` for marked keys before parent
  delegation). Keep the existing duplicate-registration throw for other callers.
- Add regression cases to `packages/quereus/test/logic/07.3-group-by-extras.sqllogic`:
  the multi-table qualified-collision repro (expected rows), plus a negative
  `-- error: ambiguous column name: id` case for a bare ambiguous reference, plus a
  single-table regression.
- Run `yarn test` (fast, memory vtab) and `yarn lint` from `packages/quereus`; both
  must pass. Note in the review handoff whether the optional `registerSymbol` message
  enrichment was done or deferred.
