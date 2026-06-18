description: Add an end-to-end test proving that sync edits held while a table was missing really replay into the re-created table through the real storage engine, with live queries and views reacting as they would for any normal change.
prereq:
files:
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts   # real-adapter e2e harness to clone (Peer/makePeer/relay/collect/settle)
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts     # current stub-store drainHeldChanges (revival) block — the baseline this hardens
  - packages/quereus-sync/src/sync/change-applicator.ts                   # drainHeldChanges / drainTableGroup under test
  - packages/quereus-sync/src/sync/store-adapter.ts                       # createStoreAdapter → db.ingestExternalRowChanges seam (Database.watch + MV maintenance)
  - packages/quereus/test/external-change-watch.spec.ts                   # db.watch(scope, handler) usage + manual ChangeScope literal
difficulty: medium
----

# Real-store integration test for the held-change drain (revival) path

## Context

`SyncManager.drainHeldChanges(schema?, table?)` (in `change-applicator.ts`,
`drainHeldChanges` → `drainTableGroup`) replays held out-of-basis changes
(`quarantine` + forwardable `store-and-forward`) into a table that has reappeared
in the local basis, then clears them from the hold. See `docs/sync.md`
§ Unknown-Table Disposition → Revival / drain.

The shipped unit coverage — the `drainHeldChanges (revival)` block in
`unknown-table-disposition.spec.ts` — drives resolution through the **real CRDT
metadata stores** but applies data into a tiny in-memory `Map` stub
(`makeHarness`'s `applyToStore`), never the real store adapter
(`createStoreAdapter`). So several claims are verified only at the
CRDT-metadata + stub level and never end-to-end through the engine seam. This
ticket adds a real-`Database` + `StoreModule` + adapter integration suite that
pins the drain path against the actual storage engine.

This is **hardening, not a bug fix** — the unit suite is a correct floor. Extend,
don't replace it.

## Design (resolved)

Clone the harness in `store-and-forward-relay-e2e.spec.ts` verbatim — `Peer`,
`makePeer`, `closePeer`, `localWrite`, `relay`, `collect`, `settle`,
`createInMemoryProvider`, `COLUMNS_PER_FRESH_INSERT`. It already wires the live
basis oracle the drain depends on:
`(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName)`,
which `getTableColumnNames` reads as `getTableSchema(s,t)?.columns?.map(c => c.name)`
(see `sync-manager-impl.ts`). Because the oracle reads the **real** db, dropping
and re-creating `orders` automatically flips the table out of / back into basis
and updates its column set — no stub mutation needed.

**The revival flow each test uses** (mirrors the relay e2e's makePeer-then-exec
shape):

```
  S (straggler)                         H (holder)
  ─────────────                         ──────────
  has `orders` (real, store-backed)     NO `orders` at receive time
  writes row(s) under S's HLC           disposition = quarantine | store-and-forward

  insert/delete on S ──relay(S→H)──► H diverts (out of basis) ──► held (durable)
                                                                       │
                          H.db.exec('create table orders …')          │  table reappears
                                                                       ▼
                          H.manager.drainHeldChanges('main','orders')  │  replays via
                                                                       ▼  createStoreAdapter
                                                          db.ingestExternalRowChanges
                                                          → row materializes  (select)
                                                          → Database.watch / MV fire
                                                          → entry cleared from hold
```

H is built with `createOrders: false` (and the disposition under test), receives
the straggler relay → the change is diverted in `applyChanges` Phase 1 and held,
then `H.db.exec('create table orders …')` re-creates it, then
`H.manager.drainHeldChanges('main', 'orders')` replays it. Confirmed seam: the
drain's `admitGroup` calls the store adapter, which runs
`db.ingestExternalRowChanges(...)` — the path that feeds `Database.watch` capture
and materialized-view maintenance (`store-adapter.ts` header + step 5). The stub
fires only `onRemoteChange`; it cannot exercise these derived effects, which is
the whole point of this suite.

**Why drain, not relay, is the trigger.** Unlike the relay e2e (where R never has
the table and forwards), here H *re-acquires* the table and the host explicitly
calls `drainHeldChanges`. The drain runs as a separate apply *after* the
re-creating DDL has committed, so older held changes simply LWW-resolve against
whatever fresh data is present.

## Tests to write (each on a real `Database` + adapter, queried back with `select`)

- **drain materializes a held row carrying the straggler's origin HLC.**
  S inserts `orders(1, 'hi')`; relay S→H (H has no `orders`) → held
  (`listForwardable`/`list` length == `COLUMNS_PER_FRESH_INSERT`). Re-create
  `orders` on H; `drainHeldChanges('main','orders')` returns the held count.
  Assert `select id, note from orders` on H deep-equals `[{id:1, note:'hi'}]`,
  and `H.manager.columnVersions.getColumnVersion('main','orders',[1],'note')`
  carries **S's** siteId + original HLC (`siteIdEquals` + `compareHLC(...,original)===0`),
  not H's. Capture `original` from S's column version as the relay e2e does.

- **MV maintenance / `Database.watch` fire on the revival.** Before the drain
  (after re-create), register `H.db.watch(scope, e => events.push(e))` with a
  `full` watch on `orders` (manual `ChangeScope` literal, per
  `external-change-watch.spec.ts`) AND create a materialized view over `orders`.
  After the drain assert the watch fired with `orders` in `matched`, and the MV
  reflects the drained row via `select`. This is the claim the stub cannot make.

- **delete of an absent pk is a genuine store no-op.** S inserts then deletes
  `orders(1)` so it relays only a `RowDeletion` (column versions dropped); relay
  S→H while H has no `orders` → the delete is held. Re-create `orders` (empty);
  drain. Assert the drain does **not** throw (`Table not found for external write`
  must not surface — the table now exists; the adapter suppresses the absent-delete
  as a no-op per `applyExternalRowChanges`), `select * from orders` is empty, no
  residue, the tombstone is recorded (`tombstones.getTombstone`), and the held
  entry is cleared.

- **forwardable → drain → relay-stops lifecycle.** Build H with
  `disposition: 'store-and-forward'`. Relay S→H → held forwardable
  (`listForwardable()` non-empty). Re-create `orders`; drain. Assert after drain:
  `listForwardable()` is empty AND the value now rides the **normal** change log —
  `H.manager.getChangesSince(generateSiteId())` relays the `orders` change as a
  real local version (origin still S's), not as a forwardable hold. (i.e. H is now
  a second-order relay exactly like the relay e2e's holder.)

- **schema-drift drop against a really-re-created-without-the-column table.**
  S has `orders(id, note, memo)` and inserts a row with all three; relay S→H
  while H has no `orders` → 3 held column entries. Re-create on H as
  `orders(id, note)` — **without** `memo`. Drain. Assert no throw, `drained`
  count covers all held entries, the drift `HeldChangesDrainedEvent` reports
  `applied < drained` (the `memo` entry skipped, `id`+`note` applied),
  `select id, note from orders` deep-equals the surviving cells, and
  `getColumnVersion(...,'memo')` is undefined.

## Edge cases & interactions

- **Capture settle timing.** Local writes capture fire-and-forget after the
  commit; reuse the harness's `settle()`/`localWrite()` so the change log is
  readable before each relay. The drain itself is synchronous within
  `drainHeldChanges`'s await, but `Database.watch` handlers may be async — await
  the drain's promise and, if needed, a `settle()` before asserting watch events.
- **Watch/MV registration order.** Register the watch and create the MV *after*
  re-creating `orders` (the change-scope analyzer needs the table to exist) and
  *before* the drain, so the revival is the firing transaction. A watch
  registered against a missing table would fail scope validation.
- **DDL is not synced here.** As in the relay e2e, each peer creates its own
  schema directly; the `relay()` helper strips `schemaMigrations`. The holder's
  re-create is a plain `H.db.exec`, not a synced migration.
- **Per-column recording.** A fresh insert is held as one entry per column (PK
  included) — assert counts against `COLUMNS_PER_FRESH_INSERT` (and 3 for the
  drift case's `id,note,memo`), not literally 1.
- **Origin preservation end-to-end.** Every materialized cell/tombstone must
  carry **S's** origin siteId+HLC after the drain, never H's clock — the drain
  groups revival events by `change.hlc.siteId` and omits `watermarkHLC`.
- **Idempotent re-drain.** A second `drainHeldChanges('main','orders')` returns 0,
  fires no `HeldChangesDrainedEvent`, and leaves the row + change log unchanged
  (value-identical, nothing re-applied).
- **No spurious local echo.** The drained row arrives `remote:true`; assert no
  non-remote `orders` data event on H and no H-origin `orders` entry in
  `changesFor(H, S.siteId)` (reuse the relay e2e's `hasOrders`/`changesFor`
  helpers).
- **Crash/partial-failure** is already covered at the unit level
  (`a crash during the drain apply leaves entries held`) — do not duplicate it
  here unless the real adapter exposes a distinct failure mode; the seam's
  per-change `errors` path aborting before metadata commit is the relevant
  invariant if you do.

## Validation

- `yarn workspace @quereus/quereus-sync test 2>&1 | tee /tmp/sync-test.log; tail -n 80 /tmp/sync-test.log`
  (or the package's configured test script — Vitest in `quereus-sync`).
- `yarn lint` from `packages/quereus` is the type-check gate for spec call sites,
  but it targets `packages/quereus`; type-check the new sync spec via the
  `quereus-sync` package build/test (Vitest type-checks on run).
- New file only; no production code changes expected. If a claim fails to hold
  against the real adapter, that is a genuine finding — capture it in the review
  handoff (and a fix ticket) rather than weakening the assertion.

## TODO

- Create `packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts` cloning the
  `store-and-forward-relay-e2e.spec.ts` harness (Peer/makePeer/relay/collect/settle).
- Add a `revivePeer`-style helper or inline the re-create step
  (`H.db.exec('create table orders …')`) between hold and drain.
- Write the five test cases above (origin-HLC materialization; watch+MV firing;
  absent-pk delete no-op; forwardable→drain→relay-stops; schema-drift drop).
- Add the idempotent re-drain + no-spurious-echo assertions to the materialization
  test (or as a small sibling `it`).
- Run the sync package tests + confirm green; update `docs/sync.md` §
  Unknown-Table Disposition → Revival / drain to note the e2e coverage if it lists
  test references.
- Hand off to review with an honest note on any claim that did not hold against
  the real adapter.
