description: getChangesSince now emits one ChangeSet per source transaction (grouped by HLC identity), bounded at transaction granularity, with oversized-transaction telemetry and a watermark that halts at commit boundaries. The synthetic batchSize-slice / randomUUID / maxHLC fabrication is gone. Reviewed and accepted.
files:
  - packages/quereus-sync/src/sync/change-grouping.ts          # NEW shared grouping+bounding helper
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # getChangesSince + collectChangesSince/collectAllChanges/collectSchemaMigrations
  - packages/quereus-sync/src/sync/protocol.ts                 # ChangeSet doc-comments
  - packages/quereus-sync/test/sync/change-grouping.spec.ts    # unit tests (pure helper)
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # integration tests (+ multi-table, origin-siteId added in review)
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts  # two-replica grouping/watermark e2e
  - docs/sync.md                                               # § Transaction-Based Change Grouping → Read side; § Delta Sync Optimization
----

# Complete: getChangesSince groups by transaction; watermark halts at commit boundaries

`getChangesSince` (and the full-extraction path) emit **one `ChangeSet` per source
transaction**, grouped by HLC identity `(wallTime, counter, siteId)`. The pure helper
`change-grouping.ts` (`groupByTransaction` / `buildTransactionChangeSets`) owns ordering
and transaction-granularity bounding; `sync-manager-impl.ts` decomposes extraction into
`collectChangesSince` / `collectAllChanges` / `collectSchemaMigrations`. The old
slice-into-batchSize-chunks + `randomUUID` + synthetic `maxHLC` + DDL-only special case
is deleted. `ChangeSet.transactionId` is now `deterministicTxnId(base)` (stable across
peers); `ChangeSet.hlc` is the commit's max fact HLC (the commit boundary);
`ChangeSet.siteId` is the transaction's origin site.

## Review findings

**Verdict: accepted.** The implementation is correct and the invariants hold. One
backlog ticket filed for a known (pre-existing-profile) scalability limit; two test
probes added inline. No major defects found.

### Correctness (checked, sound)

- **No split / no merge.** Grouping by `(wallTime, counter, siteId)` reunites exactly
  one commit: a transaction's facts share that triple and differ only in `opSeq`; two
  commits always differ in `(wallTime, counter)` or `siteId`. Verified against
  `compareHLC`, which orders `(wallTime, counter, siteId, opSeq)` — siteId **before**
  opSeq.
- **Watermark monotonicity across groups.** Because siteId outranks opSeq in
  `compareHLC`, every fact of a lower-base group sorts strictly below every fact of a
  higher-base group. So the per-group max HLCs are themselves monotonic, the last
  returned ChangeSet carries the global max, and `lastSyncHLC = max(ChangeSet.hlc)`
  advances correctly.
- **Bounding leaves no gap.** `buildTransactionChangeSets` returns a contiguous prefix
  of groups (ascending base); every dropped group has base **>** the last returned
  group's base, hence all its facts *and migrations* have hlc > watermark and are
  re-collected next round — no repeats, no gaps. Traced through both the fact scan
  (`changeLog.getChangesSince` excludes `<=`) and the migration filter
  (`compareHLC(migration.hlc, sinceHLC) <= 0`). The implementer's round-trip test
  exercises this across the full→delta boundary.
- **`ChangeSet.siteId` origin change is safe.** Was `getSiteId()` (relay site), now
  `base.siteId` (origin). Audited all consumers: the applicator's echo filter and
  `emitRemoteChange` key off **`change.hlc.siteId`** (per-fact), not `ChangeSet.siteId`;
  the coordinator's broadcast echo-skip keys off the **`client.siteId` parameter**, not
  `ChangeSet.siteId`; serialization merely round-trips it. The change is strictly more
  correct and breaks no consumer. (Resolves the implementer's flagged gap.)
- **Echo filter is whole-transaction**, **DDL-before-DML** apply order holds (applicator
  loops `schemaMigrations` before `changes`), and the **client watermark**
  (`maxHLCFromChangeSets` over `cs.hlc`) is unchanged and correct.
- **Docs** (`docs/sync.md` Read-side + Delta Sync sections) read accurately against the
  code — pseudocode, bounding, oversized, and watermark-halts-at-boundary all match.

### Tests

- Lint/build: `@quereus/sync` builds clean (no lint script for this package; test files
  are not part of the src build). `@quereus/sync` **239 passing**, `@quereus/sync-client`
  **45 passing**, `@quereus/sync-coordinator` **121 passing** (relay path unaffected).
- **Added inline (minor):** (1) a multi-table single-transaction test — one commit
  touching two tables groups into one ChangeSet carrying both tables' facts (directly
  validates the cross-table "one commit = one ChangeSet" invariant the implementer
  flagged as untested); (2) an origin-`siteId` assertion on a local transaction
  (`ChangeSet.siteId == manager.getSiteId()`), closing the relayed-siteId gap directly.

### Filed as follow-up

- **`backlog/sync-getchangessince-bounded-extraction`** — `getChangesSince` still
  materializes all facts + migrations since `sinceHLC` before grouping/bounding;
  `batchSize` caps the response, not the scan. Pre-existing memory profile (not a
  regression), acceptable today (deltas small, initial sync uses snapshots), but tracked
  for when large deltas are expected. Early exit is awkward because migrations come from
  a separate, non-HLC-ordered `sm:` scan.

### Out of scope / not regressions (explicitly checked)

- **Duplicate column-change emission** when a column is overwritten across transactions:
  the delta scan walks change-log entries but resolves each to the *current*
  `getColumnVersion`, so a stale log entry and the winning entry can both yield the same
  current `cv.hlc`. Pre-existing (identical in the old slice code), idempotent on apply
  (LWW, same hlc), and untouched by this ticket. Not chased here.
- **Cross-table intra-transaction apply order** — opSeq is true write order intra-table
  but per-coordinator commit order cross-table; grouping preserves whatever opSeq order
  the write side produced and cannot fix dependency ordering. Already tracked in
  `backlog/sync-cross-table-apply-ordering`.
- **Oversized telemetry is `console.warn` only** — deliberate; no `SyncState` variant or
  counter added (the ticket listed those as *examples*). Accepted as-is; a programmatic
  counter/event would be a small future follow-up if observability is wanted.
- **Pre-existing unused `manager` bindings** in the error-injection tests
  (`sync-manager.spec.ts` ~lines 1316–1575) — surfaced by line-number shift from the
  added tests, not introduced here; test-only, no build/lint gate. Left untouched.
