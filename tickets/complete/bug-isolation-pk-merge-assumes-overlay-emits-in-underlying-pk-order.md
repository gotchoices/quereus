description: Inside a transaction, reading a table wrapped by the isolation layer could return a row twice (once with its old value, once with the new) or return rows in the wrong order, when the underlying module sorts or walks its primary keys differently from the in-memory table that holds the uncommitted changes. Fixed and reviewed.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus-isolation/src/isolated-table.ts   # reverseComparator, IndexScanInfo, mergedQuery, resolveScanIndex, queryOverlayAsMergeEntries, buildMergeConfig
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # describe 'underlying primary-key order differs from the overlay (merge ordering)'
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts  # comments only
  - packages/quereus-isolation/README.md               # ordering paragraph
  - packages/quereus/src/vtab/index-descriptor.ts      # comments only
  - docs/design-isolation-layer.md                     # "The Problem", "Solution: Module-Provided Comparator", "Collation Considerations", scan-order table
  - docs/module-authoring.md                           # scan direction paragraph
repro: verified
----

## What changed

A merged primary-key read walks two streams in step: the underlying module's rows, in the order the module emits them, and the rows staged in the transaction (the overlay). The merge needs both in one order, and nothing made the overlay conform. It came straight out of the overlay memory table in that table's forward key order. Two cases broke at that site:

- The underlying's `comparePrimaryKey` ranks keys differently from the memory table. Lamina does this for TIMESPAN and JSON key members.
- The underlying walks the primary key in reverse (`reverse: true` on its descriptor). `resolveScanIndex` dropped that flag for primary-key plans, so the merge compared a reversed stream against a forward comparator.

The fix:

- `queryOverlayAsMergeEntries` collects the overlay's entries and sorts them under the merge's comparator before yielding them, on every merged primary-key read. The sort is unconditional, because a reversed walk needs it whichever comparator is in use and a host-supplied `IsolationConfig.overlay` has no guaranteed order.
- The primary arm of `IndexScanInfo` carries `reverse`. `resolveScanIndex` sets it from the descriptor, and `buildMergeConfig` negates the comparator when it is set, sharing `reverseComparator` with the secondary branch.
- `buildMergeConfig` lost its default parameter, since both callers pass one.

Remaining limits, all by design and stated in the docs:

- The underlying's scan must agree with its own `comparePrimaryKey`.
- A module that walks in reverse must set `reverse`.
- The overlay's comparator and the underlying's must still agree on which keys are equal. Only disagreement about order is absorbed.

## Tests

Two tests in `isolation-layer.spec.ts` use a fixture module that orders text keys by length then value, so it ranks `b` before `aa` where the overlay ranks `aa` before `b`. One shadows both rows under the opposing order, and the other shadows a row on a reversed walk. The implement stage reported both failing on the code before the fix; this review did not re-run them against that code.

## Review findings

Reviewed from the diff of `ticket(implement): bug-isolation-pk-merge-assumes-overlay-emits-in-underlying-pk-order`, then the handoff.

**Fixed in this pass (minor):**

- Dead code: `queryOverlayAsMergeEntries` only ever receives a primary scan, because `mergedQuery` returns earlier for secondary scans. The handoff flagged this and left it. Removed `buildSortKey`, the method's `indexInfo` parameter and the sentence about secondary scans. An entry's sort key now defaults to its primary key.
- Stale doc: `docs/design-isolation-layer.md` still said a multi-seek owes ascending or descending key order. It now says the module's own primary-key order, reversed when `reverse` is set.
- Unmeasured cost: the `NOTE:` at the sort said the loss of the lazy overlay read was not measured. Measured with a throwaway spec on a memory underlying with every row staged, 20 reads per size on one development machine: `limit 1` took 3.15 ms per read at 1,000 staged rows, 14.27 ms at 10,000 and 60.97 ms at 50,000, while a primary-key seek stayed near 1 ms at all three. The lazy read was not timed for comparison. The `NOTE:` and the design doc now carry these figures.
- Undocumented behaviour: the design doc now states that a statement writing to a table while reading it sees the staged rows as of the start of its scan.

**Filed (major):** no new ticket. The remaining limits share one cause: nothing checks that a module emits the order it declares. That class already has a ticket, so this instance is appended as a fourth arm of `debt-nothing-checks-advertised-row-order`.

**Tripwires:** the `NOTE:` at the sort in `queryOverlayAsMergeEntries` records when to restore the lazy read.

**Checked, no defect found:**

- Reversed walk on a composite, mixed-direction key, `primary key (a, b desc)`, with a staged update, delete and inserts, through a fixture serving `order by a desc, b asc`: the reversed read was the exact reverse of the forward read. Throwaway spec, not kept.
- Writing while reading on a memory underlying, for both `k integer primary key` and `primary key (k desc)`: `insert ... select` from the same table, a non-colliding primary-key shift, and `delete ... where k in (select ...)`, followed by commit. All returned the expected rows. Throwaway spec, not kept. These compare against expected values, not against the code before the fix.
- Writes between pulls of an open cursor: could not be exercised. An `exec` inside an open `eval` loop did not finish within the 10-second test timeout. `Database.exec` runs under a mutex, which is the likely reason, but the hang was not investigated further.
- Equal keys, out-of-window tombstones and an empty overlay: read through `mergeStreams` and the sort, without a dedicated test. Tombstones still bypass the window check, and the merge treats equal keys as before.
- Resource cleanup: the overlay cursor now closes before the merge yields its first row, so no overlay cursor stays open during the merge. `mergeStreams` still takes its first two pulls outside its `try`. That predates this change, and the overlay side now holds only an array at that point.
- Reversed walks in shipped backends: no module in this repository sets `reverse`, so the reversed primary arm is reached only by external modules such as lamina and by test fixtures. The `index-descriptor.ts` comment saying no engine path emits the descending `idxStr` codes holds: a search of `packages/quereus/src` finds `plan=1`, `plan=4` and `ordCons` only being read.
- Edits beyond the implement ticket's list (`docs/module-authoring.md`, the `IndexPlanKind` comment, the README paragraph, the `key-set-seek-merge.spec.ts` comments, the `collationResolver` comment, the scan-order table): each matches the code. `bug-isolation-multiseek-merge-order` is in `tickets/.pruned-tickets.jsonl`, so dropping the README's reference to it as open was correct.

**Tests:** both new tests stay. Each reproduces one arm of the bug, and the second asserts that its walk really was reversed. None added or cut.

**Source hygiene:** `wc -l` gives `isolated-table.ts` 2,201 lines after this pass (2,221 before it) and `isolation-layer.spec.ts` 7,979. Both are already listed in `debt-oversized-source-files`.

**Validation, after this pass's edits unless noted:**

- `yarn build`: succeeds.
- `yarn workspace @quereus/isolation typecheck`: clean.
- `yarn workspace @quereus/quereus run lint`: exit 0, run before this pass's edits. Those edits touch only `@quereus/isolation`, which has no lint configured, and a doc.
- `yarn test`: exit 0, including `@quereus/quereus` 10,966, `@quereus/isolation` 447, `@quereus/store` 1,986, `@quereus/sync` 852 and `@quereus/sync-coordinator` 141.
- `yarn test:store`: exit 0, 10,959 passing, 32 pending. The implement stage had not run this. It sends the engine's logic tests through the store module wrapped by the isolation layer. The 32 pending tests were not examined.
