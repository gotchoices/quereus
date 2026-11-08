description: When the in-memory table reads a secondary index backwards, rows that share one indexed value still come out in forward primary-key order, so the read is not the exact reverse of a forward read; make it fully reversed before backwards index reads are turned on, so the documented scan order holds.
architecture: docs/design-isolation-layer.md
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/test/vtab/scan-layer-descending.spec.ts, docs/memory-table.md, docs/design-isolation-layer.md, packages/quereus-isolation/src/isolated-table.ts (read only), packages/quereus/src/vtab/memory/index.ts (read only)
difficulty: easy
----

# Reverse the primary-key order inside an index value on a backwards secondary-index read

## The contract

The in-memory table serves a secondary-index read by walking the index B-tree (one entry per distinct indexed value) and, for each entry, emitting the rows filed under that value in primary-key order (`MemoryIndex.getSortedPrimaryKeys`, memoized per entry). The documented scan order for a secondary-index read is the composite `(indexKey…, pk…)` — that is what `docs/design-isolation-layer.md` § "Which index is being scanned" says the underlying module emits, and what `quereus-isolation` sorts its staged rows by before merging them in (`buildMergeConfig` in `packages/quereus-isolation/src/isolated-table.ts`). For a reversed scan (descriptor `reverse: true`), the merge negates that whole composite comparator, primary-key tie-break included.

The in-memory backend reverses only the index-value order on a backwards walk (`plan.descending`). Inside one indexed value, primary keys still come out ascending. So a backwards read is not the exact reverse of a forward read of the same window.

## Actual impact (measured / read during planning — narrower than the backlog ticket claimed)

The backlog version of this ticket said the mismatch could make the isolation layer emit a stale row or fail to suppress a deleted one. It cannot. `mergedSecondaryIndexQuery` (`isolated-table.ts` ~line 520) first collects every primary key the transaction touched into a set and drops those rows from the committed stream by set membership, then merges two disjoint streams by sort key. Out-of-order committed rows within one indexed value only change *where among that value's rows* a staged row is interleaved; the index-value order of the output is preserved (each staged row is still emitted before the first committed row of any later index value). Confirmed by running reads with staged updates/deletes through `IsolationModule` over `MemoryTableModule` with a deliberately out-of-order (multi-range) committed stream: the row set was correct every time.

Nor is the within-value order observable through the ordering contract: the memory module's ordering claim (`indexSatisfiesOrdering`, `packages/quereus/src/vtab/memory/module.ts` ~line 1149) covers index columns only, never the primary-key tail, so the engine never relies on primary-key order inside an index value.

So this is a contract-conformance fix: make the backend's emission order equal to the order the isolation layer and the docs say it is, so that a future consumer relying on the full composite order (an ordering claim extended to the primary-key suffix, a merge that pairs by position) is not silently wrong. It is a prereq of `feat-reverse-index-walk-for-desc-ordering`, which is what first makes backwards secondary-index reads reachable. Nothing asks for one today: no engine path emits `ordCons=DESC` or `plan=1`/`plan=4` (the codes `scan-plan.ts` `isDescendingScan` reads), and `scanEffective` only walks the primary tree.

## Design

In the secondary-index branch of `scanLayerResolved` (`scan-layer.ts`), emit each index entry's primary keys in reverse when `plan.descending` is true. Both emission sites go through the existing `sortedPrimaryKeys` closure: the point-equality branch (`plan.equalityKey !== undefined`) and the ordered walk. Replace the closure with one that yields primary keys in *walk order* — ascending for a forward walk, descending for a backwards one — so both sites change together.

