description: A query asking for descending order can now read an ascending index (or the primary key) backwards instead of sorting the whole table; this adds the engine-side plumbing for a backwards walk and turns it on for the in-memory table.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/vtab/idx-str.ts                                  # REVERSE_PARAM, idxStrWalksReverse, withWalkDirection (moved here in review)
  - packages/quereus/src/vtab/filter-info.ts                              # makeIndexEqSeekFilterInfo stamps direction (review)
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts                # stampMultiSeek stamps direction (review)
  - packages/quereus/src/vtab/index-descriptor.ts                         # schemaIndexDescriptor (factored), reversedIndexDescriptor, IndexPlanKind comment
  - packages/quereus/src/index.ts                                         # exports reversedIndexDescriptor, idxStrWalksReverse, REVERSE_PARAM
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # walkedIndex + withWalkDirection stamp, createPlanSeqScan assertion
  - packages/quereus/src/vtab/best-access-plan.ts                         # nullSafeOrderingPrefixLength(…, reverse)
  - packages/quereus/src/vtab/memory/module.ts                            # OrderingWalk, orderingPrefixWalked, tri-state indexSatisfiesOrdering, plan A/B descriptors, monotonic advertisement
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts                   # descending = idxStrWalksReverse(spec); dead ordCons / plan 1 / plan 4 removed
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts                  # walkStartKey / lastKeyOfSeekGroup / keyInSeekGroup
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts
  - packages/quereus/test/vtab/scan-layer-descending.spec.ts
  - packages/quereus/test/optimizer/desc-index-ordering.spec.ts
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts
  - packages/quereus/test/logic/10.5.3-desc-index-ordering.sqllogic
  - packages/quereus/test/filter-lost-under-index-order.spec.ts           # existing pin updated
  - packages/quereus/test/optimizer/key-set-seek.spec.ts                  # existing pin updated
  - packages/quereus/test/optimizer/monotonic-on.spec.ts                  # existing pin updated
  - packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts       # existing pins updated
  - packages/quereus/test/plan/index-selection.spec.ts                    # existing pin updated
  - docs/module-authoring.md
  - docs/memory-table.md
  - docs/optimizer-rules.md
----

# Backwards index walks: engine contract + in-memory table (complete)

The store half is `reverse-index-walk-store` (in `implement/`, depends on this). Its ticket already names the helpers this one exports, and the names match.

## What was built

**Engine contract.**
- A module that serves a required ordering by walking an index backwards returns `indexDescriptor: reversedIndexDescriptor(tableSchema, indexName)`. That is the schema's descriptor for the index with `reverse: true`. For the primary key it takes each key column's collation from the table column, not from `primaryKeyDefinition`, which can lag (see "Deviations").
- `makeIndexFilterInfo` / `makeOrderedScanFilterInfo` resolve the `AccessPath` first, then add `reverse=1` to the `idxStr` params when the resolved descriptor has `reverse` set (`withWalkDirection`). The text form and the structured form therefore both come from the module's descriptor.
- Runtimes read the direction with `idxStrWalksReverse(decodeIdxStr(idxStr))`.
- `nullSafeOrderingPrefixLength(…, reverse = false)` now gates on each column's effective direction, `!!col.desc !== reverse`. A nullable ASC column walked backwards needs a NULL-excluding filter; a nullable DESC column walked backwards does not.
- `createPlanSeqScan` throws `INTERNAL` when a plan carries `indexDescriptor.reverse` but the index-aware or legacy arm falls through to a plain sequential scan.

**Memory planner.**
- `indexSatisfiesOrdering` returns `'forward' | 'reverse' | undefined`. Forward is tried first. Each direction runs `orderingPrefixWalked` (the same equality-pinned skip as before, with every matched column required to have direction `indexCol.desc !== reverse`) and then the NULL gate with its own `reverse` flag.
- Plan A and plan B attach the reversed descriptor when the match is `'reverse'` (`walkDirectionFields`). The cost equals the forward walk's. `explains` gets a ` (reverse walk)` suffix.
- The bare primary-key advertisement (no request) stays forward.
- `buildMonotonicAdvertisement` derives `direction` and the NULL gate from `bestPlan.indexDescriptor?.reverse`.

