description: Let a query that asks for descending order read an ascending index (or the primary key) backwards instead of sorting the whole table — this ticket adds the engine-side plumbing for a backwards walk and turns it on for the in-memory table.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/vtab/idx-str.ts                                  # new `reverse=1` parameter + reader helper
  - packages/quereus/src/vtab/index-descriptor.ts                         # `reverse` already exists; add a reversed-descriptor helper; fix stale IndexPlanKind comment
  - packages/quereus/src/index.ts                                         # export the new helpers (store imports them in the follow-up ticket)
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # makeIndexFilterInfo / makeOrderedScanFilterInfo stamp the parameter
  - packages/quereus/src/vtab/best-access-plan.ts                         # nullSafeOrderingPrefixLength gains a `reverse` argument
  - packages/quereus/src/vtab/memory/module.ts                            # indexSatisfiesOrdering, adjustPlanForOrdering, evaluateOrderingOnlyPlans, buildMonotonicAdvertisement
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts                   # isDescendingScan reads the new parameter
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts                  # backwards walk must start at the END of a partial-key group
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts  # header comment says no backend walks backwards
  - packages/quereus/test/vtab/scan-layer-descending.spec.ts
  - packages/quereus/test/optimizer/desc-index-ordering.spec.ts
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts         # "max over an ASC-only index declines" pin flips for memory
  - packages/quereus/test/logic/10.5.3-desc-index-ordering.sqllogic
  - docs/module-authoring.md
  - docs/memory-table.md
  - docs/optimizer-rules.md                                               # minmax "coverage caveat"
----

# Backwards index walks: engine contract + in-memory table

## Problem

Both shipped backends decide whether an index can supply a requested ordering by requiring the requested direction to equal the index column's declared direction. A query `select … order by c desc limit 10` over `create index t_c on t(c)` therefore sorts the whole table. Measured on Quereus 5.0.0, memory table, 2,000 rows: `order by T asc limit 10` 3.1 ms (index walk), `order by T desc limit 10` 23.8 ms (full sort); the primary key is not walked backwards either (`order by Id desc limit 10` 18.1 ms, sorted). `max(c)` via `ruleMinMaxIndexBoundary` has the same gap. Downstream (Sereus Chat's "newest 100 messages", gotchoices/optimystic#52) needs this shape.

This ticket covers the engine contract and the in-memory backend. The store backend is `reverse-index-walk-store`, which depends on this one.

## What already exists (do not rebuild)

- `IndexDescriptor.reverse` (`vtab/index-descriptor.ts`): a module that walks an index backwards sets it on the `indexDescriptor` it returns from `getBestAccessPlan`. `rule-select-access-path` resolves the descriptor (`resolveIndexDescriptor` prefers a module-supplied one whose name matches) into `FilterInfo.accessPath`.
- The isolation layer already merges a reversed underlying stream from `accessPath.index.reverse` (`quereus-isolation/src/isolated-table.ts` `resolveScanIndex` / `buildMergeConfig`), tested with a synthetic module in `isolation-layer.spec.ts`.
- The engine's sort-absorb re-probe already handles a module that serves DESC by reversing (`rule-grow-retrieve.ts` `fallbackIndexSupports`, pinned by `test/optimizer/sort-absorb-reverse-desync.spec.ts`).
- The memory scan already walks backwards when `ScanPlan.descending` is true, including the seek-start choice for single-column bounds and reversed primary-key order within one secondary-index value (`debt-memory-reverse-secondary-pk-order`, complete).

