description: Review the two-peer echo-loop quiescence integration test for the `quereus.sync.replicate` change-log opt-in. A replicated derived row must close its own echo loop: when peer B ingests peer A's source change AND A's logged derived MV row, B's own re-derivation is value-identical → suppressed → no event → no B-origin change-log entry (no ping-pong). The bodyless pending stub in `quereus-store/test/backing-host.spec.ts` was deleted.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts        # NEW — the test (4 cases)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts          # the harness this copied from (createInMemoryProvider, real-db peer)
  - packages/quereus-sync/src/sync/store-adapter.ts                     # createStoreAdapter: per-table storage writes BEFORE the single ingestExternalRowChanges seam call (the ordering this guards)
  - packages/quereus-sync/src/sync/change-applicator.ts                 # commitChangeMetadata records applied changes under the ORIGIN's HLC (why getChangesSince(A.siteId) excludes relayed A-origin)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                 # handleDataChange (skips event.remote), getChangesSince exclusion, handleSchemaChange records local DDL as migrations
  - packages/quereus-store/test/backing-host.spec.ts                    # stub + its design comment DELETED (file now ends at the EMIT_FLAVORS loop)
  - docs/migration.md                                                   # § Synced vs. local derived tables (the spec this pins)
difficulty: medium
----

# Two-peer echo-loop quiescence integration test — IMPLEMENT handoff

## What shipped

A new mocha spec, `packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts`,
wiring two real `Database` + `StoreModule` + `createStoreAdapter` + `SyncManagerImpl`
peers together and proving the load-bearing `quereus.sync.replicate` invariant
**end-to-end across peers**: a replicated derivation write closes its own echo
loop and does not ping-pong. The bodyless pending stub
(`it('echo-loop quiescence across two synced peers …')`) and its design comment
were deleted from `quereus-store/test/backing-host.spec.ts`.

The harness (`makePeer`, `relay`, `changesFor`) was copied from
`store-adapter-seam.spec.ts` per the ticket. Each peer gets identical DDL created
directly (not schema-synced): a synced `src` base table and a **tagged 1:1
projection MV** (`create materialized view mv using store as select id, v from src
with tags ("quereus.sync.replicate" = true)`) — a clean keyed passthrough, no key
coarsening.

### The four test cases (all green, 51ms)

1. **A→B: a replicated derivation converges on B and closes its own echo loop.**
   - Drives `insert into src values (1,'x')` on A. Sanity-asserts A logged BOTH a
     `src` and an `mv` change (the source DML auto-emits; the tagged MV
     maintenance emits the derived row).
   - Relays A→B (`res.applied > 0`).
   - **Convergence:** B's `src` and `mv` deep-equal `[{id:1,v:'x'}]`, and B's `mv`
     deep-equals A's `mv`.
   - **Quiescence (headline):** `B.getChangesSince(A.siteId)` flattens to length 0
     — B recorded zero B-origin entries. Passing A's siteId excludes the relayed
     A-origin changes (they are stored under the origin's HLC by
     `commitChangeMetadata`), so what remains would be B's own echo; there is none
     because the re-derivation suppressed.
   - **Stronger form:** subscribes `B.events.onDataChange` BEFORE the relay and
     asserts NO non-`remote` `mv` event fired during ingest (direct proof
     suppression fired; the only `mv` event is the relayed row applied
     `remote:true`).
