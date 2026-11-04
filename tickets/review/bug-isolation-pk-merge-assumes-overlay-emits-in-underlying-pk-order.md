description: Inside a transaction, reading a table wrapped by the isolation layer could return a row twice (once with its old value, once with the new) or return rows in the wrong order, when the underlying module sorts or walks its primary keys differently from the in-memory table that holds the uncommitted changes. This is now fixed and needs a code review.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus-isolation/src/isolated-table.ts   # reverseComparator, IndexScanInfo, mergedQuery, resolveScanIndex, queryOverlayAsMergeEntries, buildMergeConfig
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # new describe 'underlying primary-key order differs from the overlay (merge ordering)'
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts  # comments only
  - packages/quereus-isolation/README.md               # ordering paragraph
  - packages/quereus/src/vtab/index-descriptor.ts      # comments only
  - docs/design-isolation-layer.md                     # "The Problem", "Solution: Module-Provided Comparator", "Collation Considerations", scan-order table
  - docs/module-authoring.md                           # scan direction paragraph
repro: verified
----

## What changed

A merged primary-key read walks two streams in step: the underlying module's rows, in the order the module emits them, and the rows staged in the transaction (the overlay). The merge requires both to be in one order, and nothing made the overlay stream conform. It came straight out of the overlay memory table in that table's own forward key order. Two cases broke, both at the same site:

- The underlying's `comparePrimaryKey` ranks keys differently from the memory table. Lamina does this for TIMESPAN and JSON key members.
- The underlying walks the primary key in reverse (`reverse: true` on its descriptor). `resolveScanIndex` dropped that flag for primary-key plans, so the merge compared a reversed stream against a forward comparator.

The fix:

- `queryOverlayAsMergeEntries` collects the overlay's entries and sorts them under the merge's comparator before yielding them, on every merged primary-key read. The sort is unconditional, because a reversed walk needs it whichever comparator is in use and a host-supplied `IsolationConfig.overlay` has no guaranteed order.
- The primary arm of `IndexScanInfo` now carries `reverse`. `resolveScanIndex` sets it from the descriptor, and `buildMergeConfig` negates the comparator when it is set. The secondary branch already did this, and both now share `reverseComparator`.
- `buildMergeConfig` lost its default parameter, since both callers pass one.

## Tests added

In `isolation-layer.spec.ts`, using a fixture module that orders text keys by length then value, so it ranks `b` before `aa` where the overlay ranks `aa` before `b`:

| Test | Verifies | At HEAD |
| --- | --- | --- |
| `shadows each committed row when the underlying ranks keys opposite to the overlay` | Rows `aa`, `b`, both updated, read as `staged-b, staged-aa` | Failed: `committed-b, staged-aa, staged-b` |
| `shadows a committed row on a reversed primary-key walk` | Rows `aa`, `b`, `ccc`, `b` updated, `order by k desc` reads `committed-ccc, committed-aa, staged-b` | Failed: `staged-b, committed-ccc, committed-aa, committed-b` |

The second test also asserts that the fixture really served a reversed walk, so it cannot pass vacuously if the planner later sorts above a forward scan.

The fixture differs from the ticket's version in one way: it takes walk direction from the plan's access path rather than a constructor flag, so a single module class serves both tests and a plain scan stays forward.

## Validation

- `yarn build`: succeeds. `yarn workspace @quereus/isolation typecheck`: clean, including test files.
- Passing: `@quereus/isolation` 447, `@quereus/store` 1986, `@quereus/sync` 852, `@quereus/sync-coordinator` 141, `@quereus/plugin-leveldb` 89, `@quereus/plugin-indexeddb` 179, `@quereus/plugin-react-native-leveldb` 89, `@quereus/plugin-nativescript-sqlite` 78.
- Run once in a throwaway spec, passing, and not kept:
  - a staged delete plus update under the opposing order (the ticket's second table row)
  - a reversed walk with a tombstone and a staged insert
  - `limit 1` under the opposing order
  - a non-colliding primary-key shift and an `insert ... select` from the same table, both reading a merged table while writing to it

## Known gaps

- **Cost of losing the lazy overlay read is not measured.** A merged scan under a `limit` now reads every staged row in its window before yielding anything. A `NOTE:` at the sort records this and when to revisit it, and the design doc states it.
- **Overlay read timing changed.** The overlay is now read to completion at the first pull, so a statement that writes while reading sees the staged rows as of the start of its scan. The two write-while-reading cases above passed, but they were not compared against HEAD.
- **Not run:** the `@quereus/quereus` test suite and lint, `yarn test:store`. That package's only change is comments.
- **Limits that remain, by design:**
  - The underlying's scan must agree with its own `comparePrimaryKey`, and nothing checks this.
  - A module that walks in reverse without setting `reverse` still merges wrongly. The doc comment and `docs/module-authoring.md` now say it must set the flag.
  - The overlay's comparator and the underlying's must still agree on which keys are equal. Only order disagreement is absorbed.
- **Pre-existing and left alone:** `queryOverlayAsMergeEntries` only ever receives a primary scan, because `mergedQuery` returns earlier for secondary scans. So the secondary arm of `buildSortKey`, and the sentence about secondary scans in that method's doc comment, cannot be reached from there.

## Edits beyond the ticket's list, for the reviewer to check

- `docs/module-authoring.md` made the same claim as the `IndexDescriptor.reverse` comment, that a module encoding direction in `idxStr` need not set `reverse`. Corrected to match, along with the `IndexPlanKind` comment in `index-descriptor.ts`.
- The README's ordering paragraph said the merge walks both streams in declared order and cited `backlog/bug-isolation-multiseek-merge-order` as open. That ticket landed (`tickets/.pruned-tickets.jsonl`), so I rewrote the paragraph.
- Two more comments in `key-set-seek-merge.spec.ts` said `mergeStreams` needs both streams in ascending order. Corrected alongside the header comment.
- The `collationResolver` field comment on `IsolatedTable` said the two comparators must agree. It now says they must agree on equality, not order.
- The scan-order table in the design doc now mentions `reverse`.
