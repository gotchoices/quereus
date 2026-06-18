description: Add a test proving that refreshing a materialized view whose stored contents have drifted out of date republishes the corrected rows to peers as one batched change rather than many.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts          # add the stale-drift suite here; reuses makeBarePeer/relay/changesFor/settle/collect/closePeer
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # PROVEN stale-drift recipe to copy (where-only column + value-semantics ALTER → stale + plan detached, shape unchanged → fast path)
  - packages/quereus/src/runtime/emit/materialized-view.ts                # emitRefreshMaterializedView → _ensureTransaction (:78); refreshMaintainedTable → backingShapeMatches fast path (:146)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking fast path → host.replaceContents (:1458); content-stability stale gate (:1953)
  - packages/quereus-store/src/common/backing-host.ts                     # replaceContents replicating arm: diffs by key → op insert/update/delete (:280, :340)
difficulty: medium
----

## Goal

Cover the **second** `replaceContents` call site — `rebuildBacking`'s fast path
(`materialized-view-helpers.ts:1458`), reached by `refresh materialized view` when
`backingShapeMatches` (`materialized-view.ts:146`) — for the case where the
refresh diffs to **≥1 delta**, and assert that delta publishes to peers as **one
grouped change-set under a single HLC**, exactly like the create-fill path already
proven in `echo-loop-quiescence.spec.ts` (`describe('create-fill of a populated
source publishes one grouped change-set')`). This lands the non-empty
refresh-grouping half deferred from `sync-create-fill-grouped-changeset-integration-test`
(see the DEFERRED comment at `echo-loop-quiescence.spec.ts:593`).

## Design — RESOLVED: stage the drift through public SQL (no internal hook)

The plan ticket's open caveat was whether staging a genuine stale drift needs an
engine-internal hook. **It does not.** The drift is fully expressible in public
SQL using a **WHERE-only column** as the staleness lever — the exact recipe
`maintained-table-refresh-revalidation.spec.ts` already uses (`describe('stale
fast-path …')`, e.g. `:57`, `:62`, `:68`).

The mechanism, end to end:

```
  create table src (id integer primary key, v text, g text) using store;
  insert into src values (1,'a','keep'), (2,'b','keep'), (3,'c','keep');   -- all qualify (g <> 'skip')
  create materialized view mv using store as
    select id, v from src where g <> 'skip'                                 -- g read ONLY in WHERE; projects (id, v)
    with tags ("quereus.sync.replicate" = true);
  -- ^ create-fill publishes the 3 qualifying rows as ONE grouped mv ChangeSet (the existing create-fill proof).

  alter table src alter column g set collate nocase;   -- (A) value-semantics ALTER on a body-READ column
  -- ^ content-stability gate (materialized-view-helpers.ts:1953): the changed column g ∈ referencedSourceColumns,
  --   so tryRecompileMaterializedViewLive returns false → MV marked stale + row-time plan DETACHED.
  --   g is NOT projected, so the derived backing shape stays (id, v) → backingShapeMatches stays true.

  update src set v = 'A2' where id = 1;                -- (B) DRIFT: maintenance is detached → committed mv lags
  update src set v = 'B2' where id = 2;                --     (mv still holds id=1→'a', id=2→'b'); src change IS logged.

  refresh materialized view mv;                        -- (C) fast path: rebuildBacking recomputes the body →
  -- ^ replaceContents (backing-host.ts:286) diffs by key → op:'update' for id=1,id=2 → 2 genuine deltas,
  --   batched under db._ensureTransaction() (materialized-view.ts:78) → ONE grouped change-set / one HLC.
```

Why each property holds (verified against the code, not assumed):

- **Stale + plan detached, shape preserved.** `set collate` (or `set data type`)
  on `g` is a value-semantics change; because the body reads `g` in its WHERE
  predicate, the content-stability gate (`materialized-view-helpers.ts:1953-1969`,
  `valueSemanticsChangedColumns ∩ referencedSourceColumns ≠ ∅`) routes to
  mark-stale + `releaseRowTime` rather than recompile-live. `g` is not in the
  projection, so `deriveBackingShape` still yields `(id, v)` →
  `backingShapeMatches` (`materialized-view.ts:146`) is true → **fast path**
  `rebuildBacking` → `host.replaceContents` (the targeted seam), NOT the reshape
  arm.