**Memory runtime.**
- `buildScanPlanFromFilterInfo` sets `descending = idxStrWalksReverse(spec)`. The dead `ordCons=DESC` / `plan=1` / `plan=4` handling is gone, and that includes `plan=4` in `isRangePlan`.
- `walkStartKey` fixes the group-start problem: when a backwards walk's seek tuple is shorter than the tree key and its seek bound is absent or inclusive, `lastKeyOfSeekGroup` steps forward over the group (using the walk's own per-column comparators) and starts from its last key. Both the primary and secondary branches use it.

## Use cases to validate (all verified by hand with throwaway probes, then deleted)

- `select id, c from t order by c desc` over `create index t_c on t(c)` → `INDEXSCAN … USING t_c ORDER BY 1 DESC`, no SORT. Ties come out in reverse PK order, the exact reverse of `order by c`.
- `select id from t order by id desc limit 3` → `INDEXSCAN … USING _primary_ ORDER BY 0 DESC`.
- `where k = 1 order by r desc` over `(k, r)`, `where a <= 5 order by a desc, b desc` over PK `(a, b)`, and `where a = 5 order by b desc`: backwards seeks that return the whole boundary group (they returned zero rows or dropped the bound group before the scan-layer fix).
- `select max(c) from t` with only an ascending index → `LIMITOFFSET` over `INDEXSCAN … t_c ORDER BY 1 DESC`, one row scanned.
- `order by n desc` on nullable ASC `n` keeps the SORT (NULLs first). `where n > 0 order by n desc` drops it.
- `order by val` over nullable `val desc` index → reverse walk, NULLs first.
- Inside an open transaction (memory transaction layers), the same reads over staged inserts, updates and deletes are correct and still reverse-walked.
- Isolation over memory (`IsolationModule({ underlying: new MemoryTableModule() })`) with staged inserts, key-moving updates of `c`, and deletes: `order by c desc`, `order by id desc`, `where k = 1 order by r desc` and `where id <= 5 order by id desc` all return correct rows, ties included, via reversed walks merged by the overlay. **No automated test covers this end-to-end path** (the ticket said to keep to its test list). The overlay half was already pinned with a synthetic module in `isolation-layer.spec.ts`. The reviewer may want one SQL-level case in `quereus-isolation`.

## Tests added (beyond the ticket's list: none)

- `scan-layer-descending.spec.ts` › "backwards walk from a start key shorter than the tree key":
  - prefix-only seek on a two-column secondary index returns the group `[7, 6, 5]`;
  - an inclusive `<=` bound on the leading column of PK `(a, b)` keeps the `a = 5` group.
  - Both confirmed failing without the fix (`[]` and `[[3,1]]`).
- `desc-index-ordering.spec.ts` › "memory module — backwards index walks", one case each:
  - an ascending index read `desc` has no Sort, with ties in reverse PK order (the exact reverse of the forward read);
  - `order by id desc limit 3` over an integer PK has no Sort;
  - a partial flip keeps its Sort;
  - a nullable ASC column keeps its Sort without a NULL-excluding filter and drops it with `where c > 0`.
  - The two existing helpers were hoisted to module level (`sortCountIn` / `columnIn`) so both describes share them.
- `minmax-index-boundary.spec.ts`: the "max over an ASC-only index declines" pin became the fires case "max over an ASC-only index walks it backwards and reads one row". The decline assertions it carried (no Sort introduced) moved onto "no index at all".
- `10.5.3-desc-index-ordering.sqllogic`, section 6 plus one line in section 3. Answers only, run on both backends: ascending index read desc, PK desc + limit, nullable ASC with and without a NULL filter, prefix-equality desc with and without a bound, partial flip, composite-PK range desc at the bound (`<=`, `>=`, `<`, prefix equality), an in-transaction block (insert, update, delete, then reads), and nullable DESC index read ascending.

## Existing pins changed because the behaviour changed (please sanity-check)

