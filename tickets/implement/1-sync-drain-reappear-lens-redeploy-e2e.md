description: Add a real-database end-to-end test proving that re-deploying a schema which brings a retired table back into use replays the held edits as live, queryable rows — matching the coverage the inbound-create-table revival path already has.
prereq:
files:
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts                 # existing real-store revival e2e (inbound create_table) — add a redeploy describe block here
  - packages/quereus-sync/test/sync/_peer-harness.ts                       # real-engine peer harness — add lens-deploy wiring + retire/revive helpers
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                    # recordLensDeployment → detached → present reappear drain (lines ~505-535) — the trigger under test
  - packages/quereus-sync/test/sync/basis-lifecycle-recorder.spec.ts       # in-memory/stub coverage of the same trigger — mirror its scenario at real-engine fidelity
difficulty: medium
----

# Real-engine e2e for the lens-redeploy revival path

## Why

Two reappearance paths fire a low-latency scoped drain of held out-of-basis changes:

1. an inbound `create_table` (covered e2e by `sync-drain-e2e.spec.ts`), and
2. a local `apply schema` lens redeploy that re-maps a basis table from `detached` back into
   the basis (`recordLensDeployment`, the `wasDetached && !isDetached` gate at
   `sync-manager-impl.ts:513`).

Path 2 is currently covered only at the CRDT-metadata + in-memory-stub level
(`basis-lifecycle-recorder.spec.ts` → describe `recordLensDeployment — low-latency drain on
detached → re-mapped`). There the materialization claim is asserted against a `Map`-backed
`applyToStore` stub and a hand-mutated `oracleColumns` map — it cannot fire the derived effects
of the real ingestion seam (`db.ingestExternalRowChanges` → `Database.watch` capture +
materialized-view maintenance) that only a real `Database` + `StoreModule` + `createStoreAdapter`
exercises. This ticket closes that gap, matching the parity bar the inbound path already set.

## How the trigger reaches a real engine

`recordLensDeployment` is NOT called directly in production — it is wired through the engine's
module hook. The full faithful chain, all awaited, is:

```
db.exec('apply schema app')                  // logical (lens) apply only — a physical apply never fires this
  → engine notifyLensDeploymentAll(db,'app')  // schema-declarative.ts:176, logical branch only
    → StoreModule.notifyLensDeployment(...)   // store-module.ts:324, forwards to the bound listener (advisory: swallows throws)
      → manager.recordLensDeployment(db,'app',snapshot)
        → classify basis tables (reads db.schemaManager.getSchema(basis).getAllTables() — LIVE physical state)
        → detached → present transition for `main.orders`  ⇒ reappeared.push(...)
        → await drainReappearedTables(...)    // separate post-commit apply unit, after the lifecycle batch is durable
          → drainHeldChanges('main','orders') // basis gate = getTableSchema oracle (db.schemaManager.getTable)
            → applyToStore (createStoreAdapter) → db.ingestExternalRowChanges → row materializes; watch/MV fire
```