- **Non-empty grouped delta.** While stale the `update`s don't propagate (plan
  detached), so the committed mv backing lags the body. `refresh` recomputes; the
  replicating `replaceContents` diffs the recomputed rows against the committed
  before-image and queues `op:'update'` per drifted key (`backing-host.ts:284-287`).
  Running under `db._ensureTransaction()`, the store emitter batches and flushes
  these as one grouped change-set at the engine commit — the same seam the
  create-fill proof pins.
- **Update vs insert delta granularity.** A same-key value change is `op:'update'`
  (carries `oldRow`, `backing-host.ts:286`), so `recordColumnVersions` records only
  the **changed non-PK column** (`v`) per drifted row — NOT every column. So the
  drift produces `DRIFTED_ROWS × CHANGED_NONPK_COLUMNS` ColumnChanges (2 rows × 1
  changed column = 2), distinct from the create-fill set's `N × COLUMNS_PER_FRESH_INSERT`
  (which records the PK too, because a fresh insert has no old row).

This keeps the whole test in the existing synced-MV harness with zero engine
changes and zero internal reach-through. The unit suite
(`packages/quereus-store/test/backing-host.spec.ts`) already covers refresh-path
delta *correctness*; this test covers the residual engine-transaction *grouping*
of a non-empty refresh.

## Peer-side convergence (why it stays quiescent like the row-time path)

B is built over an **empty** filtered `src` (so its own create-fill is empty) and
its MV stays **live** (B never receives the `alter` — `relay` strips
`schemaMigrations`, pinning data echo not DDL). A→B relays the src drift rows + the
mv refresh delta. The store adapter applies all batched table rows to committed
storage BEFORE its single end-of-invocation seam call, so by the time B's seam
re-derives the mv from the ingested src updates, A's relayed mv rows are already
committed → value-identical → `mv-noop-upsert-suppression` fires → no local mv
event, no B-origin echo. Identical to the create-fill / row-time quiescence proofs;
reuse `relay` / `changesFor` / the `localMvEvents` filter verbatim.

**Collation-qualification trap (must avoid):** B's `g` stays BINARY (no alter
relayed) while A's becomes NOCASE. Choose `g` values whose `g <> 'skip'` truth is
identical under BINARY and NOCASE (e.g. `'keep'`), so the same rows qualify on both
peers and the mv content cannot diverge for a collation reason. Never use a `g`
value that differs from `'skip'` only by case.

## What to build

Add a new `describe` block to `echo-loop-quiescence.spec.ts` (the schema needs a
third `g` column, so it does not share `makeFilledPeer`/`makePeer`; it DOES share
`makeBarePeer` — which stops before any `create table` — plus `relay`,
`changesFor`, `settle`, `collect`, `closePeer`). Add two fixture builders layered
on `makeBarePeer`:

- a filtered-filled producer: `create table src (id, v, g)` → seed all-qualifying
  rows in ONE multi-row insert → `create materialized view mv … select id, v from
  src where g <> 'skip' with tags(replicate=true)`;
- a filtered-empty peer: same schema, MV created over empty `src`.

Then the stale-drift flow (A only) and the assertions below.

### Producer-side assertions (A)

- Capture A's mv ChangeSets **before** the refresh: exactly 1 (the create-fill,
  `N × COLUMNS_PER_FRESH_INSERT` changes) — the precondition guard.
- Run `alter … set collate nocase` on `g`; then the drift `update`s; then `refresh
  materialized view mv`; `settle()`.
- A's mv ChangeSets **after**: exactly 2. The NEW set (the one whose
  `transactionId` was not present before) is the refresh delta. THE GROUPING CRUX:
  it is exactly **one** ChangeSet (N ungrouped singletons — the regression this
  guards — would be N sets).
- Non-empty guard: the refresh set's mv changes `> 0` (a vacuous-green trap if the
  drift silently propagated or the alter failed to stale).
- Granularity: refresh-set mv change count `=== DRIFTED_ROWS × CHANGED_NONPK_COLUMNS`
  (pin as a named const, NOT a flat number — mirror `COLUMNS_PER_FRESH_INSERT`).
  Each change is `type:'column'`, `column === 'v'` (the only drifted non-PK column).
