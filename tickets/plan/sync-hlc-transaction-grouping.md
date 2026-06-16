description: Make "HLC = transaction" real in @quereus/sync. Tick the HLC once per commit (not per row-event), add a per-transaction `opSeq` sub-order so the comparison key is a total order, group `getChangesSince` output by transaction (never splitting a commit across ChangeSets), and advance the per-peer `lastSyncHLC` watermark only at transaction boundaries. Delivers the transaction atomicity / referential-integrity property `docs/sync.md` already claims but the code does not enforce. Lesson borrowed from Lamina ("HLC = transaction", §4 of ../lamina/docs/architecture.md).
difficulty: hard
files:
  - packages/quereus-sync/src/clock/hlc.ts                  # HLC type, compareHLC, (de)serialize, HLCManager.tick — add opSeq
  - packages/quereus-sync/src/sync/protocol.ts              # ColumnChange/RowDeletion/ChangeSet/SchemaMigration carry HLC; transactionId
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # handleDataChange (per-event tick :185), getChangesSince (batchSize slicing :429), currentTransactionId (:82/:223), updatePeerSyncState
  - packages/quereus-sync/src/metadata/change-log.ts        # ChangeLogStore — entries keyed by HLC; opSeq must enter the key for stable order
  - packages/quereus-sync/src/metadata/keys.ts              # buildChangeLogKey / parseChangeLogKey — HLC encoding in the key
  - packages/quereus-store/src/common/events.ts             # StoreEventEmitter already has startBatch/flushBatch/discardBatch — surface the batch as a transaction grouping
  - packages/quereus-store/src/common/transaction.ts        # commit/rollback boundary that drives the batch flush/discard
  - docs/sync.md                                            # § Transaction-Based Change Grouping, § Delta Sync — the spec these changes make true
----

# Make "HLC = transaction" real: per-transaction HLC + opSeq + boundary-aligned watermark

## Problem

`docs/sync.md` promises transaction-grouped, atomic sync: *"All changes within a
transaction are sent as a unit… Applying changes is atomic per transaction… This
preserves referential integrity across related writes."* The code does **not**
uphold this — the transaction notion is vestigial:

- **Record path ticks per row-event, not per commit.** `handleDataChange`
  (`sync-manager-impl.ts:185`) calls `hlcManager.tick()` for every
  `DataChangeEvent`, so every row in one SQL transaction gets a *distinct* HLC.
- **`currentTransactionId` is never assigned.** Declared `null`
  (`sync-manager-impl.ts:82`), read at `:223`, never set — so it always falls
  back to `crypto.randomUUID()`. There is no real per-transaction identity.
- **Extraction re-batches by `batchSize`, destroying commit boundaries.**
  `getChangesSince` (`:429-441`) flattens all changes and slices them into
  `config.batchSize`-sized chunks, giving each chunk a fresh random
  `transactionId` and a synthetic `hlc: maxHLC`. One source transaction can
  split across two ChangeSets; two source transactions can merge into one.
- **The watermark therefore advances at arbitrary points.** `lastSyncHLC`
  (`PeerSyncState`) lands on a `batchSize` slice boundary, never guaranteed to
  be a transaction-consistent commit boundary.

A relevant asset already exists: `StoreEventEmitter` (`events.ts:171-201`) has
`startBatch()` / `flushBatch()` / `discardBatch()`, driven by the store's
commit/rollback (`transaction.ts`). The transaction boundary is *already
represented in the store* — it is simply replayed to listeners as N ungrouped
events, so the sync layer can't see "these N events are one commit."

## The model to adopt (Lamina §4 "HLC = transaction")

- **The HLC ticks once per commit.** Every fact a transaction produces shares
  that one HLC.
- **An `opSeq` distinguishes facts within the transaction** (a per-transaction,
  contiguous sub-order). The canonical comparison key becomes the 4-tuple
  `(wallTime, counter, siteId, opSeq)`, a single total order.
- **Every HLC is a transaction-consistent commit boundary** by construction, so
  delta cursors and point-in-time reads are transaction-consistent for free.

```ts
// hlc.ts — extend the tuple
interface HLC {
  readonly wallTime: bigint;
  readonly counter: number;
  readonly siteId: SiteId;
  readonly opSeq: number;     // NEW: per-transaction sub-order; 0 for the first fact
}
// compareHLC: …existing three comparisons…, then `a.opSeq - b.opSeq`.
```

## Required behavior

1. **One HLC per transaction, opSeq per fact.** Tick the HLC once at the store
   transaction boundary (the `startBatch` point) and assign an incrementing
   `opSeq` to each `DataChangeEvent` as the batch flushes. This needs the store
   to surface the batch *as a grouping* — the smallest viable addition is a
   transaction-scoped signal on flush (e.g. an `onTransactionCommit(events[])`
   hook, or a boundary marker threaded through `flushBatch`). The batching
   machinery already exists; only the grouping signal is missing.