- `filter-lost-under-index-order.spec.ts`: its "a Sort survives" contrast used `order by id desc`. It now uses `order by flag`.
- `key-set-seek.spec.ts` › "order by pk DESC over an ASCENDING pk": the reversed walk now absorbs the Sort. The test now asserts no Sort, that `seekPreservesTargetOrder` is false (so the seek branch buffers and re-sorts via `seekRestoresTargetOrder`), and rows `[4, 3, 2]`. I checked that the pushdown's multi-seek descriptor is always forward: its probe request carries no `requiredOrdering`, so memory never reverses there, and its `idxStr` and `accessPath` agree.
- `monotonic-on.spec.ts` › "Sort establishes strict monotonicOn…": needed a Sort with a unique leading key. It now uses `(select id, v from t limit 100) s order by id desc`. Note that `order by id desc, v` does NOT work, because FD pruning drops `v` and the backwards walk serves what is left.
- `rule-orderby-fd-pruning.spec.ts`: six cases used `pk DESC` only to keep a Sort observable. They now read from an `unabsorbable(table, cols, where?)` derived table (`… LIMIT 1000000`), which blocks absorption but keeps keys and the `a = b` equivalence. All six still assert that the rule pruned to one `desc` key.
- `plan/index-selection.spec.ts` › "serves order by + limit from the seek, reading one row": dropped the `(k, r desc)` index the test needed only because the PK could not walk backwards. It now asserts `USING primary` and one row scanned, which is an SQL-level check of the group-end start.

## Deviations from the ticket text, and known gaps

- **Assertion placement.** The ticket says to throw when a reversed claim reaches a "non-index AccessPath (full scan / empty)". It is enforced only where the module's own plan falls back to a sequential scan (`createPlanSeqScan`, both arms). It is not enforced on:
  - the `provesEmpty` fold or the all-NULL-IN empty result, because no rows means no wrong order;
  - the engine's collation-decline scans, which can legitimately see a reversed descriptor. There the claim never survived `orderingClaimSurvivesCollation`, so the Sort was kept.
  - No test, as the ticket says.
- **Exclusive seek bounds** skip the group-end pass: a backwards walk from `< v` or `> v` excludes the whole `v` group, so the crack is already the right start. The pass runs for prefix-only seeks and inclusive bounds. This avoids walking the group twice. The sqllogic covers `a < 5 order by a desc, b desc`.
- **`reversedIndexDescriptor` for the primary key** states each key column's collation from `tableSchema.columns`, not from `primaryKeyDefinition`. `resolveIndexKeyCollations` reads the column for the engine's own PK descriptor but trusts a supplied one, and the store's create-time PK re-collation leaves the definition stale. Without this, the store follow-up's reversed PK claims would be collation-judged differently from forward ones (fail-safe, but a lost seek). For memory the two collations are identical.
- **Tie order is not pinned in the sqllogic.** The store still sorts, and its sort keeps PK-ascending order within ties (checked: `order by c desc` gave `id 2` before `id 5` on the store, the reverse on memory). SQL leaves tie order open, so the shared answers project only the sorted column or use a total order. Memory's tie order is pinned in `desc-index-ordering.spec.ts` and, at the scan layer, by the existing "exact reverse of the forward walk" case.
- `rule-asof-strategy-select.ts` header says `monotonicOn` is "always ascending". That was already untrue (DESC indexes) and is a little less true now. Unchanged; the rule reads `physical.ordering`, which is correct for reversed walks.
- **Validation runs** (all passing):
  - `yarn workspace @quereus/quereus lint`;
  - `yarn workspace @quereus/quereus test` (11116 passing);
  - mocha over the whole quereus suite without `--bail`;
  - `yarn test:store` (11109 passing);
  - `yarn docs:check`;
  - `@quereus/isolation` (451) and `@quereus/store` (1989) after rebuilding quereus `dist`;
  - the full workspace `yarn test`.
  - `yarn test:store` last ran before the final `reversedIndexDescriptor` collation tweak. Only the memory module calls that helper today, so store mode cannot reach it. The quereus suite and lint were re-run after the tweak.

## Tripwire left in code

- `scan-layer.ts` `lastKeyOfSeekGroup`: a `NOTE:` saying the group-end pass costs one extra forward pass over the group's keys; if a large duplicate group at a range boundary shows up in a profile, seek past the group with a high-sentinel comparator.

## Review findings

Reviewed the `ticket(implement): reverse-index-walk-engine-and-memory` diff first, then the handoff. Ran `yarn workspace @quereus/quereus lint` (clean), `yarn workspace @quereus/quereus test` (11116 passing, 26 pending), rebuilt quereus `dist` and ran `@quereus/isolation` (451 passing), and `yarn docs:check` (OK). `yarn test:store` was not re-run: the review's source change only adds `reverse=1` when a descriptor already says `reverse`, which no store path produces yet.

