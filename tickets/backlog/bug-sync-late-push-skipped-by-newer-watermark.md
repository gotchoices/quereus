description: When one device reconnects and uploads changes it made offline, another device that is offline at that moment may never receive them, because it has already caught up past their timestamps. The two devices then disagree permanently and nothing reports it.
architecture: docs/sync-protocol.md
files:
  - packages/quereus-sync/src/metadata/change-log.ts          # the change log is ordered by the timestamp the change was written with, not by when this replica received it
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # getChangesSince returns only entries after the requester's watermark
  - packages/quereus-sync-client/src/sync-client.ts           # the received watermark advances to the highest timestamp in each reply
  - docs/sync.md                                              # line ~254 states this limit, for the relay path only
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: The fix likely changes what a watermark means (a position in the server's arrival order instead of a write timestamp), which touches the wire protocol and every delta path, and a periodic snapshot could hide the symptom more cheaply.
----

## What is wrong

A device asks the server for "everything after watermark W", where W is the highest write timestamp it has received. The server's change log is ordered by each change's original write timestamp. A change written before W but arriving at the server after the device read past W sits below the watermark, so no later request returns it. A device connected at the time gets it by live broadcast. One that is offline does not.

## Reproduction

Ran as a throwaway spec (deleted) using `makePeer` from `_peer-harness.ts`, with three peers: device B, a server stand-in S, device C. This used `SyncManagerImpl` calls directly, without a coordinator or sockets.

1. B inserts row 1 and pushes it to S. C pulls from S and has row 1.
2. B deletes row 1 while offline.
3. S gets a newer write (row 2). C pulls and its watermark moves past B's delete.
4. B reconnects and pushes the delete. S applies it.
5. C asks S for changes since its watermark.

Result: the reply was empty. S had rows `[2]` and C had rows `[1, 2]`.

The delete is only the case that was run. From reading the code, any late change takes the same path, including column edits.

## Expected behaviour

Once a change has reached the server, every device that catches up with the server receives it, however old its write timestamp is. Devices converge without needing a full snapshot.

## Notes

`docs/sync.md` § Store-and-forward relay ("Accepted limitation") names this as "the same scalar-watermark limitation the base delta layer has" and says such a change "arrives by direct sync / snapshot instead". That was written about the relay path. For an ordinary device talking to one server there is no direct sync, and no automatic snapshot unless the delta floor refuses it, so the change does not arrive. A maintainer should decide whether this counts as the same accepted limit. Filed because that note does not weigh the plain device-and-server case.

`bug-sync-client-prunes-unpushed-tombstones` makes long-offline deletes reach the server, so it adds to the deletes that can take this path, though it does not cause it. The review of `bug-sync-delta-served-past-retention-horizon` also noted this as an existing property.