2. **opSeq enters the change-log key.** `ChangeLogStore` entries are ordered by
   the HLC encoded in their key (`buildChangeLogKey`). Append `opSeq` to the
   encoded order so a transaction's facts scan back in their original write
   order — this is what makes FK *parent-before-child* apply deterministically
   and delivers the referential-integrity property the doc claims.

3. **`getChangesSince` groups by transaction, never splits one.** Replace the
   flat `batchSize`-slice with grouping by transaction HLC. When a batch would
   exceed `batchSize`, split *between* transactions, never mid-transaction; a
   single transaction larger than `batchSize` is sent whole (and should be
   surfaced/telemetered rather than silently chunked). Drop the synthetic
   `transactionId`/`maxHLC` fabrication in favor of the real transaction HLC.

4. **Watermark halts at transaction boundaries.** `lastSyncHLC` advances only to
   a transaction's HLC, never to a mid-transaction point (cf. Lamina invariants
   `cursor-halts-at-hlc-boundary`, `per-hlc-group-atomicity`). A partially
   applied transaction is never observable, and a re-fetch always resumes from a
   clean commit boundary.

## Why it matters

- **Referential integrity across related writes** (the doc's claim) becomes
  true: opSeq preserves intra-transaction order on apply.
- **The "poison batch" reasoning sharpens.** The failure/retry unit is a
  well-defined transaction (one HLC group), not an arbitrary slice — directly
  relevant to `sync-seam-throw-retry-mv-divergence` (see Interactions).
- **Determinism.** A total order including intra-transaction sub-order matches
  the engine-wide determinism discipline; same facts ⇒ same order on every peer.

## Interactions with existing tickets

- **`sync-seam-throw-retry-mv-divergence`** — strongest interaction. That
  ticket's quarantine / re-derive options become cleaner when the failing unit
  is a transaction-HLC group rather than a `batchSize` slice. Co-design: this
  ticket defines the unit that one quarantines or re-derives. Not a hard
  blocker, but landing this first simplifies that fix.
- **`sync-unknown-table-disposition`** — its `quarantine` / `store-and-forward`
  dispositions should retain/relay at *transaction-group* granularity so a
  straggler's commit stays atomic on replay; the transaction HLC is the stable
  unit to hold and forward.
- **`store-atomic-multi-store-commit`** — orthogonal but synergistic: that
  ticket's "one durable commit per transaction per module" assumes a defined
  transaction boundary; this ticket makes that boundary explicit and is the
  natural commit unit if atomic multi-store lands.
- **`sync-basis-eviction-policy`** — low impact; its "when did a change to this
  table last originate at a peer that maps it" derivation reads the same change
  log and peer watermarks. Consistency note only: the watermark now lands on
  transaction boundaries and the change-log key gains `opSeq`.

## Edge cases & interactions to resolve in the plan pass

- **opSeq exhaustion / very large transactions** — width of `opSeq` and the
  policy when a single transaction exceeds `batchSize`.
- **Schema migrations within a transaction** — today `getChangesSince` attaches
  all `schemaMigrations` to the first batch only (`:439`). With DDL-before-DML
  ordering (`docs/sync.md` § DDL Application Order), migrations and data in one
  commit must share the transaction HLC and order by opSeq.
- **Mixed-origin facts under the same HLC** — `prior_hlc`-style disambiguation
  across sites at equal `(wallTime, counter)`; confirm `siteId` + `opSeq`
  tiebreak is sufficient.
- **Change-log key format change** — `buildChangeLogKey` encoding changes;
  decide greenfield-only vs. a re-index/migration (AGENTS.md: backwards-compat
  is not yet a goal, but the on-disk key order must stay monotone).
- **Rollback / discardBatch** — a discarded batch must consume no HLC/opSeq that
  later leaks into a committed transaction's ordering.
- **HLCManager.receive** on inbound facts must carry/merge opSeq without
  breaking monotonicity.

---

## Feed note (2026-06-15): decision-free — fulfills a documented contract

Promoted backlog→plan to keep the runner fed. This makes the code uphold the transaction-atomic
sync property `docs/sync.md` **already promises** ("changes within a transaction are sent as a
unit… applying is atomic per transaction") but does not enforce. The approach is pinned in the body
(tick HLC once per commit, add per-transaction `opSeq` for a total order, group `getChangesSince`
by transaction, advance `lastSyncHLC` only at commit boundaries). The plan pass should decompose it;
if any sub-choice turns out to need a real semantic decision (not just mechanics), block/ that part
for the dev rather than pick unilaterally.
