description: Adds an end-to-end test proving that edits made while a table was missing really reappear in the re-created table — and that live queries and views react to them — by driving the real storage engine instead of a stub.
prereq:
files:
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts                 # NEW — the real-adapter drain (revival) e2e suite
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts    # harness cloned (Peer/makePeer/relay/collect/settle)
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts      # the stub-store revival block this hardens (unchanged)
  - packages/quereus-sync/src/sync/change-applicator.ts                    # drainHeldChanges / drainTableGroup under test (unchanged)
  - packages/quereus-sync/src/sync/store-adapter.ts                        # createStoreAdapter → db.ingestExternalRowChanges seam (unchanged)
  - docs/sync.md                                                           # Revival / drain section updated to cite the new e2e
difficulty: easy
----

# Review: real-store integration test for the held-change drain (revival)

## What landed

A new **test-only** file, `packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts`
(5 `it`s), plus a one-paragraph update to `docs/sync.md` § Unknown-Table
Disposition → Revival / drain (the prior text flagged the real-adapter pass as a
"hardening follow-up"; it now cites the new suite). **No production code changed.**

The suite clones the relay-e2e harness verbatim (`Peer` / `makePeer` / `relay` /
`collect` / `settle` / `createInMemoryProvider` / `COLUMNS_PER_FRESH_INSERT`) and
drives REAL `Database` + `StoreModule` + `createStoreAdapter` peers, so the drain's
`admitGroup` → store adapter → `db.ingestExternalRowChanges(...)` seam actually
runs — the path the in-memory stub in `unknown-table-disposition.spec.ts` cannot
exercise (the stub fires only `onRemoteChange`; it never touches the engine, so it
cannot prove watch capture or MV maintenance).

Two harness deltas from the relay e2e, both intentional:
- `makePeer` gained an `ordersDdl?` option (default the standard 2-column DDL) so
  the schema-drift test can give S a 3-column `orders`.
- A `reviveOrders(peer, ddl?)` helper inlines the holder's re-create step between
  hold and drain. Peers are spawned per-test (heterogeneous dispositions / DDL) and
  tracked for `afterEach` teardown rather than built in a shared `beforeEach`.

## The revival flow each test exercises

```
  S (straggler, has store-backed orders)        H (holder, NO orders at receive time)
  insert/delete on S ──relay(S→H)──► H diverts (out of basis) ──► held (durable)
                       H.db.exec('create table orders …')  ── table reappears (live basis oracle flips it back)
                       H.manager.drainHeldChanges('main','orders')  ── replays via createStoreAdapter
                                 → row materializes (select) → Database.watch / MV fire → hold cleared
```

The basis oracle is `db.schemaManager.getTable`, so re-creating `orders` on H flips
it back into basis with its live column set — no stub mutation. Drain (not relay) is
the trigger: H re-acquires the table and the host explicitly calls `drainHeldChanges`
as a separate apply after the re-create has committed.

## Tests / use cases to validate against

1. **Origin-HLC materialization (+ idempotent re-drain + no spurious echo).**
   `select id, note from orders` on H deep-equals `[{id:1, note:'hi'}]`; the
   materialized `note` column version carries **S's** siteId + original HLC
   (`siteIdEquals` + `compareHLC === 0`), not H's. The drained row arrives
   `remote:true` (no non-remote `orders` data event, no H-origin echo in
   `changesFor(H, S.siteId)`); H then serves it from its own log with S's origin. A
   second `drainHeldChanges` returns 0, fires no `HeldChangesDrainedEvent`, leaves
   the row value-identical.
2. **MV maintenance / `Database.watch` fire on the revival.** A `full` watch on
   `orders` and a materialized view `orders_mv` are registered *after* the re-create
   and *before* the drain; after the drain the watch fired with `orders` in
   `matched` and `select … from orders_mv` reflects the drained row. **This is the
   headline claim the stub cannot make.**
3. **Absent-pk delete is a genuine store no-op.** S insert-then-delete relays only a
   `RowDeletion`; after re-create + drain there is no throw (`Table not found for
   external write` never surfaces), `select * from orders` is empty, the tombstone is
   recorded with S's origin, and the hold is cleared.
4. **Forwardable → drain → relay-stops lifecycle.** H built `store-and-forward`;
   after drain `listForwardable()` is empty and the value rides the **normal** change
   log (`getChangesSince(generateSiteId())` returns it as a real S-origin version, not
   a forwardable hold).
5. **Schema-drift drop against a really-re-created-without-the-column table.** S has
   `orders(id, note, memo)`; H re-creates `orders(id, note)`. Drain: no throw,
   `drained = 3`, the `HeldChangesDrainedEvent` reports `applied: 2, skipped: 1`
   (`applied < drained`), `select id, note` deep-equals the survivors, and
   `getColumnVersion(…,'memo')` is undefined.

## Validation performed

- `node --import ./packages/quereus-sync/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts"` → **5 passing**.
- Full sync suite (`packages/quereus-sync/test/**/*.spec.ts`) → **411 passing**, exit 0.
  (The `[Sync] …drifted out-of-band` / `Error handling transaction commit` console
  noise is deliberate failure-injection from `sync-manager.spec.ts`, not from this file.)
- Type-check gate: `tsc -p packages/quereus-sync/tsconfig.test.json` (`strict`, includes
  `test/**/*`) → exit 0, no errors. NOTE the Mocha runner uses Node native type-stripping
  / `ts-node` transpile-only, so it does **not** type-check on run — the explicit `tsc`
  above is the real gate for the spec call sites (the ticket's "Vitest type-checks on run"
  assumption was wrong: this package is **Mocha + ts-node**, not Vitest).

## Honesty notes for the reviewer (your tests are a floor)

- **Every claim held against the real adapter** — nothing was weakened, no finding had
  to be filed. The drain genuinely materializes rows, preserves S's origin HLC, fires
  watch + MV, no-ops absent deletes, stops forwarding, and drift-drops cleanly.
- **A de-risk script (not committed) confirmed the load-bearing seam premise** before the
  suite was written: an MV over a `using store` table is maintained, and a `full` watch on
  it fires, when driven through `db.ingestExternalRowChanges` directly. So test 2's green
  is the drain *actually reaching* that seam, not an artifact of a never-exercised path.
- **Coverage edges deliberately not duplicated here** (already at the unit level, or low
  marginal value end-to-end):
  - The crash/partial-failure invariant (`a crash during the drain apply leaves entries
    held`) is unit-covered; the real adapter exposes no distinct failure mode worth a
    second copy. A reviewer wanting belt-and-suspenders could add a real-adapter variant
    that makes the store throw mid-drain and asserts the hold survives + a re-drain
    recovers — but it would re-assert the same `admitGroup` data-first/metadata-second
    ordering the unit test already pins.
  - LWW-against-fresh-data convergence (held-newer-wins / held-older-loses / tombstone
    blocking / resurrection) is unit-covered; the e2e trusts `resolveChange` is identical
    on the drain path (it is — same function) and pins only the *store-visible* outcomes.
  - The watch assertion checks the watch **fired and matched `orders`**; it does not pin
    `matched[0].hits` shape (a `full` watch carries empty hits) — adequate for "the
    revival is the firing transaction", but a reviewer could tighten to a `rows` watch and
    assert `hits === [[1]]` if a per-row guarantee is wanted.
- **Timing:** local capture is fire-and-forget post-commit, so the suite reuses the
  harness `settle()` after writes/relays/drain. The drain's seam call is awaited inside
  `drainHeldChanges`, so watch events are present when the await returns; the extra
  `settle()` after drain is belt-and-suspenders for any async watch handler.
