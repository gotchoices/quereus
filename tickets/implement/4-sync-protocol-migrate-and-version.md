description: Delete the two drifted copies of the network message format and point both the sync client and server at the single shared copy, then have them exchange and check a version number when they connect so a mismatch fails loudly instead of silently misbehaving.
prereq: sync-protocol-shared-module
files:
  - packages/quereus-sync-client/src/serialization.ts       # DELETE local codec
  - packages/quereus-sync-client/src/types.ts               # remove message unions + Serialized* (keep client-only options)
  - packages/quereus-sync-client/src/sync-client.ts         # import shared codec; send + check protocolVersion
  - packages/quereus-sync-client/src/index.ts               # re-export codec/types from @quereus/sync (keep public API stable)
  - packages/sync-coordinator/src/common/serialization.ts   # DELETE local codec
  - packages/sync-coordinator/src/common/index.ts           # re-export codec from @quereus/sync
  - packages/sync-coordinator/src/server/websocket.ts       # remove local message interfaces; validate protocolVersion
  - docs/sync.md
  - docs/sync-coordinator.md
difficulty: hard
----

## Goal

Cut both packages over to the shared wire module from `sync-protocol-shared-module`
(`@quereus/sync` → `wire.ts`), **delete** both local codec copies and the client's local
message unions, and add a **`protocolVersion` handshake** so a client and coordinator built
against different protocol versions detect the mismatch at connect time instead of silently
misinterpreting each other.

This is the atomic cross-package cutover: a half-migrated tree (client sends a version the
coordinator doesn't read, or one side on the shared codec and the other not) is a broken
wire. Land it in one change and validate end-to-end.

## Part A — codec + type unification

**Client:**

- Delete `packages/quereus-sync-client/src/serialization.ts`. Its four exports
  (`serializeChangeSet`, `deserializeChangeSet`, `serializeHLCForTransport`,
  `deserializeHLCFromTransport`) are re-exported from the client's `index.ts` (see
  `index.ts:33`) — repoint those re-exports to `@quereus/sync` so the client's public API
  stays identical. Update `sync-client.ts:35` imports accordingly.
- In `types.ts`, delete `ClientMessage`/`ServerMessage` and every per-message interface
  (`HandshakeMessage`…`PongMessage`, lines 124-233) and the `Serialized*` types
  (lines 243-271). Re-export them from `@quereus/sync` instead (keep `index.ts:37-59`'s
  named type re-exports resolving). **Keep** the genuinely client-only types in `types.ts`:
  `SyncStatus`, `SyncEvent*`, `SyncClientOptions`.

**Coordinator:**

- Delete `packages/sync-coordinator/src/common/serialization.ts`; repoint
  `common/index.ts:15-20` to re-export the four codec fns from `@quereus/sync`.
- In `server/websocket.ts`, delete the local `HandshakeMessage`…`ClientMessage` interfaces
  (lines 24-64) and import the shared unions from `@quereus/sync`. The handler switch
  (lines 106-135) stays.

After this part, exactly **one** codec and **one** set of message types exist, both in
`@quereus/sync`.

## Part B — `protocolVersion` handshake

**Semantics (resolved — strict integer equality):**

- Client sends `protocolVersion: PROTOCOL_VERSION` in its `handshake`
  (`sync-client.ts:sendHandshake`, ~524).
- Coordinator, in `handleHandshake` (`websocket.ts:148`), reads it **before** authenticating.
  If it is absent or `!== PROTOCOL_VERSION`, reject: `sendError('PROTOCOL_VERSION_MISMATCH',
  <message naming both versions>, /*fatal*/ true)` and `socket.close(...)`. A pre-versioning
  (versionless) peer is treated as incompatible — that is exactly the drift this guards
  against; do not silently accept it.
- Coordinator echoes `protocolVersion: PROTOCOL_VERSION` in `handshake_ack`
  (`websocket.ts:183`).
