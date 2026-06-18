description: Add a real-database end-to-end test proving a relay peer that retired a table actually passes a straggler's write through to a holder peer, which then reads it back as a live row with a SQL query.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts          # real Database+StoreModule+adapter wiring + relay() helper to mirror
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts        # metadata-layer relay specs (the gap this closes)
  - packages/quereus-sync/src/sync/store-adapter.ts                        # createStoreAdapter — the real applyToStore
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                    # collectForwardableChanges + getChangesSince merge (769-1080)
  - docs/sync.md                                                           # § Store-and-forward relay (lines ~173-180)
difficulty: medium
----

# Real-engine end-to-end store-and-forward relay

## Why

The existing `store-and-forward-relay.spec.ts` proves the outbound relay at the
**CRDT-metadata layer**: a `SyncManagerImpl` over an in-memory KV, a recording
`applyToStore` stub, and a `known`-set basis oracle. The materialization claim —
"a relayed change with the straggler's original HLC lands as a live row on the
holder" — is asserted via the holder's `columnVersions`, **not** via
`select * from <table>`. This ticket closes the gap between "the CRDT metadata
records it" and "the row is really there in a real SQL table."

## Design

Add a new spec file `packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts`
that drives **real** `Database` + `StoreModule` + `createStoreAdapter` peers,
reusing the wiring pattern from `echo-loop-quiescence.spec.ts` (the
`createInMemoryProvider` / bare-peer / `relay()` / `collect()` helpers). Do not
share code across spec files — each spec in this suite is self-contained; copy the
minimal wiring it needs (the suite's established convention).

Three real peers, modelling the uneven-retirement window:

```
  S (straggler)          R (relay)              H (holder)
  ─────────────          ─────────              ──────────
  has `orders` table     NO `orders` table      has `orders` table
  (real, store-backed)   disposition =          (real, store-backed)
                         'store-and-forward'

  insert into orders ──relay(S→R)──► R diverts (out of basis) ──relay(R→H)──► H applies
   (logs under S's HLC)   → held forwardable        → forwarded change         → live row
                            (orig hlc+siteId)          re-offered via             materializes
                                                       getChangesSince            ↓
                                                                          select * from orders
                                                                          == S's written row
```

Key wiring facts (verified against the source — design is settled, no open
questions):

- **R retires the table by simply not having it.** A bare peer's basis oracle is
  `(s, t) => db.schemaManager.getTable(s, t)`, which returns `undefined` for
  `orders` on a peer that never created it → the inbound `orders` change is
  diverted in SyncManager **Phase 1, before `applyToStore`** (the store adapter
  never sees it). R's `SyncConfig.unknownTableDisposition` must be
  `'store-and-forward'` so the held entry is marked forwardable. R needs **no**
  tables at all — the oracle is the function, not a table set (cf. the "inert with
  no basis oracle" test, which only goes inert when the oracle function itself is
  `undefined`).
- **S and H create `orders` directly** (schema is NOT DDL-synced here — pin data
  echo, not DDL propagation), exactly as `echo-loop-quiescence.spec.ts` does. The
  `relay()` helper strips `schemaMigrations` from the relayed sets so R/H never
  receive a `create table` they'd reject as "already exists" / wrongly admit.
- **Relay from-zero (no `sinceHLC`).** Use the echo-loop `relay()` helper shape:
  `from.getChangesSince(to.siteId)` with no watermark. From-zero deliberately
  sidesteps the documented scalar-watermark limitation (a forwardable change with
  `HLC ≤ sinceHLC` is filtered) — `collectForwardableChanges` applies the
  watermark filter only when `sinceHLC` is defined, so from-zero relays every
  `origin ≠ peer` forwardable entry.
- **The forwarded change keeps S's original `hlc` + `siteId`** through R; H applies
  it via the real store adapter (`orders` is in H's basis) and materializes the row.

The headline assertion is the one the metadata suite cannot make:
`select id, <col> from orders` on **H** deep-equals the row **S** wrote, and the
materialized column carries **S's** origin HLC (`columnVersions` cross-check is a
fine secondary assertion, but the SQL query-back is the point).

Mirror `echo-loop-quiescence.spec.ts` for the fiddly real-engine details: the
`settle()` delay around fire-and-forget local-change capture, `closePeer` teardown,
and `updatePeerSyncState` after each relay.

## Edge cases & interactions

- **Diversion happens before the store adapter.** Assert R's store adapter (or the
  store-module data events) never materialized `orders` on R — the change is held
  in `R.manager.quarantine.listForwardable()` (exactly one entry), not applied.
  This is the load-bearing distinction from quarantine being bypassed.
