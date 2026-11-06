description: A server that no longer has a table can be set to keep changes for it and pass them on to devices that still have the table. A change made offline and uploaded later is never passed on to a device that has already caught up with the server, so that device silently stays without it.
architecture: docs/sync.md#store-and-forward-relay
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts   # collectForwardableChanges: filters a held change by its write time against the reader's watermark; buildChangeSetsForPeer places it in the reply at its write time
  - packages/quereus-sync/src/metadata/quarantine.ts       # the held entry's record and key: holds no record of when the change reached this replica
  - packages/quereus-sync/src/sync/change-applicator.ts    # applyChanges, the hold step after commitChangeMetadata: where a held change could be given an arrival position
  - packages/quereus-sync/src/metadata/filing-position.ts  # the arrival-order position applied changes already have
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts  # 'a below-watermark forwarded change is not relayed' asserts today's behaviour
  - docs/sync.md                                           # § Store-and-forward relay, "Known gap" bullet
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It only occurs under the non-default `store-and-forward` setting, during the period when some replicas have retired a table and others have not, and the relay itself never loses the change; the fix adds an arrival position to held entries and a second way of reading them.
----

## Background

When a replica receives a change for a table it does not have, the `unknownTableDisposition` setting decides what happens. Under `store-and-forward` the replica keeps the change ("holds" it) and offers it to every peer that asks for changes, so a peer that still has the table receives it through a relay that does not.

A peer asks for changes "after my watermark". Since `ticket(implement): bug-sync-late-push-skipped-by-newer-watermark`, the watermark measures how far through the serving replica's change log the peer has read, in the order changes *reached* that replica. A change the replica applies is given a place in that order (its filing position) when it arrives, so it reaches every peer however long ago it was written.

A held change is not given a place in that order. It is offered only to a peer whose watermark is below the change's *write time*.

## What happens

Run at the `SyncManagerImpl` layer with real engines (a throwaway probe during the review of the ticket above; not committed).

1. Server S is set to `store-and-forward` and has no table `extra`. Devices B and C both have it.
2. B, offline, inserts a row into `extra`.
3. S records a newer change (a local write to another table). C pulls from S and is now caught up; its watermark is the position of that newer change.
4. B connects and pushes its insert. S holds it.
5. C pulls from S at its watermark.

| Request | Reply |
|---|---|
| C, from its watermark | empty: the held insert is not offered |
| a new device, from nothing | includes the held insert |

C never receives B's row through S, and nothing is reported. This is the same failure the ticket above fixed for applied changes, on the one path it left on write time.

## Why

`collectForwardableChanges` keeps a held change only when `change.hlc` (its write time) is above `sinceHLC`. On a pull `sinceHLC` is a position on the serving replica, which is at or above every write time that replica had seen when it issued the position. A change written before the reader's last pull and arriving after it therefore always fails the test.

The comparison cannot simply be dropped: a held change is placed in the reply at its write time, and the reader moves its watermark to the greatest position in the reply. A change placed at or below the reader's watermark would not move it, and the same reply would be served on every request.

Before the ticket above, applied changes had the same limit and this one was documented as accepted for that reason ("the same scalar-watermark limitation the base delta layer already has"). That reason no longer holds, which is why this is filed rather than left as an accepted tradeoff.

## Expected behaviour

A held change reaches every peer that pulls from the holding replica after the change arrived there, whatever its write time, exactly once per peer (until the entry is dropped by retention or drained because the table came back).

The properties the relay already has must be kept:

- a peer is never sent a change it wrote itself;
- a reply's watermark never moves a reader past a held or applied change it was not sent, including when the reply is cut at the batch size;
- a held change is not re-sent on every request;
- a snapshot still carries no held changes.

## Direction

The representation fix is to give a held change a filing position when it is held, taken from the same clock tick and the same queue as the rest of its batch, and stored on the held entry. On a pull the change is then filtered and placed by that position, like an applied change, and its set carries a `cursor`. `getChangesToPush` stays on write time, as it does for applied changes.

Two points the design has to settle:

- A held change that is later replayed (its table reappears) is filed in the change log at a new tick. A reader that already received it while it was held will receive it again from the log; that is harmless (the apply is idempotent) but should be stated.
- Held entries written before this change have no position. Treating an absent position as "at its write time" matches how every other record was migrated.