- Client, in `handleHandshakeAck` (`sync-client.ts:369`), checks the ack's `protocolVersion`.
  On mismatch (or absent — old coordinator), set a lasting `error` status and stop
  reconnecting (reuse the fatal-error path that sets `stopReconnect`; see `handleServerError`
  ~346). Surface a clear message.

Rationale for strict-equal over min/max negotiation: all sync packages are lockstep-versioned
in one monorepo (currently `4.3.1`), the repo's stance is "backwards compat: don't worry yet",
and negotiation machinery is premature. The `PROTOCOL_VERSION` constant already carries a
`NOTE:` tripwire (added in the prereq ticket) describing the range-negotiation upgrade path if
rolling upgrades ever become a real requirement — do not build it now.

## Part C — message-union completeness

The shared unions (from the prereq) already include `resume_snapshot`, `snapshot_chunk`,
`snapshot_complete`, and `request_changes`. Adopting them makes previously-`default`-routed
messages typed. **Preserve existing runtime behavior**: the client currently routes snapshot
messages to `onUnhandledMessage` (host-driven bootstrap, `sync-client.ts:329-331`) — keep
that routing; the messages are now merely typed, not newly handled. Do not change how
snapshots are consumed in this ticket.

## Docs

Update the WS handshake description in `docs/sync-coordinator.md` (§ around lines 209-227:
the `{ type: "handshake", ... }` / `handshake_ack` shapes) to include `protocolVersion` and
the mismatch/close behavior. Add a short "Protocol version" note to `docs/sync.md`. No new
summary docs — edit the existing ones.

## Edge cases & interactions

- **Version absent** (pre-versioning client or server) → treated as mismatch → fatal reject
  on the coordinator; lasting `error` + stop-reconnect on the client. Test both directions.
- **Client stops reconnecting on fatal mismatch** — confirm the `stopReconnect` path fires
  and auto-reconnect does not resume (existing fatal-error test harness in
  `sync-client.spec.ts` covers the mechanism).
- **`handshake_ack` still carries `databaseId`** — the coordinator sends it (`websocket.ts:185`);
  keep it optional in the shared type; client ignores it as today.
- **`ALREADY_AUTHENTICATED` / ordering** — version check goes *before* auth and before the
  existing `session` guard so a mismatched peer is rejected without touching the store.
- **Public API stability** — client `index.ts` must still export the same codec fn + type
  names (now re-exported from `@quereus/sync`); a consumer importing `serializeChangeSet`
  from `@quereus/sync-client` must keep compiling. Grep consumers before deleting.
- **Coordinator `common/index.ts` consumers** — `websocket.ts` imports the codec via
  `../common/index.js`; the re-export must keep resolving.
- **No behavior change to snapshot consumption** — `onUnhandledMessage` routing preserved.
- **Build order** — `@quereus/sync` builds before client and coordinator (sequential
  `yarn build`); the deletions must not leave a dangling import mid-build.

## TODO

**Part A — unify**
- Delete client `serialization.ts`; repoint client `index.ts` codec re-exports to `@quereus/sync`.
- Strip message unions + `Serialized*` from client `types.ts`; re-export from `@quereus/sync`; keep `SyncStatus`/`SyncEvent*`/`SyncClientOptions`.
- Delete coordinator `common/serialization.ts`; repoint `common/index.ts`.
- Remove local message interfaces from coordinator `websocket.ts`; import shared unions.

**Part B — version**
- Client `sendHandshake`: add `protocolVersion: PROTOCOL_VERSION`.
- Coordinator `handleHandshake`: reject absent/mismatched version (fatal + close) before auth.
- Coordinator `handshake_ack`: echo `protocolVersion`.
- Client `handleHandshakeAck`: check version; on mismatch → lasting error + stop reconnect.

**Part C — docs + validation**
- Update `docs/sync-coordinator.md` handshake section + `docs/sync.md`.
- `yarn build` + `yarn test` green across `@quereus/sync`, `@quereus/sync-client`,
  `@quereus/sync-coordinator`. Add client + coordinator tests: version-match connects;
  version-mismatch and version-absent each rejected as specified.
