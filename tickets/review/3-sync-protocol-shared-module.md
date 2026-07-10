description: Review the new shared network-message-format module that the sync client and server will both use, so the two copies can no longer drift.
prereq:
files:
  - packages/quereus-sync/src/sync/wire.ts                    # NEW — the shared wire module
  - packages/quereus-sync/src/index.ts                        # wire exports added (before conflict-resolvers block)
  - packages/quereus-sync/test/wire.spec.ts                   # NEW — round-trip codec suite (20 tests)
  - packages/quereus-sync-client/src/serialization.ts         # old client codec (LEFT INTACT — reference)
  - packages/sync-coordinator/src/common/serialization.ts     # old coordinator codec (LEFT INTACT — reference)
  - packages/quereus-sync-client/src/types.ts                 # old client message unions (LEFT INTACT — reference)
difficulty: hard
----

## What landed

New module `packages/quereus-sync/src/sync/wire.ts` — the single source of truth for
the sync **transport/JSON layer**, sitting on top of the unchanged `protocol.ts` data
structures. Purely **additive**: nothing was repointed. Both old codec copies (client +
coordinator) and the old client message unions still exist and all their tests still
pass. The cutover that deletes the old copies and enforces the version handshake is the
sibling ticket `sync-protocol-migrate-and-version` (which lists this as a prereq).

`wire.ts` contains:

- **Cross-platform base64** (`bytesToBase64` / `base64ToBytes`) — btoa/atob when present,
  `Buffer` fallback otherwise. This is the client's dual-path version; the coordinator's
  old `Buffer`-only copy was the real bug (throws in a browser) and was **not** ported.
- **HLC transport helpers** (`serializeHLCForTransport` / `deserializeHLCFromTransport`) —
  were client-only; now shared.
- **Typed `Serialized*` shapes** — `SerializedChangeSet`, `SerializedChange`,
  `SerializedSchemaMigration`, and a NEW real `SerializedSnapshotChunk` discriminated union
  (the coordinator codec previously took `unknown` / returned bare `object`).
- **Codec fns** — `serializeChangeSet` / `deserializeChangeSet`,
  `serializeSnapshotChunk` / `deserializeSnapshotChunk`.
- **Message envelopes** — `ClientMessage` / `ServerMessage` as the true superset of what
  both sides emit/handle, each with a `protocolVersion: number` on the handshake pair.
- **`PROTOCOL_VERSION = 1`**.
- All of the above re-exported from `packages/quereus-sync/src/index.ts`.

## Resolved divergences (what the reviewer should sanity-check)

| Divergence | Canonical choice made |
|---|---|
| Typed vs `Record<string,unknown>` | **Typed** — codec signatures use the `Serialized*` types. |
| base64 impl | **Cross-platform** (client dual path); coordinator's Buffer-only dropped. |
| `schemaMigrations` on read | **Lenient** `?? []` — guards a malformed peer only; serializer always emits it. |
| Snapshot-chunk codec | Present (ported from coordinator, now typed). |
| HLC transport helpers | Present (ported from client). |

Present-only encodings preserved exactly from both copies:
- column before-image: `priorValue`+`priorHlc` written together, gated on `priorHlc !== undefined` — never a phantom key.
- delete before-image: `priorRow` via conditional spread so an empty array `[]` stays **present** (distinct from absent).
- tombstone chunk HLC (bigint `wallTime`) routed through `serializeHLC` — a raw bigint throws at `JSON.stringify`.

## Validation done

- `yarn workspace @quereus/sync build` — clean (strict tsc).
- `yarn workspace @quereus/sync test` — **470 passing** (includes the 20 new wire tests; the
  console noise in the run is expected error-path test output, not failures).
- `yarn workspace @quereus/sync-client build` and `@quereus/sync-coordinator build` — both
  clean, confirming **no circular dependency** and that the additive exports break nothing.

`test/wire.spec.ts` covers, as the round-trip contract:
- column change with / without `priorValue`+`priorHlc` (asserts keys **absent**, not `undefined`);
- delete with `priorRow`, with **empty** `priorRow` `[]` (asserts still present), and with none;
- change set with `schemaMigrations`, and one with the field **deleted** (asserts `→ []` lenient read);
- blob `SqlValue` (`Uint8Array`) survives via `{ __bin }`;
- HLC transport round-trip;
- base64 under **both** environments — the Buffer fallback is force-exercised by blanking `globalThis.btoa/atob`;
- every `SnapshotChunk` variant (header, table-start, column-versions, tombstone ±priorRow,
  table-end, schema-migration, footer) round-trips; tombstone asserts bigint HLC → string and
  `JSON.stringify` does not throw.

## Known gaps / things to probe (tests are a floor, not a ceiling)

- **`resume_snapshot` checkpoint is NOT JSON-safe, and is carried as-is.** `ResumeSnapshotMessage.checkpoint`
  is typed `SnapshotCheckpoint`, which holds a raw `Uint8Array` siteId and an `HLC` with a bigint
  `wallTime`. `JSON.stringify` of such a checkpoint **throws** on the bigint, and `JSON.parse`
  would not restore the `Uint8Array`. This ticket carried it as-is per its spec. It is currently a
  **dormant** path — the client never sends `resume_snapshot` today (grep: no client sender) — but it
  is broken the moment a client-side resume is wired. This is pre-existing (the coordinator already
  declares it this way), not introduced here. **Reviewer decision:** either fold a
  `SerializedSnapshotCheckpoint` into the `sync-protocol-migrate-and-version` cutover, or file a
  `debt-` ticket for it. Flagging, not hiding.
- **Base64 spread on large blobs** — `bytesToBase64` uses `String.fromCharCode(...bytes)`, which can
  exceed the JS arg-count limit on a very large blob. Fine for HLCs / typical cell blobs. Parked as a
  `NOTE:` tripwire at the call site (`wire.ts` `bytesToBase64`); both old copies had the same shape.
- **No structural validation on deserialize.** The codec trusts the `Serialized*` shape (only
  `schemaMigrations` is lenient). A genuinely malformed peer message can still throw deep in a `map`.
  The version handshake is the intended guard against real drift; deep validation is out of scope here.
- **Type-only floor for the message unions.** The envelope interfaces are exercised only by `tsc`, not
  by a runtime test — no consumer emits/parses them yet (that is the cutover ticket). The reviewer may
  want to eyeball the unions against the three source definitions (client `types.ts:124-233`,
  coordinator `websocket.ts:33-104,255-286`, client `sync-client.ts:503` `handleRequestChanges`).
- **`ts-node` type-stripping** runs the specs without a full type-check pass; the strict guarantee
  comes from the `tsc` build of `src`, not the test run.