- **R holds exactly one forwardable entry** after `relay(S→R)` (HLC-keyed; a
  re-relay of the same straggler change must not duplicate it). Re-run `relay(S→R)`
  and assert still one entry (idempotent re-dispose).
- **Origin identity preserved end to end.** The materialized row on H must carry
  S's `siteId` + HLC (not R's, not H's) — query both the SQL row and
  `H.manager.columnVersions.getColumnVersion(...)` and assert
  `siteIdEquals(cv.hlc.siteId, S.siteId)` and `compareHLC(cv.hlc, original) === 0`.
- **H becomes a second-order relay/server.** After H applies, `H.getChangesSince(neutral)`
  surfaces the `orders` change from H's OWN change log with S's origin intact — H
  would itself serve it onward (mirrors the metadata 3-peer test's final assertion).
- **No echo back to S.** `R.getChangesSince(S.siteId)` must NOT include `orders`
  (echo exclusion: the change's `hlc.siteId` is S). Assert both from-zero and a
  low-watermark delta pull exclude it.
- **Quiescence / no spurious local echo on H.** Subscribe to H's store events
  before the relay; the `orders` write must arrive `remote:true` with NO local
  (non-remote) re-derivation event for `orders`, and H logs no H-origin `orders`
  change (`changesFor(H, S.siteId)` carries the S-origin fact, not an H echo).
- **Delete path (secondary scenario, same wiring).** A straggler DELETE of an
  `orders` row should relay S→R→H and tombstone the row on H — `select` returns
  empty. Confirms the relay carries `RowDeletion`, not only `ColumnChange`.
- **Teardown / async settle.** Every local write and relay must `settle()` before
  reading a change log (fire-and-forget capture race) and `closePeer` all three
  peers in `afterEach` to avoid store handle leaks across specs.

## TODO

- Create `packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts`,
  copying the self-contained real-engine wiring from `echo-loop-quiescence.spec.ts`
  (`createInMemoryProvider`, bare-peer builder, `collect`, `settle`, `relay`,
  `changesFor`, `closePeer`). Trim to what this suite needs.
- Add a bare-peer factory parameterized by `unknownTableDisposition` and an
  optional `create table orders` step, so S/H get the real `orders` table and R
  does not (R = `'store-and-forward'`, no `orders`).
- Spec 1 — straggler INSERT relays through to the holder as a live row:
  S inserts into `orders`; `relay(S, R)`; assert R holds exactly one forwardable
  entry and materialized nothing; `relay(R, H)`; assert `select * from orders` on H
  == S's row, with S's origin HLC; H now serves it from its own log.
- Spec 2 — idempotent re-relay: a second `relay(S, R)` keeps exactly one
  forwardable entry on R (no duplicate); a second `relay(R, H)` is a value-identical
  no-op on H (no spurious H-origin echo).
- Spec 3 — echo exclusion: `R.getChangesSince(S.siteId)` excludes `orders` from-zero
  and at a low-watermark delta.
- Spec 4 — straggler DELETE relays through to a tombstone: after an INSERT relayed
  and materialized, a DELETE on S relays S→R→H and `select * from orders` on H is
  empty.
- Run `yarn workspace @quereus/quereus-sync test` (or the repo-root `yarn test`)
  and `yarn lint` (type-checks the spec call sites). Stream long output with
  `2>&1 | tee /tmp/sf-e2e.log; tail -n 80 /tmp/sf-e2e.log`.
- If `docs/sync.md` § Store-and-forward relay does not already note that
  materialization is now covered end-to-end by a real-engine test, add a one-line
  reference; otherwise leave docs unchanged.
