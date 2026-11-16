---
description: Renaming or dropping a table column ignores columns that pass through a nested query in a FROM clause, so saved views break silently after a rename, drops go through while a rule still reads the column, and a CHECK constraint can quietly change meaning. The fix teaches the rename/drop analysis which columns a nested query outputs.
prereq: column-scope-walk-binds-aliased-sources
files:
  - packages/quereus/src/schema/rename/column-rename.ts       # ScopeFrame.realSources, collectFromBindings 'subquerySource' arm (~713), select arm of visitColumnRename (~950), unqualifiedRefBinding, queryExposesRenamedColumn, bodyPublishesColumnNamed / resultColumnPublishesName
  - packages/quereus/src/schema/column-republication.ts       # consumer — no change expected
  - packages/quereus/src/runtime/emit/drop-column-guards.ts   # consumer — no change expected
  - packages/quereus/src/schema/column-source-resolver.ts     # view-source resolver already recurses through bodyPublishesColumnNamed
  - packages/quereus/test/schema/column-scope-body-spellings.spec.ts   # two pending cells become live
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic # home of the "like-named inner column must not be captured" cases
  - docs/sql-alter.md                                         # line ~84 "Known limit — a subquery or function source"
  - docs/sql-ddl.md                                           # line ~469 same limit, assertion arm
difficulty: hard
repro: verified
---

# Column verbs: infer the output columns of a FROM-clause subquery source

## Background

`ALTER TABLE … RENAME COLUMN` and `ALTER TABLE … DROP COLUMN` share one scope-aware walk over stored bodies (view / materialized-view bodies, assertion bodies, CHECK / DEFAULT / generated expressions) in `packages/quereus/src/schema/rename/column-rename.ts`. For each `select` it builds a `ScopeFrame` from the FROM clause (`buildScopeFrame` → `collectFromBindings`):

- a **real table** source binds its qualifier (alias or bare name) to the table's object key and is recorded in `frame.realSources`, which lets the walk ask the catalog (`resolveColumnInSource`) whether it exposes a column;
- a **CTE** source binds to the rename target when the CTE body re-exposes the renamed column (`cteExposesRenamedColumn`), otherwise registers as a shadowing qualifier;
- a **subquery source** (`from (select …) s`) and a **function source** register **nothing** — no qualifier, no column set (the `case 'subquerySource': case 'functionSource': break;` arm).

Every bug below comes from that one empty arm.

## Reproduced (all four, against HEAD)

1. **Rename, star over a subquery source — downstream view breaks.**
   ```sql
   create table t (id integer primary key, x integer);
   create view v as select * from (select * from t) s;
   create view w as select x from v;
   alter table t rename column x to z;   -- ok
   select * from w;                      -- ERROR: Column not found: x
   ```
   `v` now publishes `z`, but the cascade never saw `v` as republishing `t.x` (`bodyExposesRenamedColumn` → `isResultColumnExposure` → `frameBindsTarget` finds nothing bound), so `w` was not rewritten.

2. **Drop, star over a subquery source — accepted while an assertion reads it.**
   ```sql
   create view v as select * from (select * from t) s;
   create assertion a1 check (not exists (select 1 from v where x < 0));
   alter table t drop column x;          -- accepted; must refuse naming a1
   ```
   Same root: `collectColumnRepublication` never adds `v` as a target.

3. **Rename, bare outer ref over a subquery source — the view itself breaks.**
   ```sql
   create view v as select id, x from (select id, x from t) s;
   alter table t rename column x to z;
   select * from v;                      -- ERROR: Column not found: x
   ```
   The inner select is rewritten; the outer bare `x` binds through `s`, which the frame does not bind, so it is left alone. (DROP refuses correctly here — the inner select spells the column in its own frame.)

4. **New arm found during this fix — false capture changes a CHECK's meaning; DROP false-refuses.**
   ```sql
   create table u (id integer primary key, v integer); insert into u values (1, 1);
   create table t (id integer primary key, v integer check ((select min(v) from (select v from u) s) > 0));
   insert into t values (1, -1);         -- ok (min(u.v) = 1)
   alter table t rename column v to w;
   insert into t values (2, -1);         -- ERROR: CHECK constraint failed: ... (select min(w) from (select v from u) as s) > 0
   ```
   The bare `min(v)` binds `s.v` (i.e. `u.v`), but because `s` contributes no column set, `unqualifiedRefBinding` walks past that frame to the CHECK's implicit seed binding for `t` and rewrites it to `w` — the constraint now tests the new row's own column instead of `u`. The DROP guard shares the walk, so on `create table t (id …, v integer, k integer check ((select min(v) from (select v from u) s) > 0))`, `alter table t drop column v` is refused ("referenced by CHECK constraint '_check_k'") when it should be accepted.

