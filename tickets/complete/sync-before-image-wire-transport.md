description: The "what the value was before" audit/undo info now travels across the JSON wire used between browsers via the sync coordinator, and was reviewed to confirm it round-trips faithfully and only when actually present.
prereq:
files:
  - packages/quereus-sync-client/src/serialization.ts          # client serializeChangeSet/deserializeChangeSet — carry before-image
  - packages/quereus-sync-client/src/types.ts                  # SerializedChange — priorValue?/priorHlc?/priorRow?
  - packages/quereus-sync-client/test/serialization.spec.ts    # before-image round-trip tests (hardened in review)
  - packages/sync-coordinator/src/common/serialization.ts      # coordinator serializeChangeSet/deserializeChangeSet — lockstep
  - packages/sync-coordinator/test/serialization.spec.ts       # before-image round-trip tests (hardened in review)
  - packages/quereus-sync/src/sync/protocol.ts                  # ColumnChange.priorValue/priorHlc + RowDeletion.priorRow (source of truth)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # producers — write prior fields together / present-only
  - packages/quereus-sync/src/sync/change-applicator.ts         # producers (apply path) — same
difficulty: medium
----

# Review complete: carry the before-image through the JSON wire transport

The two JSON wire (de)serializers (client `quereus-sync-client` and
`sync-coordinator`) now carry the optional before-image — `ColumnChange.priorValue`/
`priorHlc` and `RowDeletion.priorRow` — across the coordinator-mediated
(browser ↔ coordinator ↔ browser) path, with present-only discipline. The
implementation faithfully mirrors the established quarantine / tombstone /
column-version serializers. Reviewed adversarially; minor test gaps fixed inline;
no major findings.

## Review findings

### Checked — and what was found

- **Round-trip fidelity (both serializers).** Faithful in both directions: column
  `priorValue` rides `encodeSqlValue`/`decodeSqlValue`, `priorHlc` rides the same
  base64-binary HLC codec as `hlc` (`serializeHLC`+base64), delete `priorRow` maps
  each cell through `encodeSqlValue`/`decodeSqlValue`. `Uint8Array`/`bigint`/`null`
  cells survive. No defect.
- **Present-only discipline.** The conditional-spread gates are correct in both
  directions: column gates on `priorHlc !== undefined`, delete on
  `priorRow !== undefined`. Absent stays absent (no phantom `undefined` key);
  empty-array `priorRow: []` stays *present*. Both boundaries asserted on the
  serialized object **and** the deserialized change. No defect.
- **Producer contract (`priorHlc` present iff `priorValue`; `priorRow` present-only).**
  The wire gate leans on this. Verified it holds at every producer —
  `sync-manager-impl.ts` (`recordColumnVersions`, the delete path, `collectChangesSince`,
  `collectAllChanges`) and `change-applicator.ts` (`commitColumnMetadata`,
  `commitDeleteMetadata`): every site spreads the prior fields together / present-only.
  The `priorValue ?? null` coercion on serialize matches `serializeColumnVersion`
  and only fires under a contract violation that no producer produces. Sound.
- **Scope completeness.** Grep confirmed **exactly two** JSON `serializeChangeSet`/
  `deserializeChangeSet` definitions in `src/` (the two this ticket touched). All wire
  call sites — `coordinator-service.ts`, `websocket.ts`, `routes.ts`, `sync-client.ts`
  — route through them, so the coordinator relay (deserialize → re-serialize) now
  preserves the before-image too. No third wire path was missed.
- **Lockstep duplication.** Diffed the two `serializeChangeSet`/`deserializeChangeSet`
  bodies: byte-for-byte logic-identical, differing only in base64 plumbing
  (`bytesToBase64` vs `Buffer`). The documented maintenance risk (they must stay in
  lockstep) is real but the duplication is justified — they live in separate packages
  with genuinely different base64 helpers. No action.
- **`opSeq` fidelity.** `serializeHLC`/`deserializeHLC` round-trip the full 30-byte
  HLC including `opSeq` (u32 at offset 26), so the before-image HLC's sub-order
  survives. Was implicit; now explicitly asserted (see fixes).
- **Type safety.** Client fully typed (`SerializedChange` extended with the three
  optional fields); coordinator untyped-by-file-convention (`Record<string, unknown>`
  + casts). Consistent with each file's existing posture.
- **Docs.** `docs/sync.md` already documents the before-image at the protocol/storage
  level and states it "survives re-emission/relay" (lines 597-599). That was
  aspirationally true but actually **false** for the JSON coordinator path until this
  ticket — the change closes the gap to match the docs rather than making any doc
  stale. No field-level JSON-wire enumeration exists to update. No doc change needed.

### Found and fixed (minor, inline this pass)

- **Tests never crossed an actual `JSON.stringify`/`parse`.** The round-trip tests
  serialized → deserialized on an in-process object, so a value that slipped through
  *unencoded* (a raw `bigint`/`Uint8Array`) would pass in-process yet throw or corrupt
  on the real wire. Routed both data-carrying tests (column before-image, delete
  `priorRow`) through `JSON.parse(JSON.stringify(serializeChangeSet(cs)))` in **both**
  spec files — the real wire hop.
- **`opSeq` on the before-image HLC was set in the fixture but never asserted.** Added
  an explicit `priorHlc.opSeq` assertion in both packages' column test.

Both suites re-run green after the fixes.

### Major findings → new tickets

None. The implementation is correct, complete, and scoped; the gaps below are
deliberate non-actions, not deferrals of required work.

### Observed, not actioned (pre-existing posture / accepted gap — with reason)

- **No true end-to-end client → coordinator → client integration test** asserting a
  receiver's `applyChanges` sees the before-image. Not filed: the unit round-trip on
  both wire halves **plus** the added real-JSON pass is a strong proxy for best-effort
  additive metadata, and the coordinator relay path is already covered by existing
  integration tests. Filing a major ticket would over-weight best-effort audit data.
- **Untyped coordinator `deserialize` casts** (`c.priorHlc as string`, etc.) trust the
  wire shape — a malformed payload throws inside `decodeSqlValue`/`deserializeHLC`
  rather than being rejected cleanly. Pre-existing posture for that whole file;
  unchanged here.
- **Coordinator test fixture's `makeTestChangeSet`** builds `schemaMigrations` with
  `type:'create-table'`/`sql:` (cast `as SchemaMigration`), not the protocol's
  `create_table`/`ddl`. Pre-existing latent inconsistency; the before-image tests don't
  touch `schemaMigrations`, so it's untouched and out of scope.

## Validation

- `yarn workspace @quereus/sync-client run typecheck` — clean
- `yarn workspace @quereus/sync-coordinator run typecheck` — clean
- `yarn workspace @quereus/sync-client test` — **49 passing**
- `yarn workspace @quereus/sync-coordinator test` — **125 passing**

(No `lint` script exists for these two packages — only `packages/quereus` has one;
`typecheck` is the equivalent gate and passes.)