- One transaction / one base HLC: every refresh-set change shares the set's
  `transactionId` (`deterministicTxnId(c.hlc) === mvSet.transactionId`) and base HLC
  (`wallTime`/`counter`/`siteId` equal; only `opSeq` differs) — the explicit
  single-HLC claim, exactly as the create-fill test asserts.
- Distinctness: the refresh set's `transactionId` differs from BOTH the create-fill
  set's and the src-drift set's (the refresh is its own commit group, not fused).

### Peer-side assertions (B)

- Precondition: B holds zero B-origin mv changes before the relay (its create-fill
  is empty).
- `relay(A, B)` → `res.applied > 0`.
- Convergence: `select id, v from mv order by id` on B deep-equals the drifted rows
  AND deep-equals A's mv; likewise `src`.
- Grouped/quiescent delivery (reuse the create-fill remote-event proof): B saw the
  relayed mv rows `remote:true`, fired **no** local (`!remote`) mv event, and
  `changesFor(B, A.siteId)` is length 0.

## Edge cases & interactions

- **Vacuous-green guards.** Assert the drift actually drifted (committed mv lags the
  body before refresh) and the refresh set is non-empty. A silent failure of the
  stale trigger (e.g. if the recompile-live gate ever changed) would otherwise make
  the test pass green while testing nothing.
- **Fast path, not reshape.** The test only covers the `replaceContents` fast-path
  seam if `backingShapeMatches` stays true. `g` MUST be WHERE-only (not projected);
  if a future edit projects `g`, the alter would reshape and the test would silently
  drift to the reshape arm. Add an assertion or comment pinning that the MV's column
  set is `(id, v)` after refresh, so a projection regression is caught.
- **Seed must fully qualify.** All seeded rows satisfy `g <> 'skip'` so create-fill
  equals the full seed and the convergence deep-equal is meaningful.
- **Collation qualification parity** (see trap above): drift/seed `g` values must
  qualify identically under BINARY (B) and NOCASE (A).
- **Separate transactions don't fuse.** The `alter`, the drift `update`s, and the
  `refresh` are separate `exec` calls → separate engine transactions. The src-drift
  `update` logs its own src ChangeSet; filter to mv changes for the grouping
  assertion and assert the refresh mv set's `transactionId` differs from the
  src-drift set's.
- **Fire-and-forget capture.** `settle()` after the refresh (and after each local
  write) before reading A's log, per the harness's transaction-boundary capture
  note; `relay` already brackets its reads with `settle()`.
- **DDL is not relayed.** B converges on data alone; do not attempt to relay the
  `alter` (it would error "already exists"/schema mismatch and is intentionally
  stripped by `relay`).
- **Row-time eligibility.** A filtered 1:1 projection (`select id, v from src where
  g <> 'skip'`) is row-time maintainable and replicate-taggable — confirmed by the
  `maintained as select id, v from src where g <> 'skip'` tables in the
  refresh-revalidation suite. If `create materialized view … with tags(replicate=true)`
  unexpectedly rejects the filtered body, that is a real eligibility bug, not a test
  defect — flag it (do not work around by dropping the filter, which removes the
  staleness lever).

## Verification

- `yarn workspace @quereus/quereus-sync test` (run the new suite; stream with
  `2>&1 | tee /tmp/sync-test.log; tail -n 80 /tmp/sync-test.log`).
- `yarn workspace @quereus/quereus lint` is unaffected (no quereus src change), but
  run the sync package's typecheck/lint if it has one to catch spec call-site drift.
- Remove the DEFERRED comment block at `echo-loop-quiescence.spec.ts:593-600` now
  that the deferred half is covered, leaving the refresh-suppression test's own body
  intact.

## TODO

- Add the two filtered-schema fixture builders (filled producer + empty peer) on
  `makeBarePeer` in `echo-loop-quiescence.spec.ts`.
- Add the new `describe` block with the producer-side grouping assertions (before/
  after mv ChangeSets, one set, one HLC, granularity, distinctness, non-empty).
- Add the peer-side relay → convergence → quiescence assertions (reuse `relay` /
  `changesFor` / `localMvEvents`).
- Add the fast-path / shape-pin guard (MV columns stay `(id, v)` after refresh).
- Remove the now-obsolete DEFERRED comment (`:593-600`).
- Run the sync package tests (streamed) and confirm green.
