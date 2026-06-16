description: Make `getChangesSince` emit one `ChangeSet` per source transaction (grouped by the transaction's HLC identity), never splitting a commit across ChangeSets and never merging two commits into one. Drop the synthetic `batchSize`-slice / random `transactionId` / `maxHLC` fabrication. Attach each transaction's schema migrations to its own ChangeSet. Bound the response at transaction granularity. Guarantee the per-peer `lastSyncHLC` watermark only ever lands on a transaction boundary.
prereq: sync-per-transaction-hlc-tick
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # getChangesSince (:353-458), collectAllChanges, schemaMigration scan
  - packages/quereus-sync/src/sync/protocol.ts              # ChangeSet (transactionId/hlc semantics)
  - packages/quereus-sync/src/metadata/change-log.ts        # getChangesSince iterator (ordered by HLC incl. opSeq)
  - packages/quereus-sync-client/src/                       # watermark advance — confirm it uses ChangeSet.hlc (transaction boundary)
  - docs/sync.md                                            # § Transaction-Based Change Grouping, § Delta Sync Optimization
difficulty: hard
----

# getChangesSince: group by transaction, halt the watermark at commit boundaries

## What's wrong today

`getChangesSince` (`sync-manager-impl.ts:429-441`) flattens all changes and slices
them into `config.batchSize` chunks, giving each chunk a fresh random
`transactionId` and a synthetic `hlc: maxHLC`, and attaches all `schemaMigrations` to
the first chunk only (`:439`). This **splits** one source transaction across two
ChangeSets, **merges** two transactions into one, and lands the watermark on an
arbitrary slice boundary. The `ChangeSet` contract (`protocol.ts`,
`docs/sync.md`) says a ChangeSet **is** one transaction, applied atomically.

After `sync-per-transaction-hlc-tick`, every fact carries a transaction-identifying
HLC: all facts of one commit share `(wallTime, counter, siteId)` and differ only in
`opSeq`, and the change-log key now sorts by `(wallTime, counter, siteId, opSeq)`
(from `sync-hlc-opseq-foundation`). That makes correct grouping a straightforward
scan.

## New behavior (RESOLVED)

`getChangesSince(peerSiteId, sinceHLC)`:

1. Scan the change log from `sinceHLC` (already ordered by the 4-tuple). Skip facts
   originating from `peerSiteId` (echo) — a transaction is entirely one site's, so
   this filters whole transactions cleanly.
2. **Group consecutive facts by transaction identity** `(wallTime, counter, siteId)`
   — because the scan is HLC-ordered, one transaction's facts are contiguous and in
   `opSeq` order. Each group becomes **one `ChangeSet`**:
   - `changes`: the group's facts in `opSeq` order (preserves intra-transaction write
     order → deterministic parent-before-child apply).
   - `hlc`: the group's **maximum** fact HLC (the last `opSeq`). Using the max means a
     consumer that sets `lastSyncHLC = ChangeSet.hlc` and re-fetches resumes strictly
     *after* the whole transaction (`buildChangeLogScanBoundsAfter` excludes
     everything `<=` it).
   - `transactionId`: the **deterministic** id derived from the group's base HLC
     `(wallTime, counter, siteId)` — same derivation as the write side
     (`sync-per-transaction-hlc-tick`). No more `randomUUID`.
   - `siteId`: the group's origin site (== `getSiteId()` for locally-originated
     facts; preserve the fact's site for relayed facts).
3. **Schema migrations** are scanned from `sm:` (as today) but **matched to their
   transaction group** by `(wallTime, counter, siteId)` of `migration.hlc` and placed
   in that ChangeSet's `schemaMigrations` (ordered by opSeq, DDL before DML is then
   guaranteed by the applicator which processes `schemaMigrations` first). A migration
   whose transaction has **no** data facts forms its own DDL-only ChangeSet. Drop the
   "first batch only" hack.
