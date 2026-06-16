description: Build the real two-peer echo-loop quiescence integration test for the `quereus.sync.replicate` change-log opt-in, and delete the bodyless pending stub in `quereus-store/test/backing-host.spec.ts`. A replicated derived row must close its own echo loop: when peer B ingests peer A's source change AND A's logged derived MV row, B's own re-derivation of the source change is value-identical → suppressed → no `BackingRowChange` → no `DataChangeEvent` → no B-origin change-log entry (no ping-pong).
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts        # NEW — the test (create here; quereus-sync owns the ingest/HLC machinery)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts          # COPY THIS HARNESS — real Database+StoreModule+createStoreAdapter+SyncManagerImpl peer
  - packages/quereus-sync/src/sync/store-adapter.ts                     # createStoreAdapter: all storage writes BEFORE one ingestExternalRowChanges seam call (load-bearing)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                 # SyncManagerImpl.create, handleDataChange (skips event.remote → only local writes log)
  - packages/quereus-store/test/backing-host.spec.ts                    # DELETE the bodyless `it('echo-loop quiescence across two synced peers …')` stub (last line) + its design comment
  - packages/quereus-store/src/common/backing-host.ts                   # the value-identical suppression seam under test
  - docs/migration.md                                                   # § Synced vs. local derived tables (the spec this pins)
difficulty: medium
----

# Two-peer echo-loop quiescence integration test

## What this proves

The load-bearing invariant of `quereus.sync.replicate`: a replicated derivation
write closes its own echo loop and does **not** ping-pong between synced peers.

```
Peer A                                  Peer B
──────                                  ──────
insert into src (local DML)
  ├─ src DML       → DataChangeEvent ─┐  (ordinary store DML auto-emits;
  │                                   │   handleDataChange records it LOCAL)
  └─ mv maintenance (tag on)          │
        → derived DataChangeEvent ────┤  A.changeLog = { src change, mv derived change }
                                      │
        ── A.getChangesSince(B) ──────┼──► B.applyChanges(...) via createStoreAdapter:
                                      │     1. applyExternalRowChanges(src row)  → committed storage
                                      │     2. applyExternalRowChanges(mv  row)  → committed storage  (A's derived row)
                                      │        (both emit module events remote:true → NOT re-logged)
                                      │     3. ONE db.ingestExternalRowChanges(batch):
                                      │          src change → MV maintenance re-derives mv row
                                      │          → reads mv's COMMITTED state (already has A's row)
                                      │          → value-identical → SUPPRESSED → no BackingRowChange
                                      │          → no DataChangeEvent → handleDataChange records NOTHING
                                      ▼
                              B.changeLog has ZERO B-origin entries  ← quiescence
                              B's `select * from mv` == A's          ← convergence
```

Quiescence holds **by construction** of the store adapter: it applies *every*
batched table's rows to committed storage (step 1 + 2) **before** the single
end-of-invocation `ingestExternalRowChanges` seam call (step 3). So by the time
B's seam re-derives the MV from the ingested source change, A's relayed MV row is
already committed in B's MV backing → the maintenance upsert is value-identical →
`mv-noop-upsert-suppression` fires → no event → no echo. If a future change
reordered the seam call before the per-table storage writes, this test would go
red — that is the regression it guards.

## Why it was deferred (and why it is now decision-free)

The single-host echo seam (value-identical upsert → no change → no event) is
already pinned in `backing-host.spec.ts`
(`it('suppresses a value-identical upsert (the echo seam): no change, no event')`).
What was missing is the cross-peer end-to-end assertion, which needs a
store + `@quereus/sync` two-peer harness. That harness now exists in
`store-adapter-seam.spec.ts` (real `Database` + `StoreModule` +
`createStoreAdapter` + `SyncManagerImpl`); this ticket wires two of them
together. No design decision remains — see the resolved facts below.

## Resolved design facts (do not re-litigate)

