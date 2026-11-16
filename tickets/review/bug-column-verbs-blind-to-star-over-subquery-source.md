description: Renaming or dropping a table column now sees columns that pass through a nested query in a FROM clause, so saved views keep working after a rename, a drop is refused while a rule still reads the column through such a query, and a CHECK no longer changes meaning when its nested query reads a like-named column from another table.
files:
  - packages/quereus/src/schema/rename/column-rename.ts                 # the whole change
  - packages/quereus/test/schema/column-scope-body-spellings.spec.ts     # two cells un-pended, header rewritten
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic   # cases 15b, 15c
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # case 4 subquery-source variant
  - packages/quereus/src/schema/schema-differ.ts                         # comment only (realSources → real-table sources)
  - docs/sql-alter.md, docs/sql-ddl.md, docs/sql-alter-rename.md
----

# Column verbs: infer the output columns of a FROM-clause subquery source — review handoff

## What changed (all in `schema/rename/column-rename.ts`)

The rename/drop scope walk used to register nothing for a FROM-clause subquery source (`from (select …) s`) or a function source. Now:

- **Visit order.** The select arm visits each FROM source's own contents (subquery bodies, function-source args) *before* building and pushing the select's FROM frame (`visitFromSourceContents`), then visits join conditions *after* (`visitJoinConditions`). The `join` / `subquerySource` / `functionSource` arms of `visitColumnRename` are gone; nothing else routed FROM nodes through it.
- **Subquery source binding** (`collectSubquerySource`). No column list and the already-rewritten body re-exposes the renamed column → alias binds the rename target (like an exposing CTE). Otherwise → alias binds `derivedSourceKey(alias)` (a NUL-containing key no real object key can equal).
- **Askable sources.** `ScopeFrame.realSources` became `sources: FrameSource[]` with `{ key, publishes(colLower) }`. Real tables answer via `resolveColumnInSource` (false when no callback). Subquery sources answer from their column list, or lazily via the new `queryPublishesColumn` against a snapshot of the scope stack taken when the source was bound (so the body sees its enclosing CTEs, not frames pushed later). `unqualifiedRefBinding`'s shadow scan and `resultColumnPublishesName` (`*` / `q.*` expansion) both use it.
- **`bodyPublishesColumnNamed`** is now a thin wrapper over `queryPublishesColumn`.
- **Function sources** bind `alias ?? functionName` (matching the planner's `registerColumnScope`) to a derived key, so `f.x` no longer falls through to a real table named `f`. Not askable (see gaps).

## Deviations from the ticket's design — please check these

1. **`join lateral` exists.** The ticket said the parser has no `lateral`; it does (`JoinClause.isLateral`, planner `buildJoin` exposes the left side's scope to the right). Visiting every subquery body before the frame would have stopped rewriting a lateral body's correlated reference to its left side. `visitFromSourceContents` pushes a frame built from `join.left` while visiting a lateral right side. Checked with a throwaway case: `select t.id, s.y from t join lateral (select x + u.n as y from u where u.id = t.id) s on 1 = 1` keeps planning after `rename column x to z`. No committed test for lateral.
2. **Function-source args moved to the pre-frame pass** too (the ticket kept them post-frame). The planner builds a function source on the enclosing context (`buildTableFunctionCall(fromClause, parentContext)`), so non-lateral args cannot see sibling sources; lateral is handled as in item 1.
3. **The shadow scan no longer requires the `resolveColumnInSource` callback.** Real-table sources still answer false without it (old behaviour), but a subquery source can answer from bare projection names or its column list without any callback.

## Tests

- `column-scope-body-spellings.spec.ts`: the two subquery-source spellings now run on every arm (rename keeps the view planable and shifts the published name; drop refuses for a direct assertion read and for a republish-through-view read; drop accepts when no rule reads the column). The ticket's arms 1–3 are these cells. `RESIDUAL` / `pending*` plumbing removed.
- `41.3` case **15b**: ticket arm 4 — CHECK `(select min(v) from (select v from u) s) > 0` keeps reading `u.v` across `rename column v to vv` (a second `-1` insert still succeeds). Fails without the fix with `CHECK constraint failed: … min(vv) …`.
- `41.3` case **15c**: a function source's qualifier is bound — view `select f.value as n from json_each('[7]') f` survives renaming `value` on a real table named `f`. Fails without the fix with `f.val isn't a column`.
- `41.10.2` after case 4: drop half of arm 4 — `drop column v` accepted when only a CHECK reads `v` through `(select v from DcSrc) s`. Fails without the fix (false refusal).

Each new sqllogic case was confirmed failing with the corresponding arm disabled and passing with it.

Throwaway checks also run and deleted (not committed): nested `(select * from (select * from t) s1) s2` plus a reader view follows a rename, and the drop is refused under an assertion; explicit column list `s(a)` leaves the outer `a` alone; `s.x` qualified follows; `select x from (select x as x from t) s` keeps outer `x` (aliased inner projection); the collision pre-flight now refuses `select s.*, 1 as z from (select id, x from t) s` on `rename x to z`; a sibling subquery source's own `x` is not captured.

## Validation

- `yarn workspace @quereus/quereus run lint` clean; `yarn test` all green.
- Store mode for `41.*` / `42.*` sqllogic files green. Note: `@quereus/store` calls the walkers through `@quereus/quereus`'s **built `dist`**, so store-mode runs need `tsc -b tsconfig.build.json` first. Before rebuilding, 15b failed in store mode only because of the stale `dist`.

## Known gaps

- **Function sources and non-exposing CTE sources are still not askable**, so a bare ref binding only through one can be captured by an outer binding to the altered table. Both reproduced: `check ((select min(value) from json_each('[1]')) > 0)` changes meaning on `rename column value`, and `with c as (select v from u) select id from t where exists (select 1 from c where v > 8)` silently starts reading `t.w` after `rename column v to w`. Filed as `tickets/backlog/bug-column-verbs-capture-bare-ref-through-unaskable-source.md` (one ticket, two arms, same site); documented as the known limit in `docs/sql-alter.md` / `docs/sql-ddl.md`.
- **Lateral exposure**: a lateral subquery's bare projection of a column it reads from its left side is not counted as re-exposing it (exposure checks only the body's own frame). Tripwire `NOTE:` on `visitFromSourceContents`.
- **Re-inference cost**: `queryPublishesColumn` rebuilds frames per question, recursively. Tripwire `NOTE:` at the function.
- A subquery source that re-exposes the target *and* also publishes a different column under the old name (only possible if the body had duplicate output names before the rename) would have an outer bare ref of that name captured. Not handled; contrived.
- `column-rename.ts` grew from 1,520 to 1,627 lines (`wc -l`) (already listed in `tickets/backlog/debt-oversized-source-files.md`).
