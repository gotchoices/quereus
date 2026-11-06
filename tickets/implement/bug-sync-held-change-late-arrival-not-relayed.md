description: A server that no longer has a table can be set to keep changes for it and pass them on to devices that still have the table. A change made offline and uploaded later is never passed on to a device that has already caught up with the server; give each kept change a place in the server's arrival order so it reaches every device that pulls after it arrived.
architecture: docs/sync-unknown-tables.md#store-and-forward-relay
files:
  - packages/quereus-sync/src/sync/change-applicator.ts   # applyChanges hold step (~line 529, after commitChangeMetadata); commitChangeMetadata / FilingOptions / FactToFile / fileAtNextTick / fileFact (~line 1309–1430)
  - packages/quereus-sync/src/metadata/quarantine.ts       # QuarantineEntry, SerializedQuarantineEntry, put, listForwardable; needs a position field and a keyed read
  - packages/quereus-sync/src/metadata/filing-position.ts  # filingPosition, positionField, encodePosition/decodePosition — reuse, no change expected
  - packages/quereus-sync/src/sync/sync-manager-impl.ts    # getChangesSince (~1540), getChangesToPush (~1576), buildChangeSetsForPeer (~1615), collectForwardableChanges (~1911) and its doc comment ("Known gap")
  - packages/quereus-sync/src/sync/change-grouping.ts      # filedAtOrigin doc comment mentions held changes as never filed
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts  # tests that pin write-time placement must be revised (list below)
  - docs/sync-unknown-tables.md                            # § Store-and-forward relay: "Watermark-safe", "Bound + ordering", "Known gap" bullets
  - docs/migration.md                                      # line ~109, the store-and-forward bullet's "accepted corollary" sentence
repro: verified
----

## The defect

Under `unknownTableDisposition: 'store-and-forward'`, a replica that lacks a table keeps ("holds") incoming changes for it in the quarantine store (`qt:` keys) marked forwardable, and folds them into every `getChangesSince` reply so peers that have the table receive them.

`getChangesSince(peer, sinceHLC)` is called with the peer's watermark, which is a **filing position** on the serving replica: a place in the order changes reached that replica (`metadata/filing-position.ts`). Applied changes are given a position when filed, so a late-arriving old change still reaches every peer. Held changes are not: `collectForwardableChanges` filters them by `change.hlc` (write time) `> sinceHLC` and `buildChangeSetsForPeer` places them at their write time (`filedAtOrigin`). A held change written before a peer's last pull and arriving after it is never offered to that peer.

Reproduced at the `SyncManagerImpl` layer (throwaway probe, deleted; the test below is its committed form):

1. Relay R (`store-and-forward`, basis `main.users`); holder H (has `main.orders`).
2. R applies a newer `users` change; H pulls from nothing and takes the reply's watermark (a position ≈ now).
3. Straggler B's `orders` change written a minute earlier reaches R; R holds it.
4. `R.getChangesSince(H, watermark)` returns `[]`; `R.getChangesSince(newPeer)` returns `['orders', 'users']`.

## The fix

Give a held change a filing position when it is held, taken from the same clock tick as the rest of its apply batch, written in the same KV batch as the clock and the applied facts, and stored on the quarantine entry. On a pull, filter and place held changes by that position, exactly as applied changes are. On a push, stay on write time (push watermarks are origin timestamps).

### Hold step moves onto the commit chain

