description: When changes travel through the sync coordinator between browsers, the extra "what the value was before" audit/undo information is silently dropped, so receivers on that path never see it.
prereq:
files:
  - packages/quereus-sync-client/src/serialization.ts          # serializeChangeSet/deserializeChangeSet — drops before-image
  - packages/sync-coordinator/src/common/serialization.ts      # same JSON (de)serializer on the coordinator side
  - packages/quereus-sync/src/sync/protocol.ts                  # ColumnChange.priorValue/priorHlc + RowDeletion.priorRow (source of truth)
  - packages/quereus-sync/src/metadata/column-version.ts        # encodeSqlValue/decodeSqlValue + hlcToJson/hlcFromJson (reuse for payload)
difficulty: medium
----

# Before-image fields are dropped by the JSON wire transport

Two completed features add an optional **before-image** to synced changes:

- `sync-change-before-image-column` — per-cell `priorValue` / `priorHlc` on a `ColumnChange`.
- `sync-change-before-image-delete` — last-known row image `priorRow` on a `RowDeletion`.

Both let a receiver show or undo *what was removed/replaced* (audit/undo) without
reconstructing it. They work **in-process** and across the `getChangesSince`
re-resolution path (both are persisted on the CRDT metadata — `ColumnVersion` and
`Tombstone` respectively — and round-trip through the quarantine serializer).

## The gap

The JSON transport (de)serializers used by the **coordinator-mediated** path —
`serializeChangeSet` / `deserializeChangeSet` in both
`packages/quereus-sync-client/src/serialization.ts` and
`packages/sync-coordinator/src/common/serialization.ts` — only emit
`type / schema / table / pk / hlc` (plus `column / value` for column changes).
They silently omit **every** before-image field. So in a real
browser ↔ coordinator ↔ browser deployment, the before-image survives in-process
and via local re-resolution but **does not cross the JSON boundary** — which for a
coordinator-mediated topology is the primary delivery path. This materially limits
the audit/undo feature over the wire.

This is a pre-existing gap, not a regression: the column ticket's review never
noticed it (it only fixed the *quarantine* serializer), and the delete ticket's
review confirmed it spans both serializers and both features.

## Expected behavior

Both JSON serializers carry the before-image through, present-only (never leaking a
phantom `undefined`/`null` key — matching the conditional-spread discipline used
everywhere else):

- `ColumnChange`: `priorValue` (via `encodeSqlValue`/`decodeSqlValue`) and
  `priorHlc` (via `hlcToJson`/`hlcFromJson`, base64-HLC, or the file's existing HLC
  encoding — whichever matches the surrounding code), written together or not at all.
- `RowDeletion`: `priorRow` as an array of `encodeSqlValue`-encoded cells, so
  `Uint8Array`/`bigint`/`null` round-trip; absent when the deletion carried none.

Keep the two serializers in lockstep (they are near-duplicate implementations — a
shared helper would be ideal but is not required). Add round-trip tests on both
covering: absent before-image stays absent (not `undefined`), present column prior
round-trips incl. `Uint8Array`/`bigint`, and a delete `priorRow` round-trips incl.
`Uint8Array`/`bigint`/`null` and the empty-array (`[]`) present-vs-absent boundary.