4. **Bounding by `batchSize`** happens at **transaction granularity**: accumulate
   whole ChangeSets, tracking cumulative `changes` count; once a completed transaction
   pushes the cumulative count `>= batchSize`, stop and return — the remaining
   transactions come on the next `getChangesSince` call (the consumer advances its
   watermark to the last returned ChangeSet's `hlc` and re-fetches). **Never** split a
   transaction to hit the bound.
5. **Oversized transaction** (a single transaction whose fact count `> batchSize`) is
   returned **whole** as one ChangeSet and **telemetered** — `log()` a warning and
   surface it (e.g. an `emitSyncStateChange` info or a dedicated counter), not silently
   chunked.

Order the returned `ChangeSet[]` by transaction HLC ascending so the consumer applies
and advances monotonically.

## Watermark halts at transaction boundaries (RESOLVED)

The watermark guarantee is a property of (a) this function returning **whole**
transactions whose `hlc` is a real commit boundary, and (b) the consumer setting
`lastSyncHLC = max(applied ChangeSet.hlc)`. Verify the consumer side
(`quereus-sync-client`, and any `updatePeerSyncState` caller) advances using
`ChangeSet.hlc` — **not** a per-change max or a slice boundary. If a consumer
currently computes its own max over `changes[].hlc`, that still lands on the
transaction's max fact HLC (same value) — but make it explicitly `ChangeSet.hlc` for
clarity and to encode the invariant. A partially applied transaction must never
advance the watermark; `applyChanges` already applies a ChangeSet atomically and only
commits metadata on success (`docs/sync.md` § Transactional Integrity), so a failed
ChangeSet leaves the watermark at the prior boundary.

## `collectAllChanges` (no `sinceHLC`, full extraction)

The full-extraction path (initial sync) currently sorts all column-versions +
tombstones by HLC then the caller slices by `batchSize`. Apply the same
transaction-grouping to it: after sorting by the 4-tuple, group by
`(wallTime, counter, siteId)` into per-transaction ChangeSets with the same bounding
rule. (Initial sync is more often a snapshot, but keep this path transaction-faithful
for the delta-from-zero case.)

## Edge cases & interactions

- **Transaction split prevention** — a transaction with facts straddling what *was* a
  `batchSize` boundary must come back as one ChangeSet. Test: a transaction of
  `batchSize + 5` facts → exactly one ChangeSet of `batchSize + 5` changes + a
  telemetry signal.
- **Two transactions never merge** — two commits at adjacent HLCs → two ChangeSets
  with distinct `transactionId` and `hlc`. Test.
- **DDL-only transaction** — a `create table` with no DML → one ChangeSet,
  `changes: []`, `schemaMigrations: [migration]`, `hlc` = migration HLC. Test
  (replaces the old `result.length === 0 && schemaMigrations.length > 0` special
  case, which can be removed or reframed as "DDL-only groups").
- **DDL+DML same transaction** — migration and data share `(wallTime, counter,
  siteId)`; both land in one ChangeSet; migration sorts first by opSeq. Test.
- **Echo filtering** — facts from `peerSiteId` are excluded; a transaction wholly from
  `peerSiteId` yields no ChangeSet (never a half-empty one). Test.
- **Empty delta** — no facts after `sinceHLC` and no migrations → `[]`.
- **Watermark resume** — apply returned ChangeSets, set `sinceHLC` to the last
  `ChangeSet.hlc`, call again → returns strictly the subsequent transactions, no
  repeats, no gaps. Test the round-trip across a `batchSize` boundary (multiple
  getChangesSince calls reconstruct all transactions exactly once each).
- **`canDeltaSync` / tombstone TTL** — unaffected; grouping is orthogonal.

## Key tests (TDD)

- One transaction (N facts) → one ChangeSet, N changes in opSeq order, `hlc` = max
  fact HLC, deterministic `transactionId`.
- Oversized transaction (> batchSize) → one whole ChangeSet + telemetry; not split.
- Two transactions under one batch → two ChangeSets; bound stops between them when
  cumulative ≥ batchSize.
- DDL-only and DDL+DML transactions grouped correctly.
- Watermark round-trip: repeated getChangesSince with advancing `sinceHLC` =
  ChangeSet.hlc returns each transaction exactly once, in order.
- A two-replica integration test (extend existing sync e2e): peer A commits two
  multi-row transactions; peer B delta-syncs and observes two atomic ChangeSets, applies
  both, and its watermark equals A's second transaction HLC.

## TODO

- Rewrite `getChangesSince` to group the change-log scan + schema migrations by
  `(wallTime, counter, siteId)` into per-transaction ChangeSets; remove the
  `for (i += batchSize)` slice, the `maxHLC` fabrication, the `randomUUID`
  transactionId, and the "schemaMigrations on first batch only" hack.
- Implement transaction-granularity bounding (accumulate whole transactions to
  `batchSize`) and oversized-transaction telemetry.
- Apply the same grouping to `collectAllChanges` (or fold it into a shared grouping
  helper used by both paths — stay DRY).
- Derive `transactionId` with the same `deterministicTxnId` helper as the write side
  (share it; do not duplicate).
- Verify/adjust the watermark advance in `quereus-sync-client` (and any
  `updatePeerSyncState` call site) to use `ChangeSet.hlc`. If a change is needed there,
  keep it minimal and covered by a test.
- Update `protocol.ts` doc-comments on `ChangeSet.transactionId` / `hlc` to state they
  identify exactly one source transaction.
- Update `docs/sync.md` § Transaction-Based Change Grouping and § Delta Sync
  Optimization to describe one-ChangeSet-per-transaction, transaction-granularity
  bounding, oversized-transaction handling, and the watermark-halts-at-boundary
  invariant.
- `yarn workspace @quereus/sync build` + sync tests (incl. the e2e). If the client
  watermark changes, build/test `quereus-sync-client` too.
