description: When a storage module says it handles a filter the engine cannot turn into an index lookup, such as "is null" or "like", the engine trusts it and drops the filter, so a transaction's own uncommitted rows that fail the filter leak into the answer. The engine should re-check every such filter itself.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # RECLAIMABLE_OPS (~:340) and its NOTE; reattachUnconsumedConstraints (~:364) — the one code change
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts      # truncationIsSafe — read only; see "LIMIT" below
  - packages/quereus-isolation/src/isolated-table.ts                       # buildConstraintMatcher doc comment — read only; its "a residual Filter above still removes" claim becomes true
  - packages/quereus/src/vtab/memory/module.ts                             # the tautological IS NOT NULL claim (~:607) — stays as it is
  - packages/quereus/test/vtab/overclaiming-module.spec.ts                 # OPT-024 guard; engine-level regression goes here
  - packages/quereus-isolation/test/                                       # new end-to-end regression spec
  - docs/invariants.md                                                     # OPT-024
  - docs/optimizer.md                                                      # "The handledFilters contract"
  - docs/optimizer-retrieve.md                                             # pushedConstraints "Contents" bullet (~:284)
  - docs/module-authoring.md                                               # "Claiming handledFilters" (~:289)
  - docs/design-isolation-layer.md                                         # Index Scan Merge; "Someone else's negotiated FilterInfo"
repro: verified
----

Filed from the lamina board while fixing lamina slug `claimed-null-tests-leak-staged-rows-in-transaction`. Lamina works around this by no longer claiming the two null tests, which costs it LIMIT pushdown when one is present. Once a Quereus version with this fix is published, lamina can restore those claims after a version bump.

## Root cause

A module's `getBestAccessPlan` may report a filter as handled (`handledFilters[i] === true`). `rule-grow-retrieve` then leaves that filter out of the residual `Filter`, so it has to be enforced some other way. `rule-select-access-path` turns seek-family filters (`=`, `IN`, ranges, `OR_RANGE`) into `FilterInfo.constraints`, and `reattachUnconsumedConstraints` puts back any it did not use. Anything outside `RECLAIMABLE_OPS` is enforced only by the module's own scan.

That breaks under `IsolationModule`. The merged read checks staged (uncommitted) rows only against `FilterInfo.constraints`, so a staged row that fails a claimed non-seek filter is emitted. The `NOTE` on `RECLAIMABLE_OPS` already says this assumption fails as soon as a module makes a non-tautological claim, and lamina now does.

## Reproduction (Quereus only, run at HEAD)

Double used in all cases: a `MemoryTableModule` subclass whose `getBestAccessPlan` calls `super` and then also marks `IS NULL`, `IS NOT NULL` and `LIKE` filters as handled.

Under `IsolationModule`, with committed rows `(3, 4, 'a', 5), (6, null, 'a', 5)` and staged rows `(2, null, 'b', 5), (4, 9, 'b', 5)` in `t (id primary key, a, s, b)`, indexed on `b`:

| Query | Result at HEAD | Plan at HEAD |
| --- | --- | --- |
| `a is null and b = 5` | 2, 3, 4, 6 | `INDEXSEEK`, no `FILTER` |
| `s like 'a%' and b = 5` | 2, 3, 4, 6 | `INDEXSEEK`, no `FILTER` |
| `a is not null order by id limit 2 offset 0` | 2, 3 (should be 3, 4) | `LIMITOFFSET` over `INDEXSCAN`, no `FILTER` |
| `a is not null` | 3, 4 (correct) | `FILTER` over `INDEXSCAN` |

(The double does not apply the claim to committed rows, which is why committed row 3 appears in the first two rows of the table. A module that honours its claim would leak only the staged rows.)

The last row shows the leak needs a plan the retrieve-growth rule committed to: a seek on another column, an absorbed sort, or a cheap module plan. When growth backs out on cost, the `Filter` stays in the pipeline.

The engine-level reproduction needs no isolation. The same double with no `IsolationModule`, rows `(1, null, 'a', 5), (3, 4, 'b', 5)`: `a is null and b = 5`, `a is not null and b = 5` and `s like 'a%' and b = 5` each return 1, 3 with a bare `INDEXSEEK`.

`TestOverclaimModule` is not a usable double here: `select x from t where x > 10 and y is not null order by x` keeps its `FILTER` on that module at HEAD and returns the right rows, so a case added to it would pass without the fix.

## Which operators can reach this

| Op | Reachable from SQL today? | Evidence |
| --- | --- | --- |
| `IS NULL`, `IS NOT NULL` | Yes | Table above |
| `LIKE` | Yes | Table above |
| `GLOB`, `MATCH` | No | Parser rejects them as infix operators (`Expected statement type ... got 'glob'`, same for `'match'`), though `constraint-extractor.ts` has mappings for both |
| `NOT IN` | No | `s not in ('b')` plans as `UNARYOP` over `IN`, kept in a `FILTER`; it never becomes a `NOT IN` constraint |

## Fix