All four were run with a throwaway mocha spec (deleted afterwards).

## Fix design

Treat an inline subquery source the way the walk already treats a CTE, plus give it an askable column set.

### 1. Visit subquery-source bodies before building the frame

The CTE path rewrites a CTE body first (`pushWithFrame`) and only then asks `cteExposesRenamedColumn`, because exposure is judged against the **new** name (`queryExposesRenamedColumn` compares with `state.newCol`). Subquery sources need the same order. In the `select` arm of `visitColumnRename`, after `pushWithFrame` and **before** `buildScopeFrame(stmt.from, state)`, walk the FROM tree and `visitColumnRename` each `subquerySource.subquery`. Then, in the existing post-frame pass `(stmt.from ?? []).forEach(f => visitColumnRename(f, state))`, do not re-visit those bodies — only join conditions and function-source args still need the frame (a small dedicated FROM visitor, or a flag; don't rely on re-visiting being idempotent).

Scoping side-effect, an improvement: today a subquery source's body is visited with its own enclosing select's frame already pushed, so an inner bare ref that binds nothing inside could be captured by a *sibling* FROM source. A non-lateral derived table can't see siblings (the parser has no `lateral`), so visiting it before the frame is pushed is the correct scope.

### 2. Bind the subquery source's alias (it is required: `SubquerySource.alias: string`)

In `collectFromBindings`, `case 'subquerySource'`:

- **No explicit column list** (`SubquerySource.columns` undefined) and `queryExposesRenamedColumn(subquery, state)` is true → `bindQualifier(frame, alias, state.targetKey)`, exactly like an exposing CTE. This alone fixes arms 1–3: `frameBindsTarget` now sees the target, so the outer bare `x` / qualified `s.x` is rewritten, and a `*` / `s.*` counts as exposure for the republication scan.
- **Otherwise** → bind the alias to a synthetic per-source key that can never equal a real object key (real keys are `<schema>.<name>` built from identifiers — the same NUL trick as `PROBE_TARGET_KEY`, e.g. `'\u0000derived\u0000' + aliasLower`). Binding it in `qualifiers` (rather than only in `ctesShadowingSource`) means `resolveQualifierBinding` returns a non-target key for `s.x`, `isQualifierReboundAboveSeed` sees `s` as rebound, and `s.*` can be looked up — all with no new special cases.
- An explicit column list (`(select …) s(a, b)`) pins the published names, same rule as `cte.columns`: never exposing.

`queryExposesRenamedColumn` builds frames with `buildScopeFrame`, so nested subquery sources (`from (select * from (select * from t) s1) s2`) recurse naturally.

### 3. Generalize `realSources` into an askable source list

`ScopeFrame.realSources` is consumed in two places: the shadow check in `unqualifiedRefBinding` ("does an inner source expose `oldCol`? then the bare ref binds there") and `resultColumnPublishesName` (the rename cascade's collision pre-flight, `bodyPublishesColumnNamed`). Both need subquery sources too. Replace the entry shape `{ key, schemaLower, nameLower }` with something like:

```ts
interface FrameSource {
	/** The key this source's qualifier is bound to (real key, targetKey, or the synthetic derived key). */
	key: string;
	/** Whether this source publishes a column named `colLower` — catalog for a real table, recursive for a subquery. */
	publishes(colLower: string): boolean;
}
```

- real table: `colLower => !!state.resolveColumnInSource?.(schemaLower, nameLower, colLower)` (today's call sites already gate on the callback being present; keep that gating behaviour — no callback means "not askable", answering false).
- subquery source: column list → `columns.some(c => c.toLowerCase() === colLower)`; else a shared query-level publish probe over the subquery body, run **against the current `state.scopeStack`** so the subquery can still see enclosing CTEs. Factor that probe out of `bodyPublishesColumnNamed` (which builds its own fresh state) — e.g. `queryPublishesColumn(query, colLower, state)` — and make `bodyPublishesColumnNamed` a thin wrapper over it, the same way `bodyExposesRenamedColumn` wraps `queryExposesRenamedColumn`.

Fixes arm 4: in the CHECK case the frame for `from (select v from u) s` now holds a source whose `publishes('v')` is true and whose key is not the target, so `unqualifiedRefBinding` returns `undefined` and the seed never captures. The existing `if (src.key === state.targetKey) continue;` skip still applies to an exposing subquery source (its key *is* the target), so case 3 is not shadowed.

Evaluation order matters for `publishes(oldCol)` in the shadow check: the subquery body has already been rewritten (step 1), so a body that exposed the target's `oldCol` now publishes `newCol` and stops shadowing; a body that publishes a like-named column from another table still says `oldCol` and shadows. Make `publishes` lazy (closure), not precomputed, so frames for bodies nobody asks about cost nothing.

`resultColumnPublishesName` then reads `frame.sources.some(src => src.publishes(nameLower))` for `*` and filters by `src.key === key` for `q.*` — no other change.

### 4. Function sources — minimum change only

A function source's column set is still not inferable here. Register its alias (when present) under a synthetic key in `qualifiers`, so a qualified `f.x` stops falling through to `resolveRef(undefined, 'f')` (which would wrongly hit a real table named `f` that happens to be the rename target). Do not add it to the source list (no askable column set); leave a one-line `NOTE:` that a bare ref can still be captured past a function source that publishes a like-named column. The spec header already argues there is no reachable function-source cell for the view/assertion matrix.

### Consumers needing no change

`column-republication.ts` (`scanShiftedPublishers`, `collectColumnRepublication`) and `drop-column-guards.ts` only call `renameColumnInAst` / `bodyExposesRenamedColumn` / `bodyPublishesColumnNamed` / `columnReferencedInAst`; they pick the fix up for free. `schema/expr-scope/frame.ts` is a separate, deliberately conservative model (subquery sources are "opaque" there and block capture) — out of scope.

## Tests

The reproductions already exist as pending cells; un-pending them is the main test work.

- `packages/quereus/test/schema/column-scope-body-spellings.spec.ts`: drop `pendingRename` / `pendingDrop` from the two subquery-source spellings; delete the `RESIDUAL` constant and `pending*` plumbing if nothing else uses it; rewrite the header paragraph about pending cells (keep the sentence explaining why there is no function-source cell).
- One arm-4 case in `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`, next to the existing like-named inner-column cases (~line 1105 / 1220): a CHECK `((select min(v) from (select v from u) s) > 0)` keeps reading `u.v` across `rename column v to …` (a `-1` insert still succeeds after the rename), and `drop column v` on that table is accepted when only that CHECK mentions `v`. Prefer the drop half in `41.10.2-alter-drop-column-check-and-assertion.sqllogic` if that file is a better home.
- No separate test for the function-source alias registration unless it turns out trivially expressible in the same sqllogic block.

## Docs / comments to update

- `docs/sql-alter.md` ~line 84 ("Known limit — a subquery or function source"): remove the subquery half; keep only what remains true for function sources (if anything user-visible).
- `docs/sql-ddl.md` ~line 469: same.
- `column-rename.ts` doc comments that describe the residual: `ScopeFrame.realSources` (~55), `renameColumnInCheckExpression` "Limitation" paragraph (~139), `bodyPublishesColumnNamed` (~513), the `collectFromBindings` subquery arm (~713), `resolveQualifierBinding` (~798).

## Notes

- `column-rename.ts` is 1,520 lines (`wc -l`, 2026-11-16) and already listed in `tickets/backlog/debt-oversized-source-files.md`; don't split it in this ticket, but keep the new code in small functions (e.g. `collectSubquerySource`, `queryPublishesColumn`, a FROM pre-visit helper).
- Recursive inference re-builds frames for nested subquery sources once per exposure/publish question. Nesting depth in stored bodies is small; if it ever shows in profiles, memoize per `SubquerySource` node within one walk — leave that as a `NOTE:` tripwire at the probe, not a ticket.

## TODO

- Select arm: pre-visit FROM subquery-source bodies before `buildScopeFrame`; stop the post-frame FROM pass from re-visiting them (keep join conditions + function-source args).
- `collectFromBindings` subquery arm: exposing → bind alias to `targetKey`; otherwise (incl. explicit column list) → bind alias to a synthetic derived key.
- Replace `realSources` with an askable `sources: FrameSource[]` (lazy `publishes`), real + subquery entries; update `unqualifiedRefBinding` and `resultColumnPublishesName`.
- Factor `queryPublishesColumn(query, colLower, state)` out of `bodyPublishesColumnNamed`; use it for subquery-source `publishes`.
- Function-source arm: bind alias to a synthetic key; `NOTE:` on the remaining bare-capture limit.
- Un-pend the two cells in `column-scope-body-spellings.spec.ts`; update its header.
- Add the arm-4 CHECK rename/drop case to sqllogic.
- Update `docs/sql-alter.md`, `docs/sql-ddl.md`, and the residual-describing doc comments in `column-rename.ts`.
- `yarn workspace @quereus/quereus run lint` and `yarn test` green.