2. **B→A round-trip:** B has no B-origin changes, so the reverse relay carries an
   empty data set; `applyChanges` tolerates it (`res.applied === 0`, no throw) and
   A gains no spurious change (A's full change-log count is unchanged) and A's `mv`
   is untouched.
3. **Follow-up UPDATE steady state:** `update src set v='y'` on A, relay, re-assert
   convergence (`v='y'`) + quiescence (no B-origin echo, no local `mv` event).
4. **Tombstone path** (the ticket's optional extension — included): `delete from
   src` on A derives an MV tombstone; relay; both `src` and `mv` empty on B and
   B stays quiescent (B's re-derivation resolves to an already-absent row →
   value-identical → suppressed).

## Two deliberate deviations from the ticket sketch (review these)

1. **`relay` strips schema migrations.** The ticket's sketch relayed
   `getChangesSince(...)` verbatim, but each peer's local `create table` /
   `create materialized view` is recorded by `handleSchemaChange` as a schema
   migration, and `getChangesSince` attaches those to the relayed change sets.
   Relaying a peer's DDL to the other (which already holds the table) throws
   `Table main.src already exists`. The ticket explicitly wants schema "created
   directly on each peer, **not** schema-synced … focused on data echo, not DDL
   propagation," so `relay` maps `schemaMigrations: []` onto each change set —
   modelling two peers that already agree on schema. **Without this strip, the
   A→B case passes only by HLC accident** (A is created before B, so A's older-HLC
   DDL migrations lose the version-1 dedup and are skipped); the B→A case fails
   outright. Stripping makes both robust. (Confirm you agree this is faithful to
   "not schema-synced," or that DDL-propagation belongs in a separate test.)
2. **Round-trip assertion differs from the ticket's literal text.** The ticket's
   assertion 5 said `A.getChangesSince(B.siteId)` "flattens to length 0" after the
   round-trip. That is **incorrect as written**: `getChangesSince(B.siteId)`
   excludes B-origin changes, NOT A's own legitimate `src`+`mv` entries, so it is
   non-zero by construction and cannot detect a spurious change. Implemented the
   faithful invariant instead — A's full change-log count (neutral-siteId
   exclusion) is identical before/after the empty relay. A code comment records
   the reasoning. (The headline B-side assertion 4, `B.getChangesSince(A.siteId)`,
   IS correct and is used unchanged.)

## What to scrutinize (adversarial targets — treat reds as real findings)

- **The ordering guarantee is the whole point.** The test passes *because*
  `createStoreAdapter` writes every batched table's rows to committed storage
  (incl. the relayed `mv` row) BEFORE the single end-of-invocation
  `ingestExternalRowChanges` seam call. If a future change reorders the seam call
  before the per-table storage writes, B's re-derivation would read an MV backing
  that does NOT yet have A's row → the maintenance upsert would NOT be
  value-identical → it would emit → B would log a B-origin echo → tests 1/3/4 go
  red on the quiescence assertion. That red is the regression this guards, not a
  test bug. (`store-adapter.ts` step 1+2 vs step 5.)
- **First ingest of a relayed MV-backing row.** This is the first test where a
  relayed MV-backing row is itself resolved + applied through the external-write
  path (`getTableForExternalWrite` → `resolveOwnedTable` on a store-hosted MV).
  The seam suite only relayed the source and let the seam re-derive. A failure in
  MV resolution/application would surface here — a real finding, not a test bug.
- **Determinism / byte-identity.** If B's re-derived MV bytes ever diverged from
  A's relayed bytes (encoding drift), suppression would NOT fire and the test goes
  red with a spurious B-origin `mv` entry — the determinism contract failing
  loudly, as intended.
- **`!e.remote` filter.** The stronger quiescence assertion treats both
  `remote:undefined` and `remote:false` as "local." The adapter emits effective
  changes with `remote:true`; only a genuine local derivation has it falsy. Double
  check this is the right predicate if review wants to tighten it.

## Known gaps / what this does NOT cover (the floor, be honest)

- **Single registration flavor only** — bare `StoreModule` (as the seam suite
  uses). The ticket said the echo invariant is module-agnostic and NOT to expand
  to `IsolationModule(StoreModule)` unless trivial; the store-host unit suite runs
  both flavors. Noted in the spec header comment.
- **Column projection is trivial (1:1)** — the echo suppression is under test, not
  column projection or key coarsening. Convergence-hazard / key-coarsening
  (docs/migration.md § Convergence hazards) is a different invariant, deliberately
  not entangled.
- **Full sync only** — `relay` uses `getChangesSince(to.siteId)` with no
  `sinceHLC` watermark (full sync). `updatePeerSyncState` is called for fidelity
  with the design but the watermark is not exercised by a delta relay. A
  delta-sync variant is not covered.
- **Create-fill / full-rebuild publication is out of scope** — the MV's initial
  fill at create emits nothing (known gap `sync-derivation-fill-publication`); the
  test deliberately drives INCREMENTAL writes (insert/update/delete on an already-
  created, converged pair), never a create-fill.
- **No multi-peer (≥3) topology, no concurrent/conflicting writes** — strictly the
  two-peer one-directional echo loop. LWW conflict behavior is covered by other
  sync specs.

## Validation run

- `node --import ./packages/quereus-sync/register.mjs … echo-loop-quiescence.spec.ts`
  — **4 passing**.
- `yarn workspace @quereus/sync test` — **194 passing**, 0 failing (the
  `[Sync] Error handling…` console lines are deliberate error-injection tests in
  `sync-manager.spec.ts`, not failures).
- `packages/quereus-store/test/backing-host.spec.ts` — **54 passing** (stub
  deletion compiles; the single-host suppression test stays in place).
- `tsc -p packages/quereus-sync/tsconfig.test.json --noEmit` — exit 0 (test
  type-check clean).
- No `quereus/` source touched; no lint needed there.