So `db.exec('apply schema app')` does not resolve until the reactive drain has completed — the
redeploy is the firing transaction, with **no explicit `drainHeldChanges` call** (mirroring the
inbound path's "reactive drain mid-applyChanges" case).

### The basis-classification recipe (resolved)

- The basis is inferred, not declared: `inferDefaultBasis` (`lens-compiler.ts:617`) picks **the
  single physical schema that has ≥1 table**, excluding the logical schema and `temp`. In a fresh
  `Database`, once `main.orders` exists, `main` is that sole candidate — so a plain
  `declare logical schema app { table orders {...} }` name-matches `app.orders` → `main.orders`,
  with `basisSchemaName === 'main'`. This keeps the schema name `main` throughout, so the existing
  harness helpers (`relay`, `quarantine.list('main','orders')`, `collect(db,'select … from orders')`)
  work unchanged — `select … from orders` resolves to the physical `main.orders`, not the lens view
  `app.orders`.
- A store-backed basis table is created imperatively with `create table orders (…) using store`
  (exactly as the existing harness does) — the lens deploy creates no physical tables. No
  `setDefaultVtabName` is needed.

### The retire → revive sequence on the holder H (ordering is load-bearing)

| step | action on H | resulting `main.orders` lifecycle state |
|------|-------------|------------------------------------------|
| 1 | `create table orders (…) using store`; `declare logical schema app { table orders {…} }`; `apply schema app` | `directly-mapped` (record created, `prior` now exists) |
| 2 | `drop table orders` **then** `declare logical schema app { }`; `apply schema app` | `detached` (out of basis **and** unmapped) |
| 3 | relay S→H (orders absent) | held; record stays `detached` |
| 4 | `create table orders (…) using store`; `declare logical schema app { table orders {…} }`; `apply schema app` | `detached → directly-mapped` ⇒ **reactive drain fires** |

**Critical ordering at step 2:** the physical `drop table orders` MUST precede the empty-lens
redeploy. If you redeploy the empty lens while `main.orders` is still physically present, the
record classifies as `unreferenced` (in basis, unmapped) — NOT `detached` — and the step-4 redeploy
then transitions `unreferenced → directly-mapped`, which is **not** `detached → present`, so the
reactive drain never fires and the test silently proves nothing. Assert the `detached` state after
step 2 (via `manager.getBasisTableLifecycle()`) to guard this.

Notes on step 2: the empty `declare logical schema app { }` deploy compiles no tables, so
`resolveBasis`/`inferDefaultBasis` is never consulted (it is lazy, per-table) — `main` being empty
after the drop does not throw; `basisSchemaName` falls back to the prior snapshot's `main`. The old
`app.orders` lens view dangles over the dropped basis table in the window between the drop and the
redeploy, but nothing queries it and the empty redeploy replaces it.

## What to build

Add a `describe('… lens redeploy …')` block to `sync-drain-e2e.spec.ts` (the real-engine drain
suite), plus the harness wiring it needs in `_peer-harness.ts`.

### Harness additions (`_peer-harness.ts`)

- In `makePeer`, after `SyncManagerImpl.create(...)`, bind the lens-deployment forwarder so a real
  `apply schema` drives the recorder exactly as production does:
  ```ts
  storeModule.setLensDeploymentListener((listenerDb, logicalSchemaName, snapshot) =>
    manager.recordLensDeployment(listenerDb, logicalSchemaName, snapshot));
  ```
  This is harmless to the existing tests (they never run `apply schema`, so it never fires). The
  manager already receives the live basis oracle `(s,t) => db.schemaManager.getTable(s,t)`, which
  reflects the physical drop/recreate — no extra wiring needed for the drain gate.
- Add focused helpers (mirroring `reviveOrders`), each `await settle()` after exec:
  - `deployOrdersLens(peer)` — `declare logical schema app { table orders { id integer primary key, note text } }` then `apply schema app`.
  - `retireOrdersViaRedeploy(peer)` — `drop table orders` **then** `declare logical schema app { }` then `apply schema app`.
  - `reviveOrdersViaRedeploy(peer)` — `create table orders (…) using store` then `deployOrdersLens(peer)`.
  - Keep the orders DDL sourced from `DEFAULT_ORDERS_DDL`/`ordersDdl` so the schema-drift case can override the basis column set.

### Core test (required) — the headline, mirroring the inbound reactive case

The straggler `S` stays a plain store-backed peer (`createOrders: true`); only `H` deals with the
lens. Sequence:

- `S` writes `insert into orders values (1, 'hi')`; capture S's origin HLC from
  `S.manager.columnVersions.getColumnVersion('main','orders',[1],'note')`.
- On `H`: step 1 (deploy mapping) → step 2 (retire via redeploy); assert
  `getBasisTableLifecycle()` shows `main.orders` `detached`.
- `relay(S, H)`; assert held count `=== COLUMNS_PER_FRESH_INSERT` and `getTable('main','orders')`
  is `undefined`.
- Subscribe to `H.events.onDataChange` and `getEventEmitter().onHeldChangesDrained` BEFORE step 4.
- Step 4: `reviveOrdersViaRedeploy(H)` then `await settle()`. **No `drainHeldChanges` call.**
- Assert, exactly as the inbound reactive `it` does:
  - **Row present:** `collect(H.db,'select id, note from orders')` deep-equals `[{ id: 1, note: 'hi' }]`.
  - **Origin HLC preserved:** `H`'s `note` column version has `value === 'hi'`,
    `siteIdEquals(hlc.siteId, S.manager.getSiteId())`, and `compareHLC(hlc, original) === 0`.
  - **Hold cleared:** `quarantine.list('main','orders')` is empty.
  - **One drained event:** `{ schema:'main', table:'orders', drained: COLUMNS_PER_FRESH_INSERT }`.
  - **No spurious local echo:** `orders` data events arrived `remote:true`, no non-remote `orders`
    event, and `hasOrders(changesFor(H, S.siteId)) === false` for H-origin.
  - **Second-order relay:** `flattenSets(H.manager.getChangesSince(generateSiteId()))` serves the
    orders changes from H's own log carrying S's origin siteId.

### Idempotent re-deploy (required) — parity with the inbound idempotent re-drain

After the core revival, deploy the SAME mapping again (`deployOrdersLens(H)` / `apply schema app`
with orders still mapped + present). Assert: no new `HeldChangesDrained` event (no
`detached → present` transition this time), the row value is unchanged, and the hold stays empty.

### Optional cases (add if cheap; the underlying machinery is already inbound-covered)

- **Schema drift across redeploy:** straggler DDL carries an extra `memo` column; revive `orders`
  WITHOUT `memo`; assert `drained` event reports `applied < drained` (the `memo` entry drift-dropped)
  and the surviving cells materialize — mirror the inbound drift `it`.
- **Watch + MV maintenance:** register a full watch + `create materialized view orders_mv …` over
  the revived `orders` BEFORE step 4; assert the watch fired with `orders` in `matched` and the MV
  reflects the drained row. (The shared drain machinery already proves this for the inbound path, so
  this is parity-only.)
- **`store-and-forward` disposition:** spawn `H` with `disposition:'store-and-forward'`; assert the
  forwardable hold empties after the redeploy drain.

## Edge cases & interactions

- **Retire ordering (drop before empty redeploy)** — see the load-bearing note above; assert the
  `detached` state after step 2 so a future refactor that reorders this fails loudly rather than
  silently testing the wrong transition.
- **Default-basis ambiguity** — `inferDefaultBasis` throws if it finds ≠1 physical-schema candidate.
  Keep `main` the sole physical-with-tables schema during the mapping deploys (a fresh `Database`
  satisfies this); a stray attached/temp physical table would break inference. Asserting the held
  changes key on `'main'` and that the drain lands implicitly guards `basisSchemaName === 'main'`.
- **Advisory-swallow contract** — the StoreModule forwarder swallows a throwing listener (so a
  bookkeeping/drain failure never aborts `apply schema`). The happy-path e2e does not exercise a
  throw (covered in `basis-lifecycle-recorder.spec.ts` and `lens-deployment-listener.spec.ts`), but
  do NOT add assertions that depend on `apply schema` rejecting on a drain failure — it won't.
- **`drainOnReappear` default** — the trigger respects `config.drainOnReappear` (default `true`).
  The harness uses `DEFAULT_SYNC_CONFIG`, so the reactive drain is on; no override needed.
- **Reactive timing** — `apply schema app` is fully awaited through the drain, but local-change
  capture is fire-and-forget post-commit, so `await settle()` after the revive deploy before reading
  the change log / events (the harness `settle()` already encodes the 25ms delay).
- **No spurious local DML** — the reactive drain ingests via `db.ingestExternalRowChanges`
  (remote:true), not local DML, so the redeploy must not produce an H-origin `orders` change; assert
  this (no spurious echo), matching the inbound case.
- **Lens view vs physical table** — `collect(db,'select … from orders')` must hit the physical
  `main.orders`, not the logical `app.orders` view. Unqualified `orders` resolves to `main`; keep
  the logical schema name `app` distinct so there is no shadowing surprise.

## Validation

- Run the package suite, streaming output:
  `yarn workspace @quereus/sync test 2>&1 | tee /tmp/sync-test.log; tail -n 80 /tmp/sync-test.log`
  (Mocha, via `register.mjs`.) Confirm the new describe block passes and nothing in the existing
  `sync-drain-e2e.spec.ts` / `_peer-harness.ts` consumers regressed.
- The harness change is in test code only; no `packages/quereus` lint pass is required, but if you
  touch shared types re-run `yarn lint` from `packages/quereus`.

## Expected outcome

The lens-redeploy revival path has the same real-engine confidence as the inbound-`create_table`
path: a held straggler edit becomes a queryable row the instant `apply schema app` re-maps its table
back — through the real store adapter, carrying S's origin HLC, clearing the hold, and driving the
same derived effects — without any explicit `drainHeldChanges` call and without waiting on the
periodic sweep.

## TODO

- [ ] `_peer-harness.ts`: bind `storeModule.setLensDeploymentListener` → `manager.recordLensDeployment` in `makePeer`.
- [ ] `_peer-harness.ts`: add `deployOrdersLens`, `retireOrdersViaRedeploy`, `reviveOrdersViaRedeploy` helpers.
- [ ] `sync-drain-e2e.spec.ts`: add the redeploy `describe` block — core reactive revival test (row present, origin HLC, hold cleared, drained event, no spurious echo, second-order relay).
- [ ] Add the `detached`-state assertion after the retire step (guards the load-bearing ordering).
- [ ] Add the idempotent re-deploy parity case (no second drain, row unchanged).
- [ ] (Optional) schema-drift / watch+MV / store-and-forward parity cases if cheap.
- [ ] Update the spec file's header comment to describe BOTH revival triggers (inbound create_table + lens redeploy).
- [ ] Run `yarn workspace @quereus/sync test` (streamed) and confirm green.
