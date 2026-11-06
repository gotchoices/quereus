description: A server that no longer has a table can keep changes for it and pass them on to devices that still have it. A change made offline and uploaded late was never passed on to a device that had already caught up; each kept change now gets a place in the server's arrival order, so every device that pulls after it arrived receives it.
architecture: docs/sync-unknown-tables.md#store-and-forward-relay
files:
  - packages/quereus-sync/src/metadata/quarantine.ts       # QuarantineEntry.position, serialized `p`, holdPosition(), getMany(), put(…, position?)
  - packages/quereus-sync/src/sync/change-applicator.ts    # HoldOptions / FilingOptions.hold, holdOptions(), HeldFact + heldFacts(), fileAtNextTick, positionsOfExistingHolds, fileFact 'held'
  - packages/quereus-sync/src/sync/sync-manager-impl.ts    # getChangesSince / getChangesToPush pass the axis; buildChangeSetsForPeer (now sync); collectForwardableChanges(peer, since, placeOf)
  - packages/quereus-sync/src/sync/change-grouping.ts      # filedAtOrigin doc only
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts  # header comment only
  - docs/sync-unknown-tables.md                            # § Store-and-forward relay bullets
  - docs/migration.md                                      # store-and-forward bullet, corollary sentence replaced
----

## What changed

Under `unknownTableDisposition: 'store-and-forward'` a replica that lacks a table holds incoming changes for it in the quarantine store (`qt:` keys), marked forwardable, and folds them into `getChangesSince` replies. A pull's `sinceHLC` is a **filing position** (a place in the order changes reached the serving replica, `metadata/filing-position.ts`). Held changes used to be filtered and placed by write time, so one written before a reader's last pull but arriving after it was never offered to that reader.

Now:

- **Hold step is on the commit chain.** The separate post-commit `qBatch` hold write in `applyChanges` is gone. Diverted changes go to `commitChangeMetadata` as `FilingOptions.hold` (`{ changes, receivedAt, forwardable }`, built by `holdOptions()`; `ignore` → `undefined`, nothing written). `fileAtNextTick` files them as a fourth fact kind (`'held'`) in the same origin-ordered sequence as migrations and applied facts, at positions off the same tick, in the same KV batch as the clock. A batch that only holds still takes a tick (held facts count as facts).
- **A re-held change keeps its first position** (`positionsOfExistingHolds`, one `QuarantineStore.getMany` read inside the commit-chain entry). This is what stops two `store-and-forward` relays that both lack the table from passing a change back and forth forever. `receivedAt` and `forwardable` are still overwritten.
  - **Addition beyond the ticket:** a plain `quarantine` hold re-held as forwardable takes a **new** position, since no reader has been offered it yet. Loop-freedom is unaffected (a re-hold of an already forwardable entry keeps its position). No test pins this branch; it needs a disposition change between two deliveries of the same change.
- **Storage:** `QuarantineEntry.position?: HLC`, serialized as `p` (via `encodePosition`, and only when it differs from the change HLC, via `positionField`). An entry without `p` reads as held at its write time (`holdPosition(entry)`). Key unchanged, so `drainHeldChanges`' deletes are unaffected.
- **Read side:** `collectForwardableChanges(peer, sinceHLC, placeOf)` returns `FiledChange[]`; the caller picks the axis. `getChangesSince` passes `holdPosition` (filter and place by position, so held sets carry a `cursor`); `getChangesToPush` passes `entry => entry.change.hlc` (write time, as before). `buildChangeSetsForPeer` takes the collected list and is no longer async. The "Known gap" paragraph is deleted; bound-argument wording updated.
- **Docs:** `docs/sync-unknown-tables.md` § Store-and-forward relay rewrites "Watermark-safe", "Loop-free" (keep-first-position rule), "Bound + ordering" (one axis; same-tick parts of a transaction form one ChangeSet), replaces "Known gap" with "Replay resends once", and adds the snapshot-bootstrapped-reader note. `docs/migration.md` drops the "accepted corollary … scalar-watermark limitation" sentence.

## Tests

In `test/sync/store-and-forward-relay.spec.ts`:

- **Added** `late-arriving held change › relays a held change written before the reader's watermark but held after it, once`: the reproduction from the fix ticket, which fails at HEAD with `expected [] to include 'orders'`. It replaces the old `below-watermark straggler is not relayed (documented scalar-watermark limitation)` block, which asserted the bug.
- **Revised** `ordering › places a forwarded change where it was held, in arrival order with applied changes`: expects `[live 2000, live 1000, orders 1500]`, with a `cursor` on every set.
- **Revised** `bound: merged change-log + forwardable truncation`: rounds deliver in arrival order `[live 1000, orders 1500, live 2000]`; title says position.
- **Comments only:** `does not re-relay C…` and the multi-hop quiesce comment now say position instead of HLC.

Guard check: with the keep-first rule disabled, **only the ping-pong test** (`two relay peers exchange a forwarded change exactly once and quiesce`) fails. The ticket expected the multi-hop "quiesces" test to fail too, but it does not, because that test only pulls forward along the chain and never re-holds. So the ping-pong test is the only guard for the rule.

Validation run: `yarn workspace @quereus/sync test` 869 passing; `yarn workspace @quereus/sync typecheck` clean; `yarn build` clean; `@quereus/sync-client` 118 passing; `@quereus/sync-coordinator` 141 passing.

## Things for the reviewer to check

- **Bound argument with merged groups.** On a pull, a held change and the applied part of its transaction filed in the same tick now share one group (transaction | tick), so `collectChangesSince` sees only the applied part while the full forwardable scan supplies the rest. I reasoned that within one apply's tick a transaction's facts form one unbroken run of positions, so the merged group's last position stays below the next change-log group's first and `M ≤ C` still holds. No test builds a transaction split across a live and a retired table in one batch under `batchSize` truncation. Worth a look, or a test if you think it's needed.
- **Commit-chain cost.** `positionsOfExistingHolds` does one batched `getMany` per apply that holds anything, inside the commit-chain entry. It reads nothing when there are no holds.
- **Plain `quarantine` holds take positions too.** They use `opSeq` slots in the tick but are never offered. Positions only need to rise, so the gaps are harmless.
- **Stated consequences, unchanged by design:** a held change that `drainHeldChanges` later replays is filed in the change log at a new tick, so a reader that already got it while held receives it once more (the apply is idempotent). A snapshot-bootstrapped reader is not offered held changes positioned below the snapshot header (the old write-time filter excluded them too). `relayed` still counts re-offers. The push-path echo NOTE in `getChangesToPush` is unchanged.
