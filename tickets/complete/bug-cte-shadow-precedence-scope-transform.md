---
description: When a query defines a temporary named result set with the same name as a real table, the analysis behind updates through views and temporary names now checks the temporary names first, matching query execution, so such an update no longer changes the wrong rows.
architecture: docs/view-updateability.md
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts    # tableSourceColumnNames — resolution order changed
  - packages/quereus/src/planner/building/select.ts             # buildFrom — the order being mirrored
  - packages/quereus/test/logic/13.10-cte-qualified-name.sqllogic # regression section at end
  - docs/vu-operators.md
  - docs/view-updateability.md
repro: verified
---

# Static shadow analysis checks `cteNodes` before the catalog

## Summary

`tableSourceColumnNames` (`planner/mutation/scope-transform.ts`) resolves an unqualified FROM name in the same order as `buildFrom`: the `with`-clause definitions the descent has met, then the statement's `ctx.cteNodes` (statement CTEs and injected eager-capture relations), then `findSchemaItem` (catalog). Schema-qualified names skip both CTE maps. Before the fix, a bare name that was both a statement CTE and a real table got the table's columns in the analysis, so an inner column was treated as a correlation to the outer target row and the update touched fewer rows than the equivalent select.

Landed in `ticket(implement): bug-cte-shadow-precedence-scope-transform`, plus the review additions below.

## Review findings

- **Correctness of the change** — read `buildFrom` (`building/select.ts` ~line 518): it checks `cteNodes` before `findSchemaItem` and only for unqualified names. The new order in `tableSourceColumnNames` matches it. Nested `with` clauses: the descent's own map is checked first, then `ctx.cteNodes`, which matches `buildWithContext` letting inner definitions shadow outer ones. Views are unaffected (`fromResolutionContext` / `storedBodyContext` clear `cteNodes`). No problems found.
- **Regression test discriminates** — temporarily put the pre-fix `scope-transform.ts` back and ran `13.10-cte-qualified-name.sqllogic`: the implementer's case fails (id=2 stays 20), as the ticket claimed. The fixed file was restored afterwards.
- **Untested arms the handoff listed** — spot-checked both:
  - CTE-name target self-read while a real table `t` exists (`with t as (select id, val from other) update t set val = 7 where exists (select 1 from t where id = 3)`): passes with the fix and **fails on the pre-fix code** (only id=3 updated). This goes through the injected eager-capture relation, not a statement CTE, so it is a separate path. Added it as a second case in the same 13.10 section.
  - Inline subquery target whose predicate reads a statement CTE that shadows a real table: passes. Not kept as a test because it uses the same statement-CTE lookup the existing case already pins.
- **Docs** — `docs/vu-operators.md` was updated by the implementer. `docs/view-updateability.md` (the anchor) described the "with definition before catalog" rule but said nothing about the `cteNodes` step; added one sentence stating the full order.
- **Source hygiene** — the long comment describing the mismatch as a tracked bug was replaced with a short statement of the order; no narration. Function stays small. No issues.
- **Other call sites** — `single-source.ts` ~line 562 calls `findSchemaItem` directly on a view *body's* source under the body's home path, where `cteNodes` does not apply. Not affected.
- **Related open ticket** — `tickets/fix/bug-duplicate-from-qualifier-resolves-inconsistently.md` cites this ticket as a related case; it covers duplicate qualifiers within one FROM, which is a different site. Nothing to add there.
- **Tripwires / new tickets** — none. Nothing conditional was found.
- **Validation** — `yarn workspace @quereus/quereus test`: 11174 passing, 23 pending, 0 failing. `yarn workspace @quereus/quereus lint`: clean.
