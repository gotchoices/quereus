---
description: When a query defines a temporary named result set with the same name as a real table, the analysis behind updates through views and temporary names now checks the temporary names first, matching query execution, so such an update no longer changes the wrong rows.
architecture: docs/view-updateability.md
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts    # tableSourceColumnNames — resolution order changed
  - packages/quereus/src/planner/building/select.ts             # buildFrom — the order being mirrored
  - packages/quereus/test/logic/13.10-cte-qualified-name.sqllogic # new regression section at end
  - docs/vu-operators.md                                        # ~line 297, one clause added
repro: verified
---

# Review: static shadow analysis checks `cteNodes` before the catalog

## What changed

`tableSourceColumnNames` (`planner/mutation/scope-transform.ts`) now resolves an unqualified FROM name in the same order as `buildFrom`: the descent's own `with`-clause map, then the statement's `ctx.cteNodes` (statement CTEs and injected eager-capture relations), then `findSchemaItem` (catalog). Qualified names skip both CTE maps, as before. The long comment that documented the mismatch as a tracked bug was replaced with a short statement of the order. `docs/vu-operators.md` ~line 297 now says the `cteNodes` lookup happens ahead of the catalog.

Before the fix, a bare name that was both a statement CTE and a real table got the table's columns in the analysis, so an inner column like `x` was not recognised as local and was rewritten as a correlation to the outer target row — the update touched fewer rows than the equivalent select.

## Test added

- `test/logic/13.10-cte-qualified-name.sqllogic`, section "Bare name shadows a real table on the write path too": `with s as (… from other), t as (select x, y from s) update t set y = 5 where exists (select 1 from s where x = 3)` with a real table `s(a, b)` present; asserts both rows of `other` are updated. This is the ticket's reproduction (before the fix only id=3 was updated, observed during the fix stage).

## Validation

- `yarn workspace @quereus/quereus test` — 11174 passing, 23 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` — clean.

## Not separately tested (same site, should now also be correct)

- CTE-name target self-read (`with t as (…) update t … where id in (select id from t)`) while a real table `t` exists — the eager-capture relation under `t` in `cteNodes` should now win, as at plan time.
- Inline subquery target whose predicate reads a statement CTE that shadows a real table.

Neither was run by hand; a reviewer may want to spot-check one. Views are unaffected (`storedBodyContext` clears `cteNodes`). The regression test was not re-run against the pre-fix code in this stage; the fix-stage experiment established the failure.
