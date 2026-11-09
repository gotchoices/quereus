description: An in-memory table keeps a small record of every write statement it has ever run, so its memory use grows with the number of statements executed rather than with the number of rows it holds, and a long-running process can eventually run out of memory. Fix it by having each newly committed version drop its link to the versions before it.
architecture: docs/memory-table.md#memory-management
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # parentLayer (readonly today), freeze, clearBase
  - packages/quereus/src/vtab/memory/layer/manager.ts       # commitTransaction (~L547), layerChainSet, collectPendingChanges, rebaseLayerOntoHead, tryCollapseLayers, promoteCommittedHead, isLayerInUse, chainContains, disconnect (~L541), consolidateToBaseLayer, base replacement at ~L1745 and destroy (~L3342)
  - packages/quereus/src/vtab/memory/layer/interface.ts     # Layer.noteDerivedChild / hasDerivedChildren docs mention tryCollapseLayers
  - packages/quereus/src/vtab/memory/table.ts               # L273 commented-out tryCollapseLayers call
  - packages/quereus/test/vtab/layer-tree-chain-depth.spec.ts
  - packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts
  - packages/quereus/test/vtab/layer-derived-child-guard.spec.ts
  - packages/quereus/test/vtab/layer-collapse-mutated-base.spec.ts
  - docs/memory-table.md
  - tickets/backlog/bug-memory-index-copies-every-key-for-a-repeated-value.md
repro: verified
----
# Committed layers are never released

## Reproduction (verified at HEAD 3a9e1581e, node v24.2.0)

A table `t (id integer primary key, g integer)` with one row; a prepared `update t set g = ? where id = 1` run in autocommit; after each 10,000 runs, count `for (l = manager.currentCommittedLayer; l; l = l.getParent()) n++` and sample heap after `gc()` (mocha run with `node --expose-gc --import ./packages/quereus/register.mjs`):

| statements | layer chain length | heapUsed |
|---|---|---|
| 10,000 | 10,002 | 109.0 MB |
| 20,000 | 20,002 | 123.1 MB |
| 30,000 | 30,002 | 137.0 MB |
| 40,000 | 40,002 | 150.9 MB |

About 1.4 KB retained per statement while the table holds one row (absolute heap includes the test harness; the slope is what matters). The scratch spec was deleted; the deterministic part (chain length) is what the regression test should assert.

## Cause

`TransactionLayer.parentLayer` is `readonly` and never cleared. Each committed head is the parent of the next statement's layer (and, inside a transaction, of each statement-savepoint snapshot layer, which then becomes part of the committed chain at commit). So the current head keeps every earlier layer — its `ownWrites` log, its `pendingChanges` log, its `MemoryIndex` wrappers, the tree nodes it cloned — reachable for the table's lifetime.

Since `bug-many-inserts-in-one-transaction-overflow-stack`, `TransactionLayer.freeze` detaches every head's B-trees from their base (`clearBase()`), so a committed head's trees are self-contained. Its `parentLayer` is no longer needed for reads. It is only needed for walks over the layer chain:

| walk | what it needs below the head |
|---|---|
| `chainContains(pending, head)` (commit Case A test, snapshot wrap) | nothing — it stops at the head |
| `collectPendingChanges(pending, boundary)` / `rebaseLayerOntoHead(pending, forkPoint)` | nothing — they stop at the head or fork point, and run before the new head is published |
| Case B fork-point search: `layerChainSet(head)` intersected with the pending chain | **the whole history of former heads** — this is the one real dependency |
| `isLayerInUse` / `promoteCommittedHead` / `tryCollapseLayers` | to be deleted (see below) |
| DDL: `openTransactionLayersOldestFirst`, `validateRekeyedPrimaryKey`, `consolidateToBaseLayer`'s event-clearing loop | they walk to the base and today rebuild/scan **every** committed layer below the head (O(statements ever run) per in-transaction ALTER). Every tree-rebuilding DDL arm calls `ensureSchemaChangeSafety` first, which drains the head into the base, so after the cut the base holds exactly the head's rows |

## Fix design

**Re-parent each published head onto the base layer.** At the end of `commitTransaction`, after events and own-writes have been gathered from the old chain, set the new head's parent to `this.baseLayer`. The head's trees are already detached, so its contents don't change; it simply stops referencing the savepoint snapshots and former heads below it. Those become unreachable unless a connection still holds one (its own `readLayer`, a lazy savepoint marker, or a sibling pending chain) — which is the retention the ticket asks for: bounded by live views, not by statements committed.

