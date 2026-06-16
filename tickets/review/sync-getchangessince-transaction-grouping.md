description: Review the rewrite of `getChangesSince` to emit one ChangeSet per source transaction (grouped by HLC identity), with transaction-granularity bounding, oversized-transaction telemetry, and a watermark that halts at commit boundaries. The synthetic batchSize-slice / randomUUID / maxHLC fabrication is gone.
files:
  - packages/quereus-sync/src/sync/change-grouping.ts          # NEW shared grouping+bounding helper
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # getChangesSince + collectChangesSince/collectAllChanges/collectSchemaMigrations
  - packages/quereus-sync/src/sync/protocol.ts                 # ChangeSet doc-comments (transactionId/hlc semantics)
  - packages/quereus-sync/test/sync/change-grouping.spec.ts    # NEW unit tests (pure helper)
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # NEW integration tests (grouping, oversized, round-trip)
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts  # NEW two-replica grouping/watermark e2e
  - packages/quereus-sync-client/src/sync-client.ts            # UNCHANGED — verified watermark uses ChangeSet.hlc
  - docs/sync.md                                               # § Transaction-Based Change Grouping → Read side; § Delta Sync Optimization
----

# Review: getChangesSince groups by transaction; watermark halts at commit boundaries

## What landed

`getChangesSince` (and the full-extraction path) now emit **one `ChangeSet` per
source transaction**, grouped by HLC identity `(wallTime, counter, siteId)` — the
identity established by `sync-per-transaction-hlc-tick`. The old code (flatten all
changes → slice into `batchSize` chunks → fresh `randomUUID` + synthetic `maxHLC` per
chunk, `schemaMigrations` on chunk 0 only, plus a separate DDL-only special case) is
**deleted**.

Core of the change is a new pure helper, `change-grouping.ts`:

- `groupByTransaction(changes, migrations)` — buckets facts + migrations by
  `deterministicTxnId(hlc)` (which excludes `opSeq`, so it *is* the transaction
  identity), orders groups by base HLC ascending, and orders each group's facts and
  migrations by `opSeq`. Input order is irrelevant.
