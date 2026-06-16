description: Review the scan-time bounding of getChangesSince's delta path. collectChangesSince now early-exits the HLC-ordered change-log scan once batchSize whole transactions accumulate, instead of draining the whole iterator and truncating in buildTransactionChangeSets. Response is byte-identical; only the scan footprint shrinks. Migration scan and the from-zero full scan are intentionally left unbounded (documented).
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # collectChangesSince (early-exit), resolveLogEntry (new helper), getChangesSince, collectAllChanges/collectSchemaMigrations docs
  - packages/quereus-sync/test/sync/sync-manager.spec.ts        # new "bounds the change-log scan at scan time" test
  - packages/quereus-sync/src/sync/change-grouping.ts           # buildTransactionChangeSets — UNCHANGED; bound semantics must match it
  - packages/quereus-sync/src/metadata/change-log.ts            # getChangesSince iterator (HLC-ordered) — UNCHANGED
  - docs/sync.md                                                # § Transaction-granularity bounding — scan-time note added
difficulty: medium
----

# Review: bound `getChangesSince` extraction at scan time

## What changed

Before: `getChangesSince` drained the **entire** delta iterator
(`collectChangesSince`) into an in-memory array, then `buildTransactionChangeSets`
grouped and truncated to `batchSize` whole transactions. `batchSize` capped the
**response**, not the **scan** — a large delta (long-offline peer) was an unbounded
memory spike.

After: `collectChangesSince(peerSiteId, sinceHLC, batchSize)` exploits the fact that
the change-log scan is keyed by `(wallTime, counter, siteId, opSeq)` and therefore
HLC-ordered. A transaction's facts are contiguous; `deterministicTxnId(logEntry.hlc)`
(opSeq excluded) is the transaction identity. When the id changes, the prior
transaction is complete and its data-change count is folded into a running total;
once that total `>= batchSize`, the loop `break`s — abandoning the iterator before
the next transaction is scanned.

The fact-resolution body (column-version / tombstone lookup, stale-entry skip) was
extracted verbatim into a new `resolveLogEntry(logEntry): Promise<Change | null>`
helper, reused by the loop. No behavioral change there.

`getChangesSince` now passes `this.config.batchSize` into `collectChangesSince`.

## Core correctness claim (please scrutinize)

**The grouped response is byte-identical to the old full-scan behavior.** The
early-exit replicates `buildTransactionChangeSets`'s bound *exactly*: accumulate
whole transactions until cumulative data-change count `>= batchSize`, break after the
transaction that crosses it. Feeding `buildTransactionChangeSets` this bounded prefix
yields the same ChangeSets, because it re-applies the same bound (idempotent on the
prefix). Key invariants relied on:

- **Contiguity**: facts of one transaction are adjacent in the HLC-ordered scan
  (identity is the key prefix before opSeq; identity is unique per `tick()`). If this
  ever broke, the boundary detection would mis-count.
- **Bound match**: the running total counts only *pushed* changes
  (`currentTxnChangeCount++` only on a non-null resolve), matching
  `group.changes.length`. The bound-crossing transaction is fully scanned and
  included *before* the break (the break fires on the *next* transaction's first
  entry). Cross-check against the unit test `change-grouping.spec.ts` line 96:
  "batchSize 3 … after t2 cumulative=4 (>=3, stop)".
- **Peer echo filter**: `siteIdEquals` skip runs *before* boundary detection, so a
  peer-owned transaction never registers as a boundary (a transaction is wholly one
  site's). Verify this doesn't desync the boundary counter.
- **Stale entries**: a non-null-resolving entry still sets `currentTxnId` but adds 0
  to the count — matching the old code, where stale entries produced no Change and so
  never reached the grouper.

## Test added

`packages/quereus-sync/test/sync/sync-manager.spec.ts` →
"bounds the change-log scan at scan time (does not drain the whole log)":
- 5 single-fact transactions, `batchSize = 2`.
- Wraps `kv.iterate` to count `cl:`-prefixed (change-log) entries actually pulled.
  (`getColumnVersion`/`getTombstone` use `kv.get`, so only the range scan is counted.)
- Asserts the response is the first 2 transactions AND `changeLogEntriesScanned <= 3`
  (stops at the 3rd transaction's boundary), `< 5` (never reaches 4th/5th). This is
  the direct proof of scan-boundedness — without the fix the count would be 5.

## Validation performed

- `yarn workspace @quereus/sync run typecheck` → clean (exit 0).
- `yarn workspace @quereus/sync run test` → **254 passing**. (The `batch write failed`
  / `iterate failed` lines in output are pre-existing error-handling tests that
  deliberately sabotage the KV store — not failures.)
- Scope: validation limited to `@quereus/sync`, the only package whose code changed.
  Dependents (`quereus-sync-client`, `sync-coordinator`) consume only the public
  `getChangesSince`, whose response is unchanged — no integration run done. A reviewer
  wanting belt-and-suspenders could run the full `yarn test`.

## Known gaps / deliberately out of scope (be honest, reviewer)

1. **From-zero full scan still unbounded.** `collectAllChanges` (no `sinceHLC`) scans
   `cv:`/`tb:` keyed by table/pk, not HLC — transactions interleave arbitrarily, so
   there is no reachable transaction boundary without a full scan + sort. Left
   unbounded by design: large initial ranges are served by snapshots, not this path
   (per the original ticket). Documented in the method's doc comment + `docs/sync.md`.
   *Could* be unified onto the change-log scan (the apply path writes change-log
   entries for remote changes too, so the log indexes all current changes) — but that
   is a riskier semantic change (stale-entry equivalence, relay/forwarding coverage)
   and was intentionally not attempted here. If a reviewer thinks the full path needs
   bounding, that's a new fix/plan ticket, not an inline change.

2. **Schema-migration scan still fully drained.** `collectSchemaMigrations` scans the
   whole `sm:` range (not HLC-ordered) even when the fact side early-exits. Correct
   because `buildTransactionChangeSets` drops migrations sorting past the bounded fact
   watermark, and migrations are few. **Residual unbounded case**: a peer with a
   pathological volume of un-synced DDL (many migrations after `sinceHLC`) still
   materializes them all. The original ticket explicitly accepted this ("migrations
   are few"); flagged here so it isn't mistaken for fully closed. Bounding it would
   need an HLC-ordered migration index or a watermark-coordinated filter — a separate
   ticket if ever warranted.

3. **Response memory unchanged.** The fix bounds the *scan*, not the returned batch —
   the returned `changes` array is the same size as before for a given `batchSize`.
   That's the intended behavior (the response was already bounded); noted so the
   memory win is understood as scan-side only.

## Suggested reviewer checks

- Re-derive the bound trace for a tricky case: a DDL-only transaction interleaved
  between two data transactions (it has no change-log entries, so it's invisible to
  the fact scan — confirm it still rides along via the full `sm:` scan and groups
  correctly before the break).
- Confirm `noUnusedLocals`/imports clean (`ColumnChange`, `RowDeletion`,
  `ChangeLogEntry`, `deterministicTxnId` all still referenced).
- Consider an integration-level test across `applyChanges` → `getChangesSince` round
  trips with mixed DDL/DML and `batchSize` smaller than the delta, asserting no
  repeats/gaps across rounds (the existing "round-trips across a batchSize boundary"
  test covers data-only; a DDL-interleaved variant would harden the migration caveat).
