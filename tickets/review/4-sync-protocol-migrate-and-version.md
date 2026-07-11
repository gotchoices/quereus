description: The sync client and server now share one copy of their network message format instead of two drifting copies, and they exchange and check a version number when connecting so a mismatched pair fails loudly at connect time instead of silently misbehaving.
files:
  - packages/quereus-sync-client/src/serialization.ts        # DELETED (codec moved to @quereus/sync)
  - packages/quereus-sync-client/src/types.ts                # stripped message/Serialized* types; kept SyncStatus/SyncEvent*/SyncClientOptions
  - packages/quereus-sync-client/src/index.ts                # codec + wire types re-exported from @quereus/sync (public API unchanged)
  - packages/quereus-sync-client/src/sync-client.ts          # shared codec import; sendHandshake stamps protocolVersion; handleHandshakeAck checks it
  - packages/sync-coordinator/src/common/serialization.ts    # DELETED
  - packages/sync-coordinator/src/common/index.ts            # re-exports codec from @quereus/sync
  - packages/sync-coordinator/src/server/websocket.ts        # shared unions; handleHandshake rejects bad/absent version before auth; ack echoes it
  - packages/sync-coordinator/src/server/routes.ts           # repointed import + cast at HTTP JSON boundary
  - packages/sync-coordinator/src/service/coordinator-service.ts  # cast at S3 batch-replay boundary
  - packages/sync-coordinator/src/service/s3-snapshot-store.ts    # repointed import + cast at S3 snapshot boundary
  - packages/quereus-sync-client/test/sync-client.spec.ts    # version tests; handshake helpers stamp version
  - packages/sync-coordinator/test/websocket.spec.ts         # version tests; existing handshakes stamp version
  - packages/quereus-sync-client/test/serialization.spec.ts  # DELETED (duplicate of @quereus/sync wire.spec.ts)
  - packages/sync-coordinator/test/serialization.spec.ts     # DELETED (duplicate of @quereus/sync wire.spec.ts)
  - docs/sync.md
  - docs/sync-coordinator.md
----

## What shipped

Cut both sync packages over to the shared wire module from the prereq ticket
(`@quereus/sync` → `src/sync/wire.ts`), deleted both local copies of the wire
codec plus the client's local message-type declarations, and added a
`protocolVersion` handshake so a client and coordinator built against different
wire versions detect the mismatch at connect time.

There is now **exactly one** wire codec and **one** set of message/`Serialized*`
types, both in `@quereus/sync`. The client and coordinator import them; their
public surfaces are unchanged (the client re-exports the same names from its
`index.ts`, the coordinator from `common/index.ts`).

`PROTOCOL_VERSION` is still `1` — no bump. This ticket establishes the field and
the check; it does not change any message payload shape beyond adding the version
field itself.

### Version semantics (strict integer equality)

- **Client → coordinator:** `sendHandshake` puts `protocolVersion: PROTOCOL_VERSION`
  in the `handshake`. The coordinator's `handleHandshake` checks it **first** —
  before the `ALREADY_AUTHENTICATED` session guard and before authenticating — so
  a mismatched peer is rejected without touching the store. Absent or
  `!== PROTOCOL_VERSION` ⇒ `sendError('PROTOCOL_VERSION_MISMATCH', …, /*fatal*/ true)`
  and `socket.close(4003, …)`.
- **Coordinator → client:** `handshake_ack` echoes `protocolVersion`. The client's
  `handleHandshakeAck` checks it first; on mismatch or absence it sets a lasting
  `error` status, flips `stopReconnect` (so auto-reconnect does **not** resume),
  rejects the pending `connect()`, and closes/detaches the socket. Reuses the same
  fatal path a `fatal: true` server error takes.
- A pre-versioning (versionless) peer is treated as **incompatible**, not silently
  accepted — that drift is exactly what this guards against. Tested in both
  directions.

## How to validate

Build order matters (`@quereus/sync` first, then client + coordinator):

```
yarn workspace @quereus/sync build
yarn workspace @quereus/sync-client build
yarn workspace @quereus/sync-coordinator build
yarn workspace @quereus/sync test              # 470 passing (incl. wire.spec.ts)
yarn workspace @quereus/sync-client test       # 52 passing
yarn workspace @quereus/sync-coordinator test  # 113 passing
```

