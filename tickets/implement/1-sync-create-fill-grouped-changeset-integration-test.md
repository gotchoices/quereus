description: Add an end-to-end test proving that turning on replication for a materialized view built over a table that already has rows publishes those rows to peers as one batched change, so old peers receive them at deploy.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts          # existing replicate-MV sync harness (makePeer / relay / settle / collect)
  - packages/quereus-store/src/common/backing-host.ts                     # replaceContents replicating arm (:340 docstring on mid-txn batching)
  - packages/quereus/src/runtime/emit/materialized-view.ts                # emitCreateMaterializedView → _ensureTransaction (:24)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # materializeView create-fill (:486), rebuildBacking fast path (:1404)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                   # handleTransactionCommit: ONE HLC tick per committed txn (:289)
difficulty: medium
----

## Goal

Prove **end-to-end** the headline migration scenario: enabling replication on a
materialized view built over a source that **already holds rows** publishes the
create-fill rows to a peer, delivered as **one grouped change-set under a single
HLC** (not N ungrouped singletons). The grouping machinery is shared with the
row-time maintenance path the existing suite already exercises, so this is a
direct assertion of an otherwise-only-transitively-covered path. Test-only — **no
production code change is expected**. If you find yourself needing a production
edit to make this pass, stop and treat that as a finding (see Edge cases).

## Why the existing coverage is insufficient

`packages/quereus-store/test/backing-host.spec.ts` unit-covers the delta
computation in `replaceContents`'s replicating arm (fresh-fill emits one insert
per cold row; identical re-fill suppressed; partial diff; refresh-to-empty;
commit-first-with-pending-txn). But those drive the host **directly, outside any
engine transaction** — so the coordinator is not batching and each `queueEvent`
fires immediately. They prove the *deltas* are correct; they do **not** prove
the engine-transaction *grouping* (`startBatch`/`flushBatch` around the
create-fill, one HLC tick per commit) nor end-to-end *delivery* to a peer.

`packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts` builds its MV over
an **empty** `src`, so create-fill emits nothing — it only exercises subsequent
row-time maintenance. The cold-fill grouped delivery is unasserted at the
engine/sync layer.

## How the grouping works (the contract under test)

1. `emitCreateMaterializedView` calls `await rctx.db._ensureTransaction()`
   (`materialized-view.ts:24`), so the create-fill runs **inside** an engine
   transaction. The event emitter is therefore batching during the fill.
2. `materializeView` → `host.replaceContents(rows, …)`
   (`materialized-view-helpers.ts:486`). For a `quereus.sync.replicate = true`
   backing, `replaceContents`'s replicating arm (`backing-host.ts:340` docstring)
   diffs `rows` against the committed before-image (empty here → one `insert` per
   cold row) and `queueEvent`s each delta. Because the engine is mid-transaction,
   the store emitter is batching, so the deltas hold until the engine commit.
3. At commit, `flushBatch` releases them as one group
   (`database-transaction.ts:~276`). The SyncManager's `handleTransactionCommit`
   (`sync-manager-impl.ts:289`) ticks **ONE** HLC base per committed transaction
   and stamps each fact a successive `opSeq` off that base, recording them under
   one `deterministicTxnId(base)`.
4. `getChangesSince` groups log entries by `deterministicTxnId` into `ChangeSet`s
   (`sync-manager-impl.ts:577`). So all create-fill inserts surface in **exactly
   one** `ChangeSet` (one `transactionId`, one base `hlc`), not N singletons.

`ChangeSet` shape (`quereus-sync-client/src/types.ts` / `protocol`):
`{ siteId, transactionId: string, hlc: HLC, changes: Change[], schemaMigrations }`.
Each `Change` (a `ColumnChange` for an insert) carries `{ type, schema, table,
pk, column, value, hlc }`. **Note the granularity:** an insert records one
`ColumnChange` per **non-PK** column, not one change per row. For an MV
`(id, v)` keyed by `id`, each cold row yields exactly **one** `ColumnChange`
(column `v`). Choose distinct `v` values per row so the changes are
distinguishable, and assert change count against (rows × non-PK columns) — for
the `(id, v)` schema that is simply N.

## What to add