**Correctness — checked, one latent defect fixed inline.**
- Fixed: the direction stamp lived privately in `rule-select-access-path.ts`, so two other producers that mint an `idxStr` beside a structured `accessPath` did not stamp it: the key-set multi-seek (`stampMultiSeek`, key-set-semi-join.ts, which takes its descriptor from `resolveIndexDescriptor` over the module's probe answer) and `makeIndexEqSeekFilterInfo` (filter-info.ts). Today the probe carries no `requiredOrdering`, so no module returns a reversed descriptor there and nothing is wrong yet; but the moment one did, the `accessPath` would say "backwards" (the isolation overlay merges in reverse) while the runtime walked forwards. Moved the helper to `idx-str.ts` as exported `withWalkDirection(params, descriptor)` and used it in all three producers, so every engine-built `idxStr` restates the descriptor's direction. Also exported from `index.ts`, and docs/module-authoring.md now names it for hand-built `FilterInfo`. With this, the store follow-up's planned "multi-seek with `reverse` → `malformedFilterInfo`" assertion would actually see the flag. No test: the fix is a class-level invariant (one helper), and the dormant path is unreachable from SQL.
- Checked by throwaway probes (deleted) shapes no test covers: a primary key `(a desc, b)` walked backwards with `>=`, `>`, `<=` bounds and prefix equality; a secondary index `(k, r desc)` read `order by r asc` under `k = 1` and under `k = 1 and r >= 6`; `order by k desc, r asc` with `k >= 1` / `k <= 1`; and the same reads inside an open transaction after an insert and a key-moving update. All answers correct and all served by a reverse walk with no Sort. The group-end start (`walkStartKey`) is direction-agnostic as it should be: it works from tree position, not column direction.
- Checked: multi-value `IN` and `OR_RANGE` cannot reach a reversed walk (`collectEqualityBoundColumns` excludes multi-value IN; plan A and plan B both refuse `OR_RANGE` and multi-IN on an ordered column), so the multi-range path's existing `NOTE:` about visiting ranges in SQL-text order still holds. Multi-seek keys already sort reversed for a descending plan (`orderSeekKeys`).
- Checked: no producer or consumer of the removed `ordCons=DESC` / `plan=1` / `plan=4` remains anywhere in `packages/*/src` or docs.
- Checked: the monotonic advertisement's direction and NULL gate follow the reversed descriptor; `ruleMinMaxIndexBoundary` header and docs/optimizer-rules.md caveat match the new behaviour (memory both ways, store forward-only until `reverse-index-walk-store`).

**Tests.** The implementer's additions each pin a distinct behaviour (scan-layer group-end start for two seek shapes; planner Sort absorption, PK reverse, partial flip, nullable gate; sqllogic answers across both backends). Kept all. Re-read the changed pins (`key-set-seek`, `monotonic-on`, `rule-orderby-fd-pruning`, `index-selection`, `filter-lost-under-index-order`, `minmax-index-boundary`): each still tests what its name says under the new behaviour. Renamed the `scan-layer-descending.spec.ts` describe from "… (latent path)" since the path is now reachable from SQL. No test added: the found defect is dormant and fixed structurally. No automated memory-under-isolation SQL case was added (implementer's open question): the overlay merge is pinned with a synthetic module in `isolation-layer.spec.ts`, the memory walk is pinned here, and `yarn test:store` will run the in-transaction sqllogic block through the isolation layer with reversed walks once `reverse-index-walk-store` lands.

**Docs.** docs/module-authoring.md, docs/memory-table.md and docs/optimizer-rules.md read accurately; added one sentence to module-authoring.md for `withWalkDirection`. The stale "always ascending" header in `rule-asof-strategy-select.ts` the implementer noted is pre-existing and harmless (the rule reads `physical.ordering`); left as is.

**Source hygiene / size.** `vtab/memory/module.ts` is now 1,433 lines (`wc -l`); already tracked by `debt-oversized-source-files` — appended the new measurement there rather than filing. `rule-select-access-path.ts` is 1,784 lines, also already tracked there. Comments in the diff state constraints and reasons rather than narrating.

**Error handling / types.** `reversedIndexDescriptor` throws `INTERNAL` for an index it cannot resolve; `createPlanSeqScan` throws when a reversed claim would fall to a forward scan. No `any`, no swallowed errors.

**Performance.** The group-end pass costs one extra forward pass over the boundary group's keys; the implementer's `NOTE:` tripwire in `scan-layer.ts` `lastKeyOfSeekGroup` covers it. Nothing new parked.

**Tickets filed:** none. **Tripwires added:** none.
