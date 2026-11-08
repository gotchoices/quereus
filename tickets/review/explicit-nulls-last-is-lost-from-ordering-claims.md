description: A sort or window that asks for NULLs last could return them first, or number them wrongly, because the planner's record of "these rows are already in order" had no place for where NULLs go. The planner now neither claims nor accepts an existing order when NULLs are asked to go last; review the change.
architecture: docs/invariants.md#opt-063--an-ordering-claim-means-nulls-first-a-nulls-last-key-has-none
files: packages/quereus/src/planner/framework/physical-utils.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/rules/access/rule-monotonic-limit-pushdown.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, docs/invariants.md, docs/window-functions.md, packages/quereus/test/optimizer/explicit-nulls-ordering.spec.ts, packages/quereus/test/logic/27.4-window-nulls-placement.sqllogic
----

## What changed

The planner's ordering records (`physical.ordering`, a list of `{ column, desc }`, and `physical.monotonicOn`) have no NULL-placement field. The engine's default puts NULLs first in both directions (`orderByNullResult`), so every claim already meant "NULLs first". Explicit `nulls first` is the default; only `nulls last` differs. The fix states that as invariant OPT-063 and enforces it:

- `extractOrderingFromSortKeys` (physical-utils.ts) takes `nulls?` on its sort keys and returns `undefined` when any key is `nulls last`. All-or-nothing, like the existing computed-key bail, because the grow-retrieve Sort arm drops the whole Sort once a module serves the returned ordering. The `Ordering` interface documents the convention.
- `SortNode.computePhysical` withholds `monotonicOn` when the leading key is `nulls last`. Its `ordering` is withheld by the helper.
- `WindowNode` passes `nulls` through `windowSortKeys()` (so its `ordering` is withheld the same way) and withholds `monotonicOn` on a leading `nulls last` key. The stale NOTE claiming every consumer ignores NULL placement is replaced with a one-line statement of the convention.
- `ruleMonotonicWindow` declines when any window ORDER BY key is `nulls last`. With the producers fixed no source can advertise that placement, so this is exact.
- `rule-grow-retrieve.ts` Sort arm: log text only; the helper refusal does the work.
- **Beyond the ticket:** `ruleMonotonicLimitPushdown` also matches a user sort key against a leaf's `monotonicOn` (attribute and direction only) and drops the Sort. It now declines on `nulls last` too, otherwise the invariant would not hold. Reachable only through a module advertising `supportsOrdinalSeek` plus `monotonicOn` on a nullable column. No in-repo module does: the test module `test/vtab/test-ordinal-seek-module.ts` advertises it on a NOT NULL primary key, where placement cannot change the answer. `repro: static`, no test added. The cost: `order by id nulls last limit n` over that test module now keeps LIMITOFFSET instead of an ORDINALSLICE.
- Docs: OPT-063 added to `docs/invariants.md` after OPT-062 (guard: the 27.4 logic file; the body names the module spec). `docs/window-functions.md` § "What the `WindowNode` advertises as its emit order" gains a paragraph and a bail-condition bullet.

## Other consumers checked, no change

- `rule-lateral-top1-asof`: its sort attribute must be the asof inequality's column, and that inequality filters out NULLs, so placement cannot matter.
- `trySortAbsorbViaIndexOrdering` (grow-retrieve): already refuses any explicit `nulls`.
- `rule-orderby-fd-pruning`: drops only trailing keys determined by earlier ones, where placement cannot matter (documented in its header).
- Merge join, asof merge strategy, stream aggregate: they read `ordering`/`monotonicOn` claims and do not build one from user sort keys, so they inherit the default-placement convention.

## Tests

No new tests in this stage. The two repro tests committed by the fix stage cover the change:

- `test/optimizer/explicit-nulls-ordering.spec.ts`: a module that echoes any `requiredOrdering` back as `providesOrdering`; `order by s nulls last` must keep its Sort. Covers the helper and the grow-retrieve Sort arm.
- `test/logic/27.4-window-nulls-placement.sqllogic`: a default window over a NULLS LAST source, and a NULLS LAST window over a default-ordered source, on a plain memory table. Covers SortNode's claims, WindowNode's `windowSortKeys`, and `ruleMonotonicWindow`.

Both failed on HEAD and pass now. `yarn test` in `packages/quereus`: 11109 passing, 26 pending. `yarn lint` (quereus) clean. `yarn docs:check` OK.

## Known gaps / for the reviewer

- Out of scope, as in the ticket: filling `OrderingSpec.nullsFirst` so a module could serve an explicit placement; relaxing `trySortAbsorbViaIndexOrdering` from "any explicit nulls" to "nulls last"; dropping an explicit placement on a NOT NULL column so such a query keeps its index or streaming window. As a result, `nulls last` on a NOT NULL column now always sorts and never streams. That is correct, just slower than it needs to be.
- The `monotonic-limit-pushdown` change has no test (see above). If the reviewer wants one, the test module would have to advertise on a nullable column.
- The class (unchecked ordering claims) stays tracked by `debt-nothing-checks-advertised-row-order` in backlog; this instance was already appended there by the fix stage.
