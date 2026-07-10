description: Build one shared copy of the network message format used by the sync client and server, so the two can no longer drift apart, and stamp it with a version number.
prereq:
files:
  - packages/quereus-sync/src/sync/wire.ts                    # NEW — shared wire module (create)
  - packages/quereus-sync/src/sync/protocol.ts                # existing pure data structures (imported, unchanged)
  - packages/quereus-sync/src/index.ts                        # add wire exports (existing exports at 55-101 / 167)
  - packages/quereus-sync/test/wire.spec.ts                   # NEW — round-trip codec tests
  - packages/quereus-sync-client/src/serialization.ts         # source of the cross-platform base64 + client codec (reference)
  - packages/sync-coordinator/src/common/serialization.ts     # source of the snapshot-chunk codec (reference)
  - packages/quereus-sync-client/src/types.ts                 # source of the typed message unions (reference)
difficulty: hard
----

## Goal

Create **one** shared wire-protocol module in `@quereus/sync`, the single source of truth
for (a) the JSON message envelopes the sync client and coordinator exchange, (b) the
base64/SqlValue codec that turns `ChangeSet`s and snapshot chunks into JSON-safe objects
and back, and (c) a `PROTOCOL_VERSION` constant. This ticket is **purely additive** — it
adds the module and exports it; no consumer is repointed yet (that is the sibling cutover
ticket `sync-protocol-migrate-and-version`, which lists this as a `prereq`). At the end of
this ticket both existing codec copies still exist and all current tests still pass.

## Background — why two copies drifted

Today the wire format lives in **two hand-maintained copies**:

- `packages/quereus-sync-client/src/serialization.ts` — `ChangeSet` codec, typed via
  `SerializedChangeSet`; cross-platform base64 (btoa/atob with a Node `Buffer` fallback);
  **no** snapshot-chunk codec; strict read of `schemaMigrations`.
- `packages/sync-coordinator/src/common/serialization.ts` — `ChangeSet` codec typed via
  `unknown`/`Record<string,unknown>`; **Node-only** base64 (`Buffer` only); **has** the
  snapshot-chunk codec; lenient read of `schemaMigrations` (`|| []`).

And the message-type unions live in a third place
(`packages/quereus-sync-client/src/types.ts`: `ClientMessage`/`ServerMessage`) that is
already **missing** messages the coordinator actually sends (`resume_snapshot`,
`snapshot_chunk`, `snapshot_complete`) and one the client actually dispatches
(`request_changes`, handled at `sync-client.ts:324`). There is no version anywhere.

## Module boundary

`protocol.ts` already holds the **transport-agnostic data structures** (`ChangeSet`,
`Change`, `SchemaMigration`, `SnapshotChunk` and friends). Keep it exactly as-is. Add a
**new** sibling `wire.ts` for the **transport/JSON** layer that imports from `protocol.ts`:

```
protocol.ts   (data structures — unchanged)
     ▲
     │ imports
wire.ts        (base64 helpers, Serialized* types, codec fns, message unions, PROTOCOL_VERSION)
     ▲
     │ re-exported by
index.ts
```

Both `@quereus/sync-client` and `@quereus/sync-coordinator` already declare
`@quereus/sync` as a dependency, so consuming `wire.ts` from either introduces **no**
circular dependency. `@quereus/sync` itself must **not** import from client or coordinator.

## What `wire.ts` must contain

### 1. Cross-platform base64 helpers

Port the **client's** dual-path helpers (`bytesToBase64` / `base64ToBytes` at
`serialization.ts:33-52`) — btoa/atob when present, `Buffer` fallback otherwise. **Do not**
port the coordinator's `Buffer`-only version: `@quereus/sync` runs in the browser and a
`Buffer`-only path breaks a browser client. This is a real resolved divergence, not a
style choice — note it in a code comment.

### 2. Serialized (JSON-shape) types — typed, not `unknown`

Move the typed serialized shapes into `wire.ts` and make them the canonical types:

```ts
export interface SerializedChangeSet {
  siteId: string;
  transactionId: string;
  hlc: string;                         // base64 of serializeHLC
  changes: SerializedChange[];
  schemaMigrations: SerializedSchemaMigration[];
}
export interface SerializedChange {
  type: 'column' | 'delete';
  schema: string;
  table: string;
  pk: unknown[];                       // encodeSqlValue per cell
  column?: string;
  value?: unknown;
  hlc: string;
  priorValue?: unknown;                // column: present iff priorHlc
  priorHlc?: string;                   // column: present iff priorValue
  priorRow?: unknown[];                // delete: present-only ([] is present)
}
export interface SerializedSchemaMigration {
  type: string; schema: string; table: string; ddl: string; hlc: string; schemaVersion: number;
}
```

Add a `SerializedSnapshotChunk` type (currently the coordinator codec returns bare
`object` / takes `unknown` — replace that with a real type). Model it on the discriminated
`SnapshotChunk` union in `protocol.ts`, with the binary fields (`siteId`, `hlc`, blob
`SqlValue`s) as their base64/tagged JSON shapes. The `resume_snapshot` checkpoint shape
(`SnapshotCheckpoint`, already exported from `@quereus/sync`) is carried as-is.

### 3. Codec functions

Move (as the canonical implementations) and reconcile the divergences:

- `serializeChangeSet(cs: ChangeSet): SerializedChangeSet`
- `deserializeChangeSet(obj: SerializedChangeSet): ChangeSet`
- `serializeSnapshotChunk(chunk: SnapshotChunk): SerializedSnapshotChunk`
- `deserializeSnapshotChunk(obj: SerializedSnapshotChunk): SnapshotChunk`
- `serializeHLCForTransport(hlc: HLC): string` / `deserializeHLCFromTransport(str): HLC`
  (the client-only helpers at `serialization.ts:168-180` — the coordinator lacks them; the
  shared module must have them).

