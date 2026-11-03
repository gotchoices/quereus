description: A device that has fallen behind by more than one batch of changes only receives the first batch when it connects, and gets the rest on a later reconnect. It looks fully synced in the meantime.
architecture: docs/sync.md
files:
  - packages/quereus-sync-client/src/sync-client.ts # handleChanges, requestChangesFromServer
  - packages/sync-coordinator/src/server/websocket.ts # get_changes sends one reply
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: Nothing is lost, because the watermark only advances over what arrived and the next reconnect fetches more, so a maintainer might defer this until someone sees the delay in practice.
----

`SyncManager.getChangesSince` returns at most `config.batchSize` facts (default 1000), rounded up to a whole transaction. The coordinator's `get_changes` handler sends that as one `changes` reply. The client only sends `get_changes` from the handshake and after a snapshot recovery, and `handleChanges` does not ask again after a reply, even when the reply was full. It sets the status to `synced` regardless.

So a device more than one batch behind stops part-way, reports `synced`, and stays there until its next reconnect fetches another batch. Live broadcasts still arrive, but they do not advance the watermark, so the gap remains.

Expected: the client keeps asking until a reply is empty or shorter than a full batch, and does not report `synced` before then.

This is from reading the code; I did not run it. To confirm, connect a client to a server holding more than 1000 changes it has not seen, and check whether the rows past the first reply arrive without a reconnect.

Found while planning `sync-push-drains-all-local-changes`, which fixes the same shape of problem on the sending side.