Test-file type-checking (the mocha runner strips types, so run this too — it
catches spec-call-site signature drift):

```
yarn workspace @quereus/sync-client exec tsc --noEmit -p tsconfig.test.json
yarn workspace @quereus/sync-coordinator exec tsc --noEmit -p tsconfig.test.json
```

All of the above pass as of handoff.

### Behaviors to exercise / eyeball

- **Client** (`sync-client.spec.ts` → `protocol version handshake`): matching ack
  connects and requests changes; mismatched ack ⇒ `connect()` rejects,
  `status==='error'`, `stopReconnect===true`, `intentionalDisconnect===false`, no
  reconnect after the socket closes; absent-version ack ⇒ same fatal path. Also:
  the outgoing `handshake` carries `protocolVersion`.
- **Coordinator** (`websocket.spec.ts` → `Handshake`): mismatched version ⇒
  `PROTOCOL_VERSION_MISMATCH`, `fatal:true`, socket closes with code `4003`;
  absent version ⇒ same; valid handshake's `handshake_ack` echoes `protocolVersion`.
  Every pre-existing handshake in the spec was updated to carry the version (the
  new gate runs before the stage each of those tests targets).
- **Codec parity:** `@quereus/sync/test/wire.spec.ts` is the canonical round-trip
  suite (column/delete changes, before-image present-vs-absent, empty `priorRow`,
  blobs/bigint, snapshot chunks, tombstones, JSON hop) and stays green.

## Things to scrutinize (honest gaps)

- **No true end-to-end version-mismatch test.** The two halves are tested in
  isolation: the client half against a `MockWebSocket`, the coordinator half
  against a real `ws` client sending raw JSON. A real `SyncClient` driven against a
  live coordinator with deliberately mismatched `PROTOCOL_VERSION` is **not**
  covered. The unit halves give good confidence, but a reviewer wanting an
  integration guarantee should note this is absent. (Recorded as a coverage gap,
  not filed as a ticket — reviewer's call.)
- **Out-of-scope files touched.** The ticket's file list named only the client,
  `websocket.ts`, and `common/index.ts`. But three more coordinator files imported
  the deleted codec (or fed it `unknown`): `routes.ts`, `coordinator-service.ts`,
  `s3-snapshot-store.ts`. Repointed their imports to `../common/index.js` and added
  `as SerializedChangeSet` / `as SerializedSnapshotChunk` casts at the HTTP-body and
  S3-download JSON boundaries — the old local codecs accepted `unknown` and cast
  internally, whereas the shared codec is strictly typed. **These casts are
  unchecked**; malformed JSON flows into the (somewhat lenient) codec exactly as
  before, so no regression, but the boundary is worth a look.
- **Client self-closes the socket on ack mismatch** (`detachSocketHandlers` +
  `close()` + `this.ws = null` inside `handleHandshakeAck`). `stopReconnect` already
  guards `scheduleReconnect`, so the close is belt-and-suspenders (avoid lingering
  on an incompatible peer + skip the disconnected-status churn). Confirm this
  doesn't race the connect-promise settlement in a way the mock can't see.
- **Deleted two duplicate specs.** `quereus-sync-client/test/serialization.spec.ts`
  and `sync-coordinator/test/serialization.spec.ts` tested the codec that now lives
  solely in `@quereus/sync`, and `wire.spec.ts` already covers every case they did
  (HLC edge values live in `clock/hlc.spec.ts`). Deleted them rather than repoint
  imports at a re-export and re-run identical assertions in a package that no longer
  owns the code. Coverage moved, not lost — verify you agree.
- **Snapshot consumption unchanged (Part C).** The shared unions now type
  `resume_snapshot` / `snapshot_chunk` / `snapshot_complete` / `request_changes`,
  but the client still routes snapshot messages to `onUnhandledMessage` (host-driven
  bootstrap). No runtime change — the messages are merely typed now.

## Review findings

- Parked a coverage gap (no real client↔coordinator end-to-end version-mismatch
  test; the two halves are unit-tested separately) — see "Things to scrutinize".
  Not filed as a ticket; reviewer decides whether it warrants one.