- `buildTransactionChangeSets(changes, migrations, batchSize, onOversized?)` — builds
  one ChangeSet per group:
  - `changes` in opSeq order, `schemaMigrations` in opSeq order (DDL took the lower
    opSeqs on the write side, so DDL sorts below the same tx's DML);
  - `hlc` = the group's **max** fact HLC (last opSeq) = the commit boundary;
  - `transactionId` = `deterministicTxnId(base)` (same derivation as the write side);
  - `siteId` = the group's origin site (== `base.siteId`).
  - **Bounding** accumulates *whole* transactions; once cumulative `changes` count
    `>= batchSize`, it stops. A transaction is never split.
  - **Oversized** (one tx with > batchSize facts) is returned whole and reported via
    `onOversized` → `console.warn` in the manager.

`sync-manager-impl.ts` `getChangesSince` was decomposed into `collectChangesSince`
(delta scan), `collectAllChanges` (full scan, no longer pre-sorts — grouping owns
ordering), and `collectSchemaMigrations`, all feeding the helper.

## Why it's correct (the invariants to check)

- **No split / no merge**: a transaction's facts share `(wallTime, counter, siteId)`
  and the change-log key sorts by the 4-tuple, so they're contiguous; grouping by the
  triple reunites exactly one commit. Two commits always differ in `(wallTime,
  counter)` (consecutive `tick()`s) or `siteId`, so they never collapse.
- **Watermark halts at boundaries**: `ChangeSet.hlc` is a real commit's max fact HLC;
  `buildChangeLogScanBoundsAfter` excludes everything `<=` it, so a consumer setting
  `lastSyncHLC = max(ChangeSet.hlc)` resumes strictly *after* the whole transaction.
  `applyChanges` is atomic per ChangeSet and commits metadata only on success, so a
  failed ChangeSet never advances the watermark.
- **Echo filter is whole-transaction**: a transaction is wholly one site's, so
  skipping `hlc.siteId == peerSiteId` facts drops whole transactions — never a
  half-empty ChangeSet.
- **Client side unchanged**: `quereus-sync-client`'s `maxHLCFromChangeSets` already
  maxes over `cs.hlc` (= `ChangeSet.hlc`), used for both `peerSyncState` and
  `pendingSentHLC`. Verified, left as-is; docs clarified to encode the invariant.

## Validation performed (all green)

- `@quereus/sync` build: clean. Tests: **238 passing**.
- `@quereus/sync-client` build + tests: **45 passing**.
- `@quereus/sync-coordinator` tests: **121 passing** (real `syncManager.getChangesSince`
  relay path — coordinator only serializes/relays ChangeSet[], no dependency on count
  or id format).

### Tests added

- `change-grouping.spec.ts` (unit, pure): empty → []; one tx N facts → one ChangeSet
  in opSeq order with max-fact hlc + deterministic id; two txns never merged (distinct
  id/hlc, ordered ascending); transaction-granularity bound stops between txns;
  oversized returned whole + `onOversized` fired; DDL-only ChangeSet; DDL+DML grouped
  (DDL lower opSeq); different sites at same `(wallTime,counter)` split.
- `sync-manager.spec.ts` → `getChangesSince transaction grouping`: deterministic id
  shape + stability + max-fact hlc; no-merge of two commits; DDL+DML one ChangeSet;
  oversized whole + `console.warn` telemetry; **watermark round-trip across a
  batchSize boundary** (batchSize=3, three 2-fact txns → each returned exactly once,
  in order, no repeats/gaps — exercises both full-extraction and delta paths).
- `sync-protocol-e2e.spec.ts` → `Transaction Grouping (two replicas)`: host commits
  two multi-row transactions; guest delta-syncs **two** atomic ChangeSets, applies
  both (transactions=2, applied=8); watermark = second tx's `ChangeSet.hlc`; re-fetch
  from the watermark returns nothing.

## Known gaps / where the reviewer should push (tests are a floor)

- **Memory, not bounded mid-scan**: `getChangesSince` still materializes *all* facts
  since `sinceHLC` (and all migrations) into memory before grouping+bounding — same
  profile as the old slice code; `batchSize` caps the *response*, not the scan. Early
  exit is awkward because migrations come from a separate, non-HLC-ordered `sm:` scan.
  Acceptable for now (deltas are small; initial sync uses snapshots) but worth a
  follow-up if large deltas are expected. **Not addressed in this ticket.**
- **Oversized telemetry is `console.warn` only**: I deliberately did **not** add a new
  `SyncState` variant (there's no `info` status and adding one risks breaking
  exhaustive consumers) nor a dedicated counter. The ticket listed those as
  *examples*. If programmatic observability is wanted (a counter or a dedicated
  event), that's a small follow-up — flagging rather than guessing the API.
- **Cross-table intra-transaction apply order**: `opSeq` is true write order
  *intra-table* but per-coordinator commit order *cross-table* (inherited from
  `sync-per-transaction-hlc-tick`, see `backlog/sync-cross-table-apply-ordering.md`).
  Grouping preserves whatever opSeq order the write side produced; it does not and
  cannot fix cross-table dependency ordering. Out of scope here.
- **Multi-table single transaction not explicitly tested**: the DDL+DML test uses one
  table. A single commit spanning multiple tables still shares the base HLC and groups
  into one ChangeSet, but there's no dedicated assertion. Cheap to add — a good probe.
- **Oversized + migrations untested**: oversized telemetry is asserted for a data-only
  tx; an oversized DDL+DML tx isn't exercised.
- **ChangeSet.siteId for relayed (third-site) transactions**: the group's `siteId` is
  `base.siteId`, so a relayed transaction carries its *original* site, not
  `getSiteId()`. Existing echo tests (B relays A's facts; A sees them skipped) cover
  this implicitly and pass, but no grouping test asserts `ChangeSet.siteId ==
  originating site` directly.

## Manual usage sanity

```ts
// One commit of N facts → exactly one ChangeSet; advance watermark by ChangeSet.hlc.
const sets = await manager.getChangesSince(peerSiteId, sinceHLC);
for (const cs of sets) {
  await peer.applyChanges([cs]);               // atomic per transaction
  watermark = cs.hlc;                          // commit boundary
}
// Re-fetch from `watermark` returns strictly subsequent transactions (no repeats).
```
