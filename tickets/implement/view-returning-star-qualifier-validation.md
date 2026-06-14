description: Validate the `<q>` qualifier in `RETURNING <q>.*` through an updatable view (single- and multi-source) so a wrong qualifier errors like the base-table path instead of silently expanding to all view columns.
files:
  - packages/quereus/src/planner/mutation/single-source.ts   # rewriteViewReturning: `rc.type === 'all'` branch (TODO at ~L1313)
  - packages/quereus/src/planner/mutation/multi-source.ts     # buildReturningProjection: `rc.type === 'all'` branch (TODO at ~L2195)
  - packages/quereus/src/planner/building/returning-star.ts   # base-table path that DOES validate (reference shape / error message)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic   # coverage home
difficulty: easy
----

# View `RETURNING <table>.*` qualifier is not validated

## Problem (reproduced)

A mutation through an updatable view with a wrong `RETURNING` star qualifier —
`returning bogus.*` — silently expands to the full view projection instead of
erroring. The base-table path validates the qualifier and raises
`Table '<name>' not found in FROM clause for qualified RETURNING *`
(`building/returning-star.ts` `expandReturningStar`); the two view paths do not.

Confirmed (engine repro, all on `main` at this branch's HEAD before the fix):

```
-- single-source view: greenmen = select name, color from men where color='green'
insert into greenmen (name) values ('B') returning bogus.*   -- OK -> {"name":"B","color":"green"}   (BUG: should error)
update greenmen set color='green' where name='A' returning bogus.*   -- OK   (BUG)
delete from greenmen where name='B' returning bogus.*   -- OK   (BUG)
returning greenmen.*   -- OK -> expands (correct, must stay)

-- multi-source join view: rjoin = select c.cid, c.note, p.label from rc c join rp p on p.pid=c.pref
update rjoin set note='B' where cid=1 returning bogus.*   -- OK   (BUG)
delete from rjoin where cid=2 returning bogus.*   -- OK   (BUG)
returning rjoin.*   -- OK -> expands (correct, must stay)

-- base table (reference behavior, already correct):
update t set b='y' where a=1 returning bogus.*
  -- ERROR: Table 'bogus' not found in FROM clause for qualified RETURNING *
```

Both view-path `rc.type === 'all'` branches iterate **all** view columns
regardless of `rc.table`, with a `TODO` marker noting the gap.

## Root cause

In both `rewriteViewReturning` (single-source.ts ~L1310) and
`buildReturningProjection` (multi-source.ts ~L2194), the `rc.type === 'all'`
branch expands every view column and never inspects `rc.table`.

## Correction

The qualifier to validate against is **`view.name`** — and this is already in
scope in both functions (`view: MutableViewLike` is a parameter of each). No new
plumbing is needed:

- For a **named view / MV** target, `view.name` is the view name. A named-view
  mutation target carries no user alias — the parser only populates `stmt.alias`
  for an inline-subquery target (`AST.UpdateStmt.alias` doc), so the view name is
  the only valid qualifier.
- For an **inline-subquery / CTE-name** target, `resolveSubqueryTarget` /
  `resolveCteTarget` set `view.name = source.alias` (the user's `as v`), so
  `view.name` is again exactly the spelled qualifier the user can write
  (`update (select …) as v … returning v.*`). The same `view` flows into
  `analyzeJoinView`, so the multi-source path sees the same `view.name`.

So the ticket's anticipated "thread the view identity into `buildReturningProjection`"
is unnecessary — it already receives `view`. The fix is a guard at the top of
each `rc.type === 'all'` branch:

```ts
if (rc.table && rc.table.toLowerCase() !== view.name.toLowerCase()) {
    throw new QuereusError(
        `Table '${rc.table}' not found in FROM clause for qualified RETURNING *`,
        StatusCode.ERROR,
    );
}
```

Use the **original** `rc.table` spelling in the message (matching the base-table
path), compare lowercased (matching `assertTopLevelViewColumns` and the
base-table path).

### Diagnostic shape — decision

The ticket asks for parity with the base-table diagnostic
(`Table '<q>' not found in FROM clause for qualified RETURNING *`, a plain
`QuereusError` with `StatusCode.ERROR`). Use that exact message/shape so the
`*` case reads identically across base-table and view paths — even though the
view path's **non-star** wrong-qualifier guard (`assertTopLevelViewColumns` →
`raiseUnknownViewColumn`) emits the view-framed `cannot write through view …`
message. The two diverge only on the `*` form; that is the explicit intent
(cross-path consistency for `RETURNING *`). `single-source.ts` already imports
nothing for this; both files will need `QuereusError`
(`../../common/errors.js`) and `StatusCode` (`../../common/types.js`) imports if
not already present — check and add.

### DRY note

The check is a two-line throw at two call sites. A tiny shared helper
(e.g. `assertReturningStarQualifier(rcTable: string | undefined, viewName: string)`
exported from `single-source.ts`, imported by `multi-source.ts` alongside the
existing `guardTopLevelScope`/`assertTopLevelViewColumns` imports) is the
cleaner home and keeps the message string single-sourced. Optional — inline in
both is acceptable if it reads better; the message string is the test contract.

## Coverage

Add to `test/logic/93.4-view-mutation.sqllogic` (reuse the existing `greenmen2`
single-source filter view ~L2391 and the `rjoin` multi-source join view ~L2409,
or add fresh fixtures near them). The `-- error: <substring>` assertion form is
already used in that file (e.g. ~L2451). Substring to assert:
`not found in FROM clause for qualified RETURNING *`.

- single-source INSERT: `insert into <view> (…) values (…) returning bogus.*` → error
- single-source UPDATE: `update <view> set … where … returning bogus.*` → error
- single-source DELETE: `delete from <view> where … returning bogus.*` → error
- multi-source UPDATE: `update rjoin set … where … returning bogus.*` → error
- multi-source DELETE: `delete from rjoin where … returning bogus.*` → error
- regression (must still expand): a correct `<view>.*` through both a
  single-source and a multi-source view (the file already exercises
  `returning *` and `rjoin.*`-style expansion at ~L2398/2428 — add or confirm a
  `<view>.*` qualified-correct case).

## TODO

- single-source.ts `rewriteViewReturning`: add the qualifier guard at the top of
  the `rc.type === 'all'` branch; remove the `TODO` comment (~L1313–1316).
- multi-source.ts `buildReturningProjection`: same guard at the top of its
  `rc.type === 'all'` branch; remove the `TODO` comment (~L2195–2198).
- Add `QuereusError`/`StatusCode` imports where missing (or route through a shared
  helper).
- Add the sqllogic coverage above to `93.4-view-mutation.sqllogic`.
- Run `yarn workspace @quereus/quereus test` (or the file-filtered logic run) and
  `yarn lint` (type-checks test call sites). Confirm the wrong-qualifier cases
  error and the correct `<view>.*` cases still expand.