Delete `RECLAIMABLE_OPS`. `reattachUnconsumedConstraints` then reattaches every handled-but-unconsumed constraint, with one exception: `IS NOT NULL` on a column declared `NOT NULL`, which is always true. The rule becomes "a claim the rule did not consume is re-checked above the scan", and no operator can fall outside it.

This goes further than the allowlist widening the original ticket recommended. Removing the list is less code, and a list would have to be remembered again as soon as the parser learns `GLOB` or the extractor learns `NOT IN`. The cost the ticket named is accepted: a non-seek claim no longer removes the filter, so its remaining effects are pricing and the LIMIT licence.

The `NOT NULL` exception belongs in the planner rather than in memory's claim. Memory can keep claiming the tautology, and any other module's identical claim costs nothing either. It is sound under isolation because `NOT NULL` is enforced at write time for staged rows too, and tombstones (which carry null non-PK columns) never reach the emitted stream.

`MATCH` tripwire, to leave as a `NOTE:` at the reattach site: if `MATCH` ever becomes parseable, a reattached `MATCH` runs the engine's scalar evaluation, which may not know the module's semantics. Decide then whether `MATCH` is exempt, and note that an exemption brings the staged-row leak back for that operator.

## What the trial showed

These results come from a temporary patch, since reverted. The patch used a widened list (`IS NULL`, `IS NOT NULL`, `LIKE`, `GLOB`, `NOT IN`) rather than deleting the list; because `GLOB`, `MATCH` and `NOT IN` never reach it, the effect is the same.

- Null tests added to the list, no `NOT NULL` exception: `packages/quereus` suite 10966 passing, 25 pending. No plan-shape test failed, but memory's tautological claim grew an extra `FILTER`, including under `min(a) ... limit`. This is why the exception is needed even though no test demands it.
- Full patch with the exception: `packages/quereus-isolation` suite 448 passing. All reproduction queries returned correct rows, including `a is not null order by id limit 2 offset 0` → 3, 4. On memory, plans for `a is not null` and `min(a) from t where a is not null` matched HEAD.
- **Not run:** the `packages/quereus` suite against the full patch, the store-backed suite, and the actual deletion of the list. Run the first in this stage.

## Known cost: a duplicate `FILTER` on the backed-out path

When growth backs out on cost, `rule-select-access-path` takes its no-context branch, which keeps the pipeline's `Filter` verbatim, so reattaching adds a second identical one: `FILTER, FILTER, INDEXSCAN` was seen for `a is not null` and `s like 'a%'` with the double. The answer is correct and the cost is one extra predicate evaluation per row. Seek-family claims already do the same. `bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter` owns this path and has been told about this new instance; do not fix it here.

## LIMIT

`truncationIsSafe` licenses a LIMIT on the module's claim, and the reattached `Filter` then sits between the scan and the LIMIT. This is safe. A module honouring its claim only produces committed rows that pass the filter, so the `Filter` rejects none of them and can only remove staged rows the module never saw. Removing a row the truncated scan did not count cannot make the LIMIT underproduce on this filter's account. `truncationIsSafe` needs no change.

The same investigation found a separate underproduction bug with staged deletes, filed as `bug-isolation-forwards-plan-time-limit-to-underlying`. It is unrelated to this filter and is not in scope.

## Tests

- Engine level, the OPT-024 guard: in `overclaiming-module.spec.ts`, add the `MemoryTableModule` subclass double above and assert rows for `a is null and b = 5`, `a is not null and b = 5` and `s like 'a%' and b = 5`. All three fail at HEAD.
- End to end, the ticket's expected behaviour ("a query inside a transaction returns the rows it would return after commit"): a new spec in `packages/quereus-isolation/test/` using the double under `IsolationModule`, with committed rows that satisfy the claim so the double is honest. Cover a seek on another column and the `order by ... limit ... offset 0` case. `packages/quereus-isolation` resolves `@quereus/quereus` through `dist`, so run `yarn workspace @quereus/quereus run build` first or the change is invisible to it.
- Plan shape: one test that `select min(a) from t where a is not null` on a `NOT NULL` column grows no `FILTER`, to pin the exception, which no existing test covers.

## TODO

- Delete `RECLAIMABLE_OPS` and reattach every handled-but-unconsumed constraint except `IS NOT NULL` on a `NOT NULL` column, in `reattachUnconsumedConstraints`
- Rewrite its doc comment and the now-removed `NOTE` to state the new rule, and add the `MATCH` tripwire `NOTE:`
- Add the three tests above and confirm the first two fail without the source change
- Update `docs/invariants.md` OPT-024 (including its title if "seek constraint" no longer fits, and any links to that anchor), `docs/optimizer.md` "The handledFilters contract", `docs/optimizer-retrieve.md` pushedConstraints "Contents", `docs/module-authoring.md` "Claiming handledFilters" (drop "claim only when tautological"; say a non-seek claim is re-checked by the engine and still affects pricing and the LIMIT licence)
- Add to `docs/design-isolation-layer.md` that claimed non-seek filters reach staged rows through the reattached `Filter`, not through `buildConstraintMatcher`
- Run `yarn build`, `yarn test`, `yarn lint`