- **Source table needs no tag.** Ordinary engine DML on a `using store` table
  emits `DataChangeEvent`s through the `StoreEventEmitter` unconditionally
  (confirmed: `external-row-write.spec.ts` — "engine DML on the same module
  DOES emit"). `SyncManagerImpl.handleDataChange` records every non-remote event
  as a local change. So A's `insert into src` logs and relays without any tag.
- **The MV needs the tag.** `quereus.sync.replicate = true` gates only the
  privileged backing-host *maintenance* writes. Tag the MV so A's derived
  maintenance write emits a `DataChangeEvent` (→ A logs the derived row).
- **Drive an INCREMENTAL write, not create-fill.** Create-fill / full-rebuild
  publication is a known gap (`docs/migration.md` § Current gaps — tracked as
  `sync-derivation-fill-publication`): the MV's *initial* fill at create emits
  nothing. So create `src` + `mv` on both peers FIRST (both empty / converged),
  THEN `insert into src` on A — the derivation under test must be a row-time
  maintenance write, which does emit.
- **Remote-applied changes are never re-logged.** `handleDataChange` returns
  early on `event.remote` (sync-manager-impl.ts:183), and `createStoreAdapter`
  emits every effective change with `remote: true`. So B's change log gets a
  *local* MV entry only via a non-remote maintenance event — i.e. the echo. An
  empty B change log == quiescence.
- **Schema created directly on each peer**, not schema-synced — keep the test
  focused on data echo, not DDL propagation (covered elsewhere). Identical DDL
  on both peers via `db.exec`.
- **Both peers must run the SAME pure derivation** so B's re-derived bytes are
  byte-identical to A's relayed row (the determinism contract). Use a trivial
  projection MV (`select <all cols> from src`) for v1 — the echo suppression,
  not column projection, is under test.

## Harness shape (copy from store-adapter-seam.spec.ts)

Build a `makePeer(name)` factory returning `{ db, storeModule, events, manager, provider }`:

```ts
// per peer:
const { provider } = createInMemoryProvider();      // copy helper from store-adapter-seam.spec.ts
const events = new StoreEventEmitter();
const db = new Database();
const storeModule = new StoreModule(provider, events);
db.registerModule('store', storeModule);
const applyToStore = createStoreAdapter({ db, storeModule, events });
const manager = await SyncManagerImpl.create(
  new InMemoryKVStore(), events, { ...DEFAULT_SYNC_CONFIG },
  new SyncEventEmitterImpl(), applyToStore,
  (schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
);
// identical schema on each peer:
await db.exec('create table src (id integer primary key, v text) using store');
await db.exec('create materialized view mv using store as select id, v from src '
            + 'with tags ("quereus.sync.replicate" = true)');
```

A one-directional relay helper (real-db analogue of `performBidirectionalSync`):

```ts
async function relay(from: Peer, to: Peer) {
  const changes = await from.manager.getChangesSince(to.manager.getSiteId());
  const res = await to.manager.applyChanges(changes);
  await to.manager.updatePeerSyncState(from.manager.getSiteId(), from.manager.getCurrentHLC());
  return res;
}
```

## The assertions

**Primary (A → B):**
1. `await A.db.exec("insert into src values (1, 'x')")` — A derives + logs.
   - Sanity: `A.manager.getChangesSince(generateSiteId())` carries BOTH a `src`
     change and an `mv` change (A logged the derivation).
2. `await relay(A, B)` — `res.applied > 0`.
3. **Convergence:** `select id, v from mv` on B deep-equals on A (e.g.
   `[{ id: 1, v: 'x' }]`), and `select id, v from src` converged too.
4. **Quiescence (the headline):** B logged NO B-origin derived entry. Assert
   `(await B.manager.getChangesSince(A.manager.getSiteId())).flatMap(cs => cs.changes)`
   has length 0. (B's change log holds only local entries — none exist — because
   the re-derivation suppressed; A-origin relayed changes are excluded by passing
   A's siteId, mirroring `store-adapter-seam.spec.ts` "no CRDT echo".)
   - Stronger optional form: subscribe `B.events.onDataChange` BEFORE the relay
     and assert no non-`remote` event for table `mv` ever fires during ingest.

**Round-trip (B → A) — recommended, asserts bidirectional quiescence:**
5. `await relay(B, A)` — since B logged nothing B-origin, `res.applied === 0` and
   A gains no spurious local change: `A.manager.getChangesSince(B.manager.getSiteId())`
   (after the round-trip) flattens to length 0, and A's `mv` is unchanged.

**Second source write (optional, hardens the steady state):** repeat an UPDATE on
A's `src` (e.g. `update src set v='y' where id=1`), relay A→B, and re-assert
convergence + quiescence — proves the loop stays quiet across updates, not just
the first insert.

## Edge cases & interactions

- **MV-backing resolution via the external-write path.** `createStoreAdapter`
  resolves EVERY batched table (including `mv`) via
  `StoreModule.getTableForExternalWrite` → `resolveOwnedTable`. A store-hosted MV
  is a registered, module-owned `StoreTable`, so it resolves; `applyExternalRowChanges`
  maintains its (zero) indexes + stats + data key. This is the FIRST test where a
  relayed MV-backing row is itself ingested (the seam suite only relayed the
  source and let the seam re-derive). If resolution or application of a relayed MV
  row misbehaves, this test surfaces it — treat a failure here as a real finding
  (fix ticket), not a test bug.
- **Seam re-derivation reads committed state.** The adapter's `applyExternalRowChanges`
  writes committed storage immediately (no coordinator txn); the seam's MV
  maintenance opens a coordinator txn and reads effective (committed+pending)
  state. Confirm the relayed MV row is committed before the seam runs (it is —
  storage writes precede the single seam call). A red here means the ordering
  guarantee broke.
- **Empty / no-op relay.** The B→A round-trip relays an empty change set — assert
  `applyChanges` tolerates it (`applied === 0`, no throw), not an error path.
- **Both registration flavors?** The store-host unit suite runs against both
  `IsolationModule(StoreModule)` and bare `StoreModule`. For this integration
  test, the bare `StoreModule` peer (as the seam suite uses) is sufficient — the
  echo invariant is module-agnostic. Do NOT expand to both flavors unless trivial;
  note the single-flavor choice in a comment.
- **Determinism / byte-identity.** If B's re-derived MV bytes ever differ from
  A's relayed bytes (encoding drift), suppression would NOT fire and the test
  goes red with a spurious B-origin `mv` entry — that is the determinism contract
  failing loudly, exactly as intended.
- **Convergence-hazard out of scope.** Key-coarsening / collision oscillation
  (`docs/migration.md` § Convergence hazards) is a DIFFERENT invariant — keep the
  derivation a clean 1:1 projection so no coarsening occurs. Do not entangle.
- **Tombstone path (optional extension).** A DELETE on A's `src` derives an MV
  delete; relaying + ingesting it should likewise be quiescent on B. Include only
  if it stays within one agent run; otherwise leave a `// follow-up:` note rather
  than a stub.

## Removing the stub

After the new test lands and passes, DELETE from
`packages/quereus-store/test/backing-host.spec.ts`:
- the trailing bodyless pending test
  `it('echo-loop quiescence across two synced peers (integration; tracked follow-up)');`
- its preceding design-comment block (the `/** Echo-loop quiescence — … */`)
that points here. Leave the single-host suppression test
(`it('suppresses a value-identical upsert (the echo seam) …')`) in place — it
still pins the single-host seam.

## Validation

- `yarn workspace @quereus/sync test` (or the repo-root `yarn test`) — the new
  spec is mocha (quereus-sync uses mocha for its `test/sync/*.spec.ts`). Stream
  output: `yarn test 2>&1 | tee /tmp/echo.log; tail -n 80 /tmp/echo.log`.
- `yarn workspace @quereus/quereus run` lint is N/A here (no quereus/ source
  touched); ensure the quereus-store stub deletion still compiles its spec.
- Keep the run well inside the idle-timeout window; this is a small focused spec.

## TODO

- Create `packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts`; copy the
  `createInMemoryProvider` helper and the real-db peer wiring from
  `store-adapter-seam.spec.ts`.
- Implement `makePeer(name)` (db + StoreModule + events + createStoreAdapter +
  SyncManagerImpl, identical `src` + tagged `mv` DDL) and the `relay(from, to)`
  helper.
- Write the primary A→B test: drive an incremental `insert into src` on A; assert
  A logged src+mv; relay; assert convergence (B.mv == A.mv) and quiescence
  (`B.getChangesSince(A.siteId)` flattens to 0 changes).
- Add the optional `onDataChange`-based stronger quiescence assertion (no
  non-remote `mv` event during B's ingest).
- Add the B→A round-trip test (empty relay; `applied === 0`; A gains no local
  change).
- Add the second-write (UPDATE) steady-state case.
- Delete the bodyless pending stub + its comment from
  `packages/quereus-store/test/backing-host.spec.ts`.
- Run the sync + store suites; confirm green; stream logs.