**Resolved divergences (canonical behavior):**

| Divergence | Canonical choice |
|---|---|
| Typed vs `Record<string,unknown>` | **Typed** — codec signatures use the `Serialized*` types. |
| base64 impl | **Cross-platform** (client's dual path). |
| `schemaMigrations` on read | **Lenient**: default to `[]` when absent (`?? []`). Serializer always emits it (`ChangeSet.schemaMigrations` is required), so this only guards a malformed peer — cheap Postel, and drift is now caught by the version handshake anyway. |
| Snapshot-chunk codec | Present (from coordinator copy). |
| HLC transport helpers | Present (from client copy). |

Preserve the delicate present-only encodings exactly as both copies already do them:
`priorValue`+`priorHlc` written together, gated on `priorHlc !== undefined` (never a phantom
key); `priorRow` conditional spread so an empty array stays present (`[] !== undefined`).
The `tombstone` snapshot chunk MUST route its `hlc` (a bigint `wallTime`) through
`serializeHLC` — a raw bigint throws at `JSON.stringify`.

### 4. Message unions + `PROTOCOL_VERSION`

Define the canonical unions as the **true superset** of what both sides emit/handle:

- `ClientMessage`: `handshake` (now with `protocolVersion: number`), `get_changes`,
  `apply_changes`, `get_snapshot`, `resume_snapshot`, `ping`.
- `ServerMessage`: `handshake_ack` (now with `protocolVersion: number`; keep the
  `databaseId` the coordinator already sends, as optional), `changes`, `push_changes`,
  `apply_result`, `snapshot_chunk`, `snapshot_complete`, `request_changes`, `error`,
  `pong`.

Enumerate each interface from the existing definitions: client unions in
`quereus-sync-client/src/types.ts:124-233`, plus `resume_snapshot`/`snapshot_chunk`/
`snapshot_complete` from `sync-coordinator/src/server/websocket.ts:33-104,255-286`, plus
`request_changes` from `sync-client.ts:324` (read `handleRequestChanges` for its shape).

Add:

```ts
/** Wire protocol version. Bump on ANY breaking change to message shapes or codec.
 *  NOTE: strict integer equality today (see handshake). If rolling/mixed-version
 *  upgrades ever become a requirement, widen to a {min,max}-supported range and
 *  negotiate — do not silently accept a mismatch. */
export const PROTOCOL_VERSION = 1;
```

### 5. index.ts exports

Export everything new from `packages/quereus-sync/src/index.ts` alongside the existing
`./sync/protocol.js` block (see lines 55-101). Export the `Serialized*` types, the codec
functions, the message unions + per-message interfaces, and `PROTOCOL_VERSION`.

## Tests (`wire.spec.ts`)

Round-trip is the contract; write it as such:

- `serializeChangeSet` → `deserializeChangeSet` is identity for: a column change with
  `priorValue`/`priorHlc`; a column change **without** them (assert the keys are absent,
  not `undefined`); a delete with `priorRow`; a delete with **empty** `priorRow` `[]`
  (assert still present after round-trip); a delete with **no** `priorRow`; a change set
  with `schemaMigrations`, and one deserialized from an object with `schemaMigrations`
  **omitted** (assert `→ []`, lenient read).
- Blob `SqlValue` (`Uint8Array`) survives round-trip via the tagged `{ __bin }` encoding.
- HLC round-trip (`serializeHLCForTransport`/`deserializeHLCFromTransport`) and the
  base64 helpers under **both** environments — exercise the `Buffer` fallback explicitly
  (the browser btoa/atob path is the default under the test runtime; add a case that
  forces the Buffer path).
- Every `SnapshotChunk` variant (`header`, `table-start`, `column-versions`, `tombstone`
  with and without `priorRow`, `table-end`, `schema-migration`, `footer`) round-trips;
  assert the `tombstone` bigint HLC serializes to a string (no `JSON.stringify` throw).

## Edge cases & interactions

- **Browser vs Node base64** — the whole reason the coordinator copy was wrong; the shared
  helper must work in both. Force-test the `Buffer` fallback.
- **Present-only fields** — `priorValue`/`priorHlc` both-or-neither; `priorRow` empty-array
  present vs absent. A regression here silently corrupts before-images.
- **`schemaMigrations` absent** — lenient `?? []`; do not throw.
- **bigint in tombstone HLC** — must go through `serializeHLC` or `JSON.stringify` throws.
- **Unknown/no-binary chunk types** (`table-start`, `table-end`, `footer`) — pass through
  without touching binary fields; don't drop unknown keys.
- **No new circular dep** — `wire.ts` imports only from `protocol.ts`/`clock`/`@quereus/quereus`;
  `@quereus/sync` must not import client/coordinator. Verify `yarn build` order stays clean.
- **Additive only** — both old codec copies remain after this ticket; existing client and
  coordinator tests must still pass unchanged (`yarn test`).

## TODO

- Add `packages/quereus-sync/src/sync/wire.ts` with base64 helpers, `Serialized*` types
  (incl. `SerializedSnapshotChunk`), codec fns, message unions, `PROTOCOL_VERSION`.
- Reconcile the divergences per the table above; preserve present-only encodings exactly.
- Export the new surface from `packages/quereus-sync/src/index.ts`.
- Add `packages/quereus-sync/test/wire.spec.ts` round-trip suite.
- `yarn workspace @quereus/sync build` + `yarn test` green; leave both old copies intact.
