description: A sort or window that asks for NULLs last could return them first, or number them wrongly, because the planner's record of "these rows are already in order" had no place for where NULLs go. The planner now neither claims nor accepts an existing order when NULLs are asked to go last.
architecture: docs/invariants.md#opt-063--an-ordering-claim-means-nulls-first-a-nulls-last-key-has-none
files: packages/quereus/src/planner/framework/physical-utils.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/rules/access/rule-monotonic-limit-pushdown.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, docs/invariants.md, docs/window-functions.md, packages/quereus/test/optimizer/explicit-nulls-ordering.spec.ts, packages/quereus/test/logic/27.4-window-nulls-placement.sqllogic
----

## What landed

The planner's ordering records (`physical.ordering`, a list of `{ column, desc }`, and `physical.monotonicOn`) have no NULL-placement field, and the engine default is NULLs first in both directions (`orderByNullResult`, `util/comparison.ts`). Invariant OPT-063 in `docs/invariants.md` states that every claim means "NULLs first", so a NULLS LAST key neither produces nor accepts one:

- `extractOrderingFromSortKeys` returns `undefined` when any key is `nulls last` (all-or-nothing, because the grow-retrieve Sort arm drops the whole Sort once a module serves the returned ordering).
- `SortNode` and `WindowNode` withhold `monotonicOn` on a NULLS LAST leading key; `WindowNode.windowSortKeys()` now carries `nulls`, so its `ordering` is withheld through the helper.
- `ruleMonotonicWindow` and `ruleMonotonicLimitPushdown` decline when the user's key asks for NULLS LAST.
- `docs/window-functions.md` documents the window side.

Implemented in `ticket(implement): explicit-nulls-last-is-lost-from-ordering-claims`; repro tests from `ticket(fix): bug-explicit-nulls-placement-is-lost-when-a-module-serves-order-by`.

## Review findings

**Checked:** the full implement diff; every reader of `nulls` in `src/planner`; every rule that reads `physical.ordering` or `monotonicOn` (merge join, asof strategy select, key-set seek, monotonic range access, lateral top-1 asof, orderby FD pruning, select access path); that `orderByNullResult` is direction-independent, so "NULLs first in both directions" is true; the runtime window emitter sorts with the clause's `nulls`, so withholding the window's claim matches what it actually emits; docs `invariants.md` and `window-functions.md`.

**Found and fixed:**

- Test gap: the 27.4 logic file's two cases did not exercise what `WindowNode` itself advertises. The ticket claimed they covered `windowSortKeys`, but in both the consumer above the window is a Sort on `rn`, not on `s`. Added a window-over-window case: the inner window sorts `s nulls last`, the outer asks for the default. I confirmed it fails (outer `rn = 1` goes to `'a'` instead of NULL) with `windowSortKeys` dropping `nulls`, and passes with the fix.
- Minor DRY in `WindowNode.computePhysical`: the `monotonicOn` derivation re-read `windowSpec.orderBy[0].direction`/`.nulls` and `orderByExpressions[0]`, duplicating `windowSortKeys()`. It now builds the sort keys once and uses the leading key for both claims, so the direction reading and NULL check cannot drift from the `ordering` derivation.

**No change needed:**

- `rule-lateral-top1-asof`: its sort column is the asof inequality's column, and the inequality filters out NULLs.
- `trySortAbsorbViaIndexOrdering`: already refuses any explicit `nulls`.
- `rule-orderby-fd-pruning`: it drops only trailing keys that earlier keys determine, or the whole Sort over a source of at most one row. NULL placement cannot matter in either case.
- Merge join, asof strategy, stream aggregate, key-set seek, range access: they read claims and never build one from user sort keys, so they inherit the convention.
- `ruleMonotonicLimitPushdown` arm: untested, as the handoff said. No module in the repo advertises `supportsOrdinalSeek` with `monotonicOn` on a nullable column (the test module uses a NOT NULL primary key), so no test can reach it. The check is one line, and the invariant names it. Adding a test would mean changing the test module just for this, which isn't worth it.

**Tripwires / tickets:** none filed. The known slowdowns (NULLS LAST on a NOT NULL column always sorts and never streams; a module cannot serve an explicit placement because `OrderingSpec.nullsFirst` is unfilled) are out of scope and correct-but-slower. They are already listed as out of scope in the plan lineage. The class (nothing checks advertised row order) stays tracked by backlog `debt-nothing-checks-advertised-row-order`.

**Validation:** `yarn test` in `packages/quereus`: 11109 passing, 26 pending. `yarn lint` (quereus) exit 0. `yarn docs:check` OK (its near-cap warnings on `sql-select.md` and `types.md` were there before; this ticket doesn't touch those files).