What is missing: (1) no module ever claims a reversed ordering; (2) the runtime learns direction from `idxStr`, and nothing writes direction into `idxStr` (memory's `isDescendingScan` reads `ordCons=DESC` / `plan=1` / `plan=4`, none of which any engine path emits); (3) the memory scan mis-positions a backwards walk whose start key is shorter than the tree's keys (below).

## Design

### Engine contract

**Direction travels in `idxStr` as a `reverse=1` parameter, derived from the resolved descriptor.** `makeIndexFilterInfo` and `makeOrderedScanFilterInfo` (`rule-select-access-path.ts`) build the `AccessPath` first, then, when it is `{ kind: 'index' }` with `index.reverse === true`, add `reverse=1` to the params before encoding. The idxStr and the accessPath remain projections of one fact (the module's descriptor), so they cannot disagree. Every idxStr the planner produces for a table access goes through these two functions (grep confirms: the only other encoders are `key-set-semi-join.ts` and `filter-info.ts`'s eq-seek helper, both multi/point seeks that never reverse).

In `idx-str.ts`: a named constant for the parameter key and `idxStrWalksReverse(spec: IdxStrSpec | null): boolean`. Export it from `src/index.ts` (the store imports it in the follow-up). Remove memory's dead `ordCons` / `plan=1` / `plan=4` recognition in `scan-plan.ts` `isDescendingScan` in favour of this helper — one spelling. Update the `IndexPlanKind` doc comment in `index-descriptor.ts` that says no engine path emits direction.

**A reversed descriptor helper** in `index-descriptor.ts`: `reversedIndexDescriptor(tableSchema, indexName): IndexDescriptor` — the schema-resolved descriptor (primary key via `primaryKeyDescriptor`, else the schema index, the same resolution `resolveIndexDescriptor` does when no descriptor is supplied) with `reverse: true`. Factor the schema-resolution half out of `resolveIndexDescriptor` rather than duplicating it. Both backends use this helper.

**Boundary assertion** in `rule-select-access-path`: if the access plan carries `indexDescriptor.reverse === true` but the arm that wins builds a non-index `AccessPath` (full scan / empty), throw an internal error — a reversed claim with a forward scan returns rows in the wrong order with the Sort already deleted.

**NULL gate on the effective direction.** `nullSafeOrderingPrefixLength(tableInfo, request, keyColumns, orderPreservingPrefix, pinnedCols, reverse = false)`: a column's effective direction is `!!col.desc !== reverse`; the gate applies to effectively-descending columns. Rationale: both backends emit NULLs first when walking an ASC column forwards or a DESC column backwards (memory: NULL is the comparator's lowest value; store: NULL's `0x00` tag bytes are lowest, bit-inverted for DESC), and last otherwise. The engine's ORDER BY wants NULLs first for both directions (`orderByNullResult`, `util/comparison.ts`; invariant OPT-063 in `docs/invariants.md`). So a backwards walk of an ascending nullable column is unsafe without a NULL-excluding filter, and a backwards walk of a descending nullable column becomes safe. Update the function's doc comment.

**What a reverse match is.** A required ordering is served by reversing an index iff, after the existing equality-bound skip (leading and interleaved pinned columns, unchanged), every matched index column has `required.desc === !indexCol.desc`. All matched columns must agree on one direction: forward (all equal) or reverse (all flipped). A partial flip (`order by a desc, b asc` over `(a, b)`) is neither and still sorts. Pinned columns carry no direction and do not participate in the agreement check. Columns of the index beyond the matched prefix do not matter (the walk is still a full reverse; the claim covers only the matched prefix). `nullsFirst` handling is unchanged (still declines / never populated — see the NOTE on `indexSatisfiesOrdering`).

### Memory backend planner (`vtab/memory/module.ts`)

- `indexSatisfiesOrdering` returns `'forward' | 'reverse' | undefined` instead of boolean. Try forward first; if it fails, try reverse. Each direction runs the NULL gate with its own `reverse` flag over the consumed prefix (forward and reverse can differ: a nullable ASC column passes forward, fails reverse). Keep the PK pseudo-index flowing through it (that is how `order by id desc` over an ascending primary key gets served).
- `adjustPlanForOrdering` (plan A) and `evaluateOrderingOnlyPlans` (plan B): when the match is `'reverse'`, add `indexDescriptor: reversedIndexDescriptor(tableInfo, index.name)` to the claimed plan. Cost of a backwards walk = cost of the forward walk (the B-tree walks either way at the same price). On a cost tie between candidate indexes keep the existing first-wins order; a forward match is tried before reverse for the same index.
- The bare primary-key advertisement (no `requiredOrdering`) stays forward. Never claim reverse without a request asking for it.
- `buildMonotonicAdvertisement`: when the chosen plan's `indexDescriptor?.reverse`, the advertised `direction` is the leading unbound column's effective direction (`leadingCol.desc !== reverse`), and the NULL gate call passes `reverse`. Replace the "For now, the index's own desc flag is the single source of truth" comment. `supportsAsofRight` stays tied to `monotonicOn` as today; the asof consumers already read `direction` (`rule-lateral-top1-asof.ts` handles both) — confirm by reading, no change expected.

### Memory backend runtime (`scan-layer.ts`)

**Hazard (static, `repro: static`):** `seekStartKey` builds `[equalityPrefix…, bound?]`. When that tuple is shorter than the scanned tree's key, it sorts just before every key that shares it, so the seek lands at the start of that group. A forward walk then enters the group — correct. A backwards walk moves away from it and skips the whole group. Concretely, with `plan.descending`:

- prefix-equality seek `where k = 1 order by r desc` over `(k, r)` → start `[1]`, walk backwards into `k = 0`'s group, prefix check fails, **zero rows**;
- range on the leading column of a composite key, `where a <= 5 order by a desc` over primary key `(a, b)` → start `[5]`, rows with `a = 5` **skipped**;
- prefix + bound where the bound column is not the last key column (`(k, r, s)`, `k = 1 and r <= 5 order by r desc`) → rows with `r = 5` skipped.

All three become reachable through SQL by this ticket (the leading-column prefix seek became reachable when `bug-memory-compound-index-unusable-on-leading-column` landed). A full-length start key is unaffected (exact hit, or the crack between neighbours, and `moveNearest` steps correctly).

**Fix:** for a backwards walk whose start key is shorter than the tree's key arity, start from the LAST key of the group instead: position at the crack as today, step forward while the key's leading `parts.length` columns compare equal to the seek parts — using the same per-column comparators the walk already resolved (`comparators.equalityPrefix[i]` for prefix positions, `comparators.bound` for the bound position), so collation variants count as one group — and hand that last key to `safeIterate` as the start (an exact hit). An empty group leaves the crack as the start, which is already right. Apply in both the primary and secondary branches (one shared helper). This costs one extra forward pass over the group's keys (for a secondary index, distinct index keys, not rows). Leave a `NOTE:` at the helper: if a large duplicate group at a range boundary ever shows up in a profile, give the key comparator a high sentinel and seek past the group directly. Update the stale "unreachable through SQL" header in `scan-layer-descending.spec.ts`.

## Edge cases & interactions

- **Partial flip** (`order by a desc, b asc` over `(a, b)`): neither direction matches → Sort kept. Test.
- **Nullable ascending column, no NULL-excluding filter**, `order by c desc`: reverse walk would emit NULLs last → must decline (Sort kept, NULLs first in the answer). With `where c > 0` or `c is not null` → reverse claimed. Test.
- **Nullable descending index column, `order by c` asc**: now servable by a reverse walk with NULLs correctly first (previously sorted). Covered by the gate's effective-direction logic; verify by an answer in the sqllogic.
- **Pinned leading column** (`where k = 1 order by r desc` over `(k, r)`): reverse match after the equality skip; runtime takes the partial-key backwards path above. Test at the scan layer and by answer in sqllogic.
- **Composite primary key, range on leading column, backwards** (`a <= 5 order by a desc`): the group-end hazard. Test at the scan layer.
- **Multi-seek / OR_RANGE**: never claim ordering today (`breaksOrdering`, `usesOrRange`), so never reverse. Memory's multi-seek would still be correct if reversed (`orderSeekKeys`); multi-range would not (NOTE already in `scan-layer.ts`). No change; by inspection.
- **Single-row equality seek** on a unique key: direction irrelevant.
- **Transaction layers / isolation**: memory reads go through `scanLayer` on whatever layer is current; safe-iterate path recovery during mutation is unchanged (positioning happens before the first yield). The isolation layer wrapping a memory table reads `reverse` from the descriptor; `yarn test:store` runs sqllogic behind isolation (the store half reverses only after the follow-up ticket, but answers must already be right on both). Put at least one in-transaction case (insert, update, delete staged, then `order by … desc`) in the sqllogic.
- **Re-probe in `ruleGrowRetrieve`** (`equippedOrdering`): the module must return the same reverse plan when re-asked with the same `requiredOrdering` — it does, the decision is a pure function of the request. Existing `sort-absorb-reverse-desync.spec.ts` covers the engine side.
- **`ruleMinMaxIndexBoundary`**: `max(c)` over only an ascending index now fires on memory. Flip the "max over an ASC-only index — no backwards index walk exists" pin in `minmax-index-boundary.spec.ts` (keep a decline case that still holds, e.g. no index). Update the rule's header comment and the coverage caveat in `docs/optimizer-rules.md` (store still needs `reverse-index-walk-store`; say so).
- **Collation**: reversing does not change which prefix is order-preserving; memory's `indexColumnSortsAsDeclared` gate applies to both directions unchanged.
- **Boundary assertion** (reverse descriptor + non-index arm): by the assertion itself; no test.

## Tests (keep to these)

- `scan-layer-descending.spec.ts`: backwards walk with a partial-length start key returns the boundary group — (a) prefix-only seek on a two-column secondary index, (b) `<=` range on the leading column of a two-column primary key with several rows at the bound value. Both fail before the fix (zero rows / missing bound group).
- `desc-index-ordering.spec.ts`: one case each — `order by c desc` over an ascending index has no SORT and correct rows; `order by id desc limit 3` over an integer primary key has no SORT; a partial flip keeps the SORT; nullable ascending column keeps the SORT without a NULL-excluding filter and drops it with `where c > 0`.
- `10.5.3-desc-index-ordering.sqllogic`: a new section of answers only (it runs on both backends): ascending index read `desc` with ties (rows sharing a value come out in reverse primary-key order — the exact reverse of the forward read), NULLs, prefix-equality `desc`, composite-PK range `desc` at the bound, and the in-transaction staged-rows case.

## TODO

- idx-str: `reverse` parameter constant + `idxStrWalksReverse`; export from `src/index.ts`.
- index-descriptor: factor schema resolution out of `resolveIndexDescriptor`; add `reversedIndexDescriptor`; fix the `IndexPlanKind` comment.
- rule-select-access-path: stamp `reverse=1` in `makeIndexFilterInfo` / `makeOrderedScanFilterInfo` from the resolved descriptor; add the reverse-on-non-index-arm assertion.
- best-access-plan: `reverse` argument on `nullSafeOrderingPrefixLength` + doc comment.
- memory module: tri-state `indexSatisfiesOrdering`; reversed descriptor on plan A / plan B claims; `buildMonotonicAdvertisement` effective direction + gate.
- scan-plan: `isDescendingScan` via `idxStrWalksReverse`; drop `ordCons` / plan 1 / plan 4.
- scan-layer: backwards partial-key start at group end (shared helper, both branches) + `NOTE:`.
- minmax rule header comment; flip the ASC-only `max` pin.
- Tests listed above.
- Docs: `docs/module-authoring.md` (capability contracts: a module may serve a required ordering by reversing a matching index; set `indexDescriptor.reverse`; the runtime sees `reverse=1` in `idxStr` via `idxStrWalksReverse`; `nullSafeOrderingPrefixLength`'s `reverse` argument and the effective-direction NULL rule — replace the sentence that says a reversed key walk always emits NULLs last), `docs/memory-table.md` (ordering claims may be served backwards), `docs/optimizer-rules.md` minmax caveat.
- Run `yarn workspace @quereus/quereus test`, `yarn workspace @quereus/quereus lint`, and `yarn test:store` (sqllogic behind store + isolation; answers must hold even though the store still sorts). Run `yarn docs:check`.