- Iterate the memoized array backwards by index (`for (let i = sorted.length - 1; i >= 0; i--)`). **Never** call `.reverse()` on it: `getSortedPrimaryKeys` returns the cached array itself, and reversing it in place would corrupt every later forward read of that entry. Copying (`[...sorted].reverse()`) works but allocates per entry for no reason.
- The inline-sort fallback (index name the layer's schema does not know) gets the same treatment by going through the same helper.
- Multi-seek (`plan.equalityKeys`) needs no separate change: `orderSeekKeys` already reverses the seek keys for a backwards walk, and each key recurses into the point-equality branch, which now reverses within the key. The primary-key dedup there is a set, so emission order does not affect which rows it keeps.
- The primary-key comparator already folds each primary-key column's `DESC` and collation, so "reverse of the comparator-sorted list" is exactly the negated composite comparator the isolation merge uses — no direction logic of its own is needed.
- Replace the comment block above `secondaryIndex` (~lines 266–278) with the accurate statement: the branch emits `(indexKey…, pk…)` order, fully reversed on a backwards walk, matching the isolation merge's sort key; drop the "unreachable mismatch" text and the `backlog/debt-memory-reverse-secondary-pk-order` pointer. Don't claim the order is "depended upon" for correctness — per the impact section, it is the documented contract, not a correctness dependency today.

### Tripwire to park while here (multi-range)

The multi-range branch (`plan.ranges`, `plan=6`, from `where x between 10 and 20 or x between 1 and 5`) visits ranges in SQL-text order, not index order. Verified at HEAD: the example emits `12, 18, 1, 3`. Harmless today — the memory module never advertises an ordering for a multi-range seek (`module.ts` ~line 832, a plain `rangeScan` with no ordering), the planner keeps a `SORT` above it, and the isolation secondary merge is set-based as above. Add a `NOTE:` at the top of that branch: ranges are visited in SQL-text order; if a multi-range seek ever advertises an ordering (or a backwards walk reaches it), sort the ranges by their leading bound under the index's comparator, reversed for a backwards walk, the way `orderSeekKeys` does for multi-seek keys.

## Docs

- `docs/memory-table.md`, the bullet list around "Multi-seek key order is sorted" (~line 746): add one bullet — a secondary-index scan emits rows in `(indexKey…, pk…)` order; a backwards walk reverses the whole composite, primary-key order inside one indexed value included.
- `docs/design-isolation-layer.md` § "Which index is being scanned": one sentence noting that the secondary-index merge drops shadowed committed rows by a primary-key set, so an underlying stream out of order *within one index value* misplaces staged rows only within that value; it is the primary-key merge (`mergeStreams`) whose shadowing depends on order. Keep it short; don't restate the section.

## Edge cases & interactions

- **Memoized array not mutated** — the reverse iteration must not touch the array `getSortedPrimaryKeys` caches; a later forward read of the same entry must still be ascending. Verified by inspection (no `.reverse()`/`.sort()` on the returned array); the test below also reads forward after backwards on the same layer.
- **Forward reads unchanged** — every existing ascending test (`scan-layer-descending.spec.ts` "ascending walk parity", `multiseek-key-order.spec.ts`, the logic suite) must pass untouched.
- **Primary key with a `DESC` column or a collation** — handled by the comparator; reversing its output is still the exact negation. By inspection.
- **Point equality, range, full walk, multi-seek** — all four shapes of backwards secondary read must come out as the exact reverse of the forward read of the same window. Test (below).
- **Multi-seek with duplicate or NULL keys** — dedup by primary-key set and NULL skipping are order-independent. By inspection.
- **Transaction layers** — a `TransactionLayer` has its own `MemoryIndex` with the same `getSortedPrimaryKeys`, so the branch behaves identically on committed and transaction layers. By inspection.
- **Prefix seeks walked backwards** — `feat-reverse-index-walk-for-desc-ordering` already records that a backwards walk from the `[prefix]` seek key lands in the previous group. Out of scope here; don't fix it in this ticket.
- **Isolation layer** — no test through `IsolationModule`: the merge's reversed tie-break is already pinned with synthetic modules (`isolation-layer.spec.ts` "reverse:true reverses the PK tie-break within an equal-(v1,v2) group"), and per the impact section a real-memory test could only observe within-value placement, which the module-level test pins at its source.

## Test

One `it` in the `secondary index` describe of `packages/quereus/test/vtab/scan-layer-descending.spec.ts` (that file already builds `ScanPlan`s directly against the committed layer because the planner cannot reach a backwards walk). Table with a non-unique index and several rows per value, e.g. `create table sg (id integer primary key, g integer)`, `create index idx_g on sg (g)`, rows `(1,10),(2,20),(3,10),(4,20),(5,30),(6,10)`. For each of four plan shapes — full walk, range (`g >= 10 and g < 30`), `equalityKey: 10`, `equalityKeys: [20, 10]` — scan with `descending: false` and with `descending: true` and assert the backwards ids equal the forward ids reversed (e.g. full walk forward `[1,3,6,2,4,5]`, backwards `[5,4,2,6,3,1]`). Run the forward scan of each shape after its backwards scan too, or assert forward once more at the end, so a mutated memo would show. Fails today on every shape with more than one row per value.

## TODO

- Replace the `sortedPrimaryKeys` closure in the secondary branch of `scanLayerResolved` with a walk-order helper (reverse index iteration when `plan.descending`); use it at both emission sites.
- Rewrite the comment block above it as described; add the multi-range `NOTE:`.
- Add the one test to `scan-layer-descending.spec.ts`.
- Update `docs/memory-table.md` and `docs/design-isolation-layer.md` as described.
- `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/isolation test` (check the isolation package name in its `package.json`); `yarn workspace @quereus/quereus lint`.