Add to `echo-loop-quiescence.spec.ts` (preferred — reuses `relay`/`settle`/
`collect`/`closePeer`) a new `describe` block, e.g. *"create-fill of a populated
source publishes one grouped change-set"*.

The existing `makePeer` creates `src` and the tagged `mv` back-to-back over an
empty source. You need a peer whose `src` is **populated before** the tagged MV
is created. Add a sibling builder rather than mutating `makePeer` (the existing
tests depend on its exact sequence):

- Factor the provider/events/db/module/manager wiring out of `makePeer` into a
  shared `makeBarePeer(name)` that stops **before** any `create table`, OR simply
  copy that wiring into a new `makeFilledPeer(name, seedRows)`. Keep `makePeer`
  byte-identical so the existing 5 tests are untouched.
- `makeFilledPeer` sequence: build the peer wiring → `create table src … using
  store` → seed `src` with N rows in **one** multi-row insert (one txn → one src
  ChangeSet, keeps the assertions clean) → **then** `create materialized view mv
  using store as select id, v from src with tags ("quereus.sync.replicate" =
  true)`. The MV must be created **after** the seed so create-fill is non-empty.
- Use N = 3 distinct rows, e.g. `(1,'a'), (2,'b'), (3,'c')`.

Peer B is built the **normal** way (empty `src`, MV over empty source — its own
create-fill emits nothing), matching the existing harness's "both peers already
agree on schema, only data is relayed" model. Remember `relay` already strips
`schemaMigrations`.

### Primary case — grouped publication on the producer (A)

After `makeFilledPeer('A', …)` and a `settle()`:

- `const sets = await A.manager.getChangesSince(generateSiteId())` (neutral id
  excludes nothing → A's full relayable log).
- Identify the set(s) whose `changes` reference `table === 'mv'`. Assert:
  - **exactly one** such `ChangeSet` exists (the grouping crux — N singletons
    would be N sets) — `mvSets.length === 1`.
  - that set's mv changes number N (one `ColumnChange` per cold row for the
    single non-PK column `v`).
  - all mv changes in it share the set's `transactionId` and the same base HLC
    (`wallTime`/`counter`/`siteId` equal; only `opSeq` differs) — i.e. they are
    genuinely one transaction, not coincidentally adjacent. (They share the set's
    `hlc` by construction; assert the per-change `hlc` bases match it to make the
    "single HLC" claim explicit and regression-proof.)
- Sanity: the seed produced its own separate `src` ChangeSet (distinct
  `transactionId` from the mv set) — confirms create-fill is its own group, not
  fused with the seed DML.

### Primary case — grouped delivery + convergence on the peer (B)

- `const res = await relay(A, B)` then assert `res.applied` > 0.
- Convergence: `collect(B.db, 'select id, v from mv')` deep-equals the seeded
  rows AND deep-equals `collect(A.db, …)`. Likewise `src`.
- Delivery grouping: assert B received the fill as one applied transaction, not
  N. Inspect `ApplyResult` — confirm its `transactions` count attributable to the
  mv fill is 1 (read the `ApplyResult` shape in `protocol.ts`; if `transactions`
  is not cleanly separable from the src set, instead re-read B's perspective via a
  pre-subscribed `B.events.onDataChange` capture and assert the mv inserts arrived
  remote:true with no local re-derivation — mirroring the existing suite's
  `localMvEvents` proof — and that B logs **zero** B-origin mv echo
  (`changesFor(B, A.manager.getSiteId())`)). Pick whichever the API supports
  cleanly; document the choice in a comment.

### Secondary case (optional, lower priority) — refresh over a populated backing