- Make `parentLayer` private and mutable behind a narrow method on `TransactionLayer`, e.g. `publishAsHead(root: Layer, seq: number, generation: number)`. It must refuse (log + leave the parent alone) when the layer's trees were not detached — `freeze` skips the detach when `hasDerivedChildren()` is true, and then the tree chain still reaches the parent's trees, so a nominal base parent would mis-describe the rebuild source. Have `freeze` record whether it detached.
- Apply it on every publish path: Case A (pending published wholesale), Case B (`rebaseLayerOntoHead`'s result — today `rebased` is built over the head and frozen), and the Case C coordinated-commit fallback.
- Why the base and not `null`: the DDL rebuilds (`newPrimaryTreeOverParent`, `reindexOwnWrites`, `adoptSchema`'s new-index build, `prepareRekeyedPrimaryKeyColumns`) read `parentLayer`'s trees, and `chainContains(pending, this.baseLayer)` after consolidation (head := base) must still find the base through a pending that forked from a former head. After consolidation the base holds the drained head's full view, so replaying the head's own writes over it is idempotent (upserts rewrite the same rows; deletions of absent keys are tolerated no-ops). The one DDL arm that does not drain first, `rename` (~L1689), only swaps schema pointers in `adoptSchema` (every `IndexSchema` keeps its identity), so it rebuilds nothing over the nominal parent. Verify this claim for each `adoptSchemaOnOpenLayers` / `convertColumnOnOpenLayers` / `prepareReshapeOnOpenLayers` / `validateRekeyedPrimaryKey` caller while implementing.

**Replace the head-chain fork-point search with a publish history marker.** After the cut the head chain is just `head → base`, so `layerChainSet(head)` no longer contains the fork point, and the search would land on the base — replaying the fork point's own writes again on top of the newer head, which reverts rows (`coordinated-commit-sibling.spec.ts` "rebases a sibling's UPDATE and DELETE" fails that way: re-applying the first head's inserts resurrects the deleted id 1 and reverts id 2).

- Committed heads within one "history generation" form a line: a Case A publish contains the previous head, a Case B publish is built on it, and consolidation drains it into the base, which every chain ends at. So any former head published in the current generation is an ancestor-in-history of the current head.
- Manager keeps `historyGeneration` (and a publish counter if useful for asserts/debugging). Each published head records the generation it was published under.
- Fork point = the first layer in the pending chain, starting at `pendingLayer.getParent()`, that is either `this.baseLayer` or a published head whose generation equals `this.historyGeneration`. Savepoint snapshots are `markCommitted()` too, so "committed" is not the test — "published as head" is.
- Bump `historyGeneration` wherever the head becomes something that does not descend from the previous head: base replacement (~L1745 `this.baseLayer = newBase`, `destroy` ~L3342) and the Case C fallback publish. Consolidation does not bump: the base absorbs the head. With a new base object, no former head's chain reaches `this.baseLayer` and no former head carries the new generation, so a stale pending still lands in Case C exactly as today.
- Behaviour change to accept: today a sibling forked from a former head that later went through consolidation finds the base as fork point and replays that head's whole chain again; under the new rule the former head itself is the fork point and only the sibling's own writes replay. That is the correct result; note it in the docs.

**Delete the layer-collapse code** (the ticket's second arm). With `freeze` detaching every head, `tryCollapseLayers` / `promoteCommittedHead` only re-detach trees that have no base, and the re-parent above is the release mechanism that replaces them. Remove `tryCollapseLayers`, `promoteCommittedHead`, `isLayerInUse` (no other caller — confirm), the `disconnect` call (~L541) and its comment's reference to "the collapse below", the commented-out call in `table.ts:273`, and the `tryCollapseLayers` mention in `interface.ts`'s `noteDerivedChild` doc (the counter stays: `freeze` still uses `hasDerivedChildren()` as its guard). Tests: `layer-derived-child-guard.spec.ts` asserts `promoteCommittedHead` refusals — delete those cases, keep any that pin `disconnect` deferral for an eager-savepoint connection (`hasOpenWork`), which is still live behaviour. `layer-collapse-mutated-base.spec.ts` is SQL-level (cascade-delete savepoint shapes); keep it only if it still exercises a live path after the collapse code is gone, otherwise delete it.

## Test

Extend `layer-tree-chain-depth.spec.ts` (already reads `manager.currentCommittedLayer` and the connections' layers) rather than adding a file: after N autocommit statements, and after a `begin` / N statements / `commit`, the committed head's `getParent()` chain is at most 2 layers (head → base), independent of N. Keep N small (tens), as that file does. The existing `coordinated-commit-sibling.spec.ts` cases are the guard on the fork-point rule; run them, don't duplicate them. No heap-measuring test.

## Docs

`docs/memory-table.md`: rewrite the "Layer Retention" and "Base Clearing" bullets under Memory Management (state the new bound and the 40k-statement measurement after the fix); in Layer Management, drop "Automatic Promotion" and the promotion conditions text (~L190, ~L226–238) and replace with the publish/re-parent rule and why the base is the nominal parent; update "The layer-level parent chain is left intact; commit, rebase, isLayerInUse and the DDL passes still walk it"; in "Commit and sibling-layer rebase" fix "Rebasing chains — B ← P1 ← rebased-P2" and describe the generation-based fork point. Then remove the "Every layer is kept for the life of the table" clause from `tickets/backlog/bug-memory-index-copies-every-key-for-a-repeated-value.md` (its time cost stands; its memory claim no longer does).

## TODO

- Add the publish method on `TransactionLayer` (private mutable parent, detach-recorded-by-`freeze` guard, generation field) and call it on all three commit publish paths after event/own-write collection.
- Add `historyGeneration` to the manager; bump it at base replacement, `destroy`, and the Case C fallback.
- Replace `layerChainSet` + intersection in Case B with the first-published-head-or-base rule; delete `layerChainSet` if unused.
- Audit every DDL caller of the open-layer walks for "drained before rebuild" (rename is the known non-draining arm; confirm it is pointer-only).
- Delete `tryCollapseLayers`, `promoteCommittedHead`, `isLayerInUse`, the `disconnect` call, the `table.ts` comment, and the obsolete guard tests; fix `interface.ts` docs.
- Extend `layer-tree-chain-depth.spec.ts` with the bounded-parent-chain assertion.
- Re-run the 40k-statement measurement by hand (temporary spec, delete afterwards) and record the post-fix numbers in the docs.
- Update `docs/memory-table.md` and the backlog ticket sentence as above.
- `yarn workspace @quereus/quereus lint` and `yarn test`; also `yarn test:store` is not needed (store module does not use these layers).