Today the hold is a separate `qBatch.write()` after `commitChangeMetadata`, off the commit chain. With positions it must not stay there: the commit chain is what makes commit order equal position order (see `fileAtNextTick`'s doc comment). A held entry written after its tick was issued could land below a position a peer has already read past, and that peer would skip it — the same bug again, as a race.

So the held changes become a fourth `FactToFile` kind (e.g. `{ kind: 'held', hlc, change, receivedAt, forwardable }`), passed to `commitChangeMetadata` through `FilingOptions`, positioned in `fileAtNextTick` in the same origin-ordered sequence as migrations and applied facts, and staged by `fileFact` via `ctx.quarantine.put(batch, change, receivedAt, forwardable, position)`. Filing them in origin order with the applied facts keeps each transaction's facts in one unbroken run of positions in the tick, which `change-grouping.ts` relies on. A batch that holds changes but applies none must still take a tick (today `commitChangeMetadata` returns early only when there are no facts and no watermark; held facts count as facts).

Plain `quarantine` holds may take positions too; that is harmless and keeps one code path. Positions only need to rise, not be dense.

### A re-held change keeps its first position (loop-freedom)

`put` is HLC-keyed and overwrites. If a re-delivered held change got a **new** position each time, two `store-and-forward` relays that both lack the table would pass it back and forth forever: R1 serves it to R2, R2 re-holds at a new position above R1's watermark on R2, R1 pulls it back and re-holds at a new position above R2's watermark on R1, and so on. Today's origin-time filter is what stops that loop; positions remove that stop.

Rule: when an entry for the same key already exists, keep its stored position (still overwrite `receivedAt` and the `forwardable` flag, as today). This needs a keyed read on `QuarantineStore` (e.g. `get(change)` building the key as `put`/`delete` do), done inside the commit-chain entry (`fileAtNextTick`) so two concurrent applies of the same change cannot both see "absent". The ping-pong and multi-hop "quiesces" tests in `store-and-forward-relay.spec.ts` fail if this rule is missing — they are the guard.

A re-held change that had been pruned by retention gets a new position; the next exchange applies it idempotently on a holder (LWW resolves it as already present, so it is not re-filed there), so that does not loop either.

### Storage

- `QuarantineEntry` gains `position?: HLC`; `SerializedQuarantineEntry` gains an optional `p` (use `encodePosition`, and `positionField(hlc, position)` so it is stored only when it differs from the change's HLC).
- An entry without `p` (written before this change) is read as filed at its write time: `filingPosition({ hlc: change.hlc, position })`. Same migration rule as every other record.

### Read side

- `collectForwardableChanges` returns `FiledChange[]` and takes the axis: on `getChangesSince` filter `filingPosition(entry) > sinceHLC` and place at that position; on `getChangesToPush` filter `change.hlc > sinceHLC` and place at `change.hlc` (as today). Simplest: each caller collects its forwardable list and passes it to `buildChangeSetsForPeer`, rather than a mode flag.
- `buildTransactionChangeSets` then gives held sets a `cursor` like any other set filed at a position different from its HLC. A held change and the applied part of the same transaction filed in the same tick now share one group key (transaction | tick), so they come out as one ChangeSet; parts filed at different ticks stay separate, each with its own cursor.
- The bound argument in `buildChangeSetsForPeer`'s comment still holds unchanged (the forwardable scan stays full; union re-bounded at `M ≤ C`); update its wording, which says held changes sit at their origin.
- Echo exclusion (never send a change to the site that wrote it) is unchanged.
- Snapshots still carry no held changes. As today, a reader bootstrapped from a snapshot resumes at the snapshot header and is not offered held changes positioned below it; this is not a regression (the write-time filter excluded them too) and such a reader takes the relay's basis, which lacks the table.

### Stated consequences (put in the docs)

- A held change that is later replayed into its reappeared table (`drainHeldChanges`) is filed in the change log at a new tick, so a reader that already received it while held receives it once more from the log; the apply is idempotent.
- `relayed` telemetry semantics are unchanged (counts re-offers).

## Reproduction test

Replace the `'below-watermark straggler is not relayed (documented scalar-watermark limitation)'` block in `test/sync/store-and-forward-relay.spec.ts` with this (uses the file's existing `makePeer`, `col`, `changeSet`, `tablesIn`, `pull` helpers). It fails at HEAD with `expected [] to include 'orders'`:

```ts
describe('late-arriving held change', () => {
  it('relays a held change written before the reader\'s watermark but held after it, once', async () => {
    const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
    const H = await makePeer({ disposition: 'quarantine', known: ['main.users', `main.${RETIRED}`] });
    const B = generateSiteId(); // straggler, offline
    const X = generateSiteId();
    const now = Date.now();

    await R.manager.applyChanges([changeSet(X, 'tx-x', [col(X, now, 'users', 1, 'a', 'x')])]);
    const caughtUp = await pull(R, H, undefined); // H's watermark is now R's position for X's change

    const late = col(B, now - 60_000, RETIRED, 1, 'note', 'offline'); // written before H's watermark
    await R.manager.applyChanges([changeSet(B, 'tx-b', [late])]);  // arrives after it; R holds it

    const next = await pull(R, H, caughtUp.since);
    expect(tablesIn(next.sets), 'the late held change reaches the caught-up reader').to.include(RETIRED);
    const again = await pull(R, H, next.since);
    expect(tablesIn(again.sets), 'and is not re-sent').to.not.include(RETIRED);
  });
});
```

## Existing tests that encode write-time placement

These assert today's behaviour and must be revised to arrival order, not deleted:

- `'ordering' › places a forwarded change at its write time…` — the held change now sits where R held it (after the two live writes): expect `[live 2000, live 1000, orders 1500]`, and every set carries a `cursor`. Rename accordingly.
- `'bound: merged change-log + forwardable truncation'` — rounds now deliver in arrival order: `[live 1000, orders 1500, live 2000]`. Its title's "re-collected, still > sinceHLC" wording should say position.
- `'does not re-relay C once the holder's watermark advanced past it'` — should still pass (R's positions are ≈ now, above the hand-built `1000n` watermark); its comment says "HLC ≤ watermark", reword to position.
- Ping-pong and multi-hop quiescence tests — must pass unchanged; they guard the keep-first-position rule.
- `unknown-table-disposition.spec.ts` and any quarantine serialization tests — check they still pass; an entry with no position must decode as before.

## TODO

- Add `position?: HLC` to `QuarantineEntry`, optional `p` to the serialized form (via `positionField` / `encodePosition` / `decodePosition`), and a keyed `get` on `QuarantineStore`; `put` takes the position.
- In `change-applicator.ts`, add the `held` fact kind; pass held changes (with `receivedAt` and `forwardable`) to `commitChangeMetadata` via `FilingOptions`; in `fileAtNextTick` look up each held change's existing entry and keep its position if present, otherwise take the next position from the tick; stage the `qt:` writes in the same batch. Remove the separate post-commit `qBatch` hold write. Keep the `ignore` disposition writing nothing.
- Check `drainHeldChanges` still deletes held entries correctly (key unchanged — position is in the value, not the key).
- In `sync-manager-impl.ts`, split forwardable collection by axis (position for `getChangesSince`, origin for `getChangesToPush`), returning `FiledChange[]`; update `buildChangeSetsForPeer`'s and `collectForwardableChanges`'s comments; delete the "Known gap" paragraph.
- Update `filedAtOrigin`'s doc comment in `change-grouping.ts` (held changes being relayed on a pull are no longer on the origin axis).
- Add the reproduction test above in place of the below-watermark block; revise the ordering and bound tests as listed.
- Docs: in `docs/sync-unknown-tables.md` § Store-and-forward relay rewrite "Watermark-safe" (held changes have a position) and "Bound + ordering" (same axis, same-tick parts of a transaction form one ChangeSet), replace "Known gap" with the replay-resend and keep-first-position statements, and adjust "Loop-free" to name the keep-first-position rule; in `docs/migration.md` drop the "accepted corollary … scalar-watermark limitation" sentence.
- Run `yarn workspace @quereus/sync test` (or `yarn test` from the root) and `yarn build`.