The ticket notes `rebuildBacking`'s fast path (`materialized-view-helpers.ts:1404`,
the constraint-less / MV-sugar branch) is the second `replaceContents` call site
and *should* group identically (same `_ensureTransaction` posture — verify
`emitRefreshMaterializedView` also `_ensureTransaction`s). **Caveat that makes a
clean assertion hard:** a `refresh materialized view mv` over a
continuously-row-time-maintained MV recomputes the **identical** committed set →
diffs to zero deltas → emits **nothing** (suppression). To get a non-empty
*grouped* refresh delta you would need the committed MV contents to have drifted
from the body by ≥1 row **without** row-time maintenance having applied it (the
"stale table" trigger in `rebuildBacking`'s docstring) — which is awkward to
stage in a synced-MV harness without contortion.

Decision: implement the **refresh-suppression** half cleanly (refresh the
converged MV → assert zero new change-sets / zero new mv events — proves the
refresh path is wired and does not double-publish), and **only** attempt the
non-empty refresh-grouping if a clean drift can be staged. If it cannot be staged
without hacking internals, **do not force it** — `log` the deferral in a code
comment and file a `tickets/backlog/` ticket (slug e.g.
`sync-refresh-stale-fill-grouped-changeset-test`) describing the stale-drift setup
needed. The unit suite already covers refresh-path delta correctness; the residual
grouping risk is low.

## Edge cases & interactions

- **Granularity (rows vs column-changes):** an insert is recorded per non-PK
  column, not per row. With the `(id, v)` schema that is 1:1, but write the
  assertion in terms of `rows × nonPkColumns` (and comment it) so a future
  multi-column MV doesn't silently break the count logic. Do **not** assert a flat
  "N changes" without this reasoning.
- **Seed must precede MV creation.** If seeded after, create-fill is empty and the
  test is vacuous-green. Add a guard assertion that A's single mv ChangeSet has
  `changes.length > 0` (and === N) so an accidental ordering regression goes red.
- **Seed as one txn, not N.** N single-row inserts produce N src ChangeSets and
  muddy "the seed is its own group" sanity check. Use one multi-row insert.
- **B's create-fill is empty by construction** (B's `src` is empty when B's MV is
  created). If a future change made B seed too, B would publish its own fill and
  the convergence deep-equal could mask divergence — assert B has **zero**
  B-origin mv changes before the relay as a precondition.
- **Quiescence still holds.** B ingesting the relayed src change re-derives the mv
  row, which is value-identical to the relayed (already-committed) mv row →
  suppressed. Reuse the existing `localMvEvents`/`changesFor(B, A.siteId)` zero
  assertions so this test also guards quiescence for the *cold-fill* delivery, not
  just incremental maintenance.
- **`transactionId` distinctness.** The seed `src` ChangeSet and the mv create-fill
  ChangeSet must have **different** `transactionId`s (different engine
  transactions). Assert this to pin that create-fill is not accidentally fused
  into the seed's commit group.
- **No production change expected.** If the grouped-publication assertion fails
  red out of the box, the regression is in `replaceContents`'s mid-transaction
  batching or `handleTransactionCommit`'s one-tick-per-commit — investigate and
  report in the review handoff rather than relaxing the test to match a broken
  grouping. Conversely, if mv changes arrive as N singleton ChangeSets, that is
  the exact regression this ticket exists to catch.
- **Settle timing.** Local-change capture is fire-and-forget post-commit; reuse
  the harness's `settle()` after the MV creation before reading A's log, exactly
  as `localWrite`/`relay` do.

## TODO

- [ ] Add `makeFilledPeer(name, seedRows)` (or refactor shared wiring into
      `makeBarePeer`) without altering `makePeer`'s existing sequence.
- [ ] New `describe` block: producer-side grouped-publication assertions on A
      (exactly one mv ChangeSet; N changes; shared transactionId + base HLC;
      seed is a distinct ChangeSet).
- [ ] Peer-side delivery + convergence: relay A→B, `res.applied > 0`, B.mv
      deep-equals A.mv and the seeded rows, fill delivered as one grouped
      transaction (ApplyResult `transactions` or the remote-event proof).
- [ ] Reuse the quiescence assertions for the cold-fill path (no local mv event
      on B's ingest; zero B-origin echo).
- [ ] Refresh-suppression assertion over the converged MV (zero new change-sets).
      Attempt non-empty refresh-grouping only if a clean stale-drift can be
      staged; otherwise file the backlog ticket and comment the deferral.
- [ ] `cd packages/quereus-sync && yarn test 2>&1 | tee /tmp/sync-test.log; tail -n 60 /tmp/sync-test.log`
      (stream, don't silently redirect). Confirm the new block and the existing
      5 echo-loop tests stay green.
- [ ] Type-check the spec call sites (`yarn lint` in `packages/quereus` covers
      its own test tsconfig; for quereus-sync run its build/type-check) so
      `ChangeSet`/`Change`/`ApplyResult` field access is sound — avoid `any`,
      narrow `Change` on `type === 'column'` before reading `.column`/`.value`.
