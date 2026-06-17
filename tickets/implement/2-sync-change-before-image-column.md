description: Carry the value a write overwrote (plus when it was written) alongside each synced column change, so a receiving replica can see what changed from what — for audit trails, undo, and conflict debugging — without a separate lookup.
prereq:
files:
  - packages/quereus-sync/src/sync/protocol.ts                  # ColumnChange, ConflictContext
  - packages/quereus-sync/src/metadata/column-version.ts        # ColumnVersion type + (de)serialization
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # recordColumnVersions, resolveLogEntry, collectAllChanges
  - packages/quereus-sync/src/sync/change-applicator.ts         # resolveChange (ConflictContext/ConflictEvent), commitColumnMetadata
  - packages/quereus-sync/src/sync/events.ts                    # ConflictEvent
  - docs/sync.md                                                # § Data Structures, § Reactive Hooks
  - packages/quereus-sync/test/metadata/column-version.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - packages/quereus-sync/test/sync/conflict-resolvers.spec.ts
difficulty: medium
----

# Inline before-image on `ColumnChange`

Add an **optional** per-cell before-image to the sync wire, mirroring Lamina's
`UpdateCellFact(new_value, prior_value?, prior_hlc?)`:

```ts
interface ColumnChange {
  // …existing: type, schema, table, pk, column, value, hlc…
  readonly priorValue?: SqlValue;   // the cell value this write overwrote at the origin
  readonly priorHlc?: HLC;          // HLC of the overwritten cell version (disambiguates equal-HLC sites)
}
```

Purely additive: producers may omit it, receivers ignore it when absent, and the
no-`conflictResolver` HLC fast path is unchanged.

## Key design decision — it must be *persisted*, not just emitted live

The raw before-image (`oldRow` / `oldVersion`) is available for free at record
time, but the live `LocalChangeEvent.changes` array built in
`recordColumnVersions` **never crosses the wire**. Actual cross-replica sync
flows through `getChangesSince → collectChangesSince/collectAllChanges →
resolveLogEntry`, which **re-resolves each change from the persisted
`ColumnVersionStore`** (`sync-manager-impl.ts:607`). So for a receiver to ever
see the before-image, it has to be stored on the cell version.

This stays "no extra read cost" (the ticket's framing): `recordColumnVersions`
already reads `oldVersion` before overwriting (`sync-manager-impl.ts:448`), and
the apply path already carries `resolved.oldColumnVersion`
(`change-applicator.ts:395`). The only new cost is **storage** — one extra
value+HLC per cell version. That is exactly Lamina's per-cell prior, and Quereus
has no content-hash/immutability obligation, so it is a best-effort hint.

### Source of the prior = the prior **CRDT cell version**, not `oldRow[i]`

Use `oldVersion` / `oldColumnVersion` (`{ hlc, value }`) as the before-image, not
the engine's `oldRow[i]`. `oldRow` has no HLC and can diverge from the CRDT cell
lineage; `priorValue`/`priorHlc` must be the cell's prior *tracked* version so it
matches `value`/`hlc` semantically (the Lamina `(prior_value, prior_hlc)` pair).
On the very first write of a cell there is no prior version → omit both fields.

## Extend `ColumnVersion` persistence

```ts
interface ColumnVersion {
  hlc: HLC;
  value: SqlValue;
  priorHlc?: HLC;       // hlc of the version this one replaced
  priorValue?: SqlValue;// value of the version this one replaced
}
```

- `serializeColumnVersion` / `deserializeColumnVersion` (`column-version.ts:29`):
  back-compat is **not** required (AGENTS.md), so the format may change freely —
  but deserialize must tolerate the prior fields being **absent** (snapshot-loaded
  cells and first-writes have none). Recommended layout: keep the 30-byte HLC
  prefix for `hlc`, then JSON-encode `{ v, pv?, ph? }` where `v`/`pv` go through
  the existing `encodeSqlValue`/`decodeSqlValue` (so `Uint8Array`/`bigint` priors
  round-trip) and `ph` is the prior HLC (e.g. base64 of `serializeHLC`). Final
  shape is the implementer's call — just keep it self-describing and
  absent-tolerant.

## Producer plumbing

- `recordColumnVersions` (`sync-manager-impl.ts:424`): when `oldVersion` exists,
  set `priorHlc: oldVersion.hlc`, `priorValue: oldVersion.value` on **both** the
  persisted `ColumnVersion` and the inline `ColumnChange` pushed to `changes`.
- `resolveLogEntry` column branch (`sync-manager-impl.ts:608`): copy
  `cv.priorValue`/`cv.priorHlc` onto the resolved `ColumnChange` (spread only when
  present — do not emit explicit `undefined`).
- `collectAllChanges` cv branch (`sync-manager-impl.ts:668`): same copy from the
  deserialized `cv`.
- `commitColumnMetadata` (`change-applicator.ts:511`): persist
  `priorHlc`/`priorValue` from `oldColumnVersion` onto the new `ColumnVersion`, so
  receivers build the same prior chain and re-relay it.

## Conflict-context enrichment (delivers the "validate against source's prior" use)

Add optional fields carrying the **incoming** change's before-image so a custom
resolver / transition validator can see the origin's prior state. This does
**not** change resolution logic.

```ts
interface ConflictContext { /* …existing… */
  readonly remotePriorValue?: SqlValue;
  readonly remotePriorHlc?: HLC;
}
interface ConflictEvent { /* …existing… */
  readonly remotePriorValue?: SqlValue;
  readonly remotePriorHlc?: HLC;
}
```

- `resolveChange` (`change-applicator.ts:337`): pass `change.priorValue` /
  `change.priorHlc` into the `ConflictContext` and into both
  `emitConflictResolved` calls (local-wins and remote-wins). Keep the fast path
  (no resolver, prior absent) byte-identical.
- Do **not** use the before-image to populate the receiver's own `localValue` or
  to skip the `getColumnVersion` read — that "skip the re-read" optimization is
  out of scope and risks regressing the fast path. The receiver's `localValue`
  stays its own read; the before-image is exposed for the resolver/validator to
  use, nothing more.

## Edge cases & interactions

- **First write of a cell** (`!oldVersion`): both prior fields omitted on wire and
  in storage. Assert the serialized `ColumnChange` has no `priorValue`/`priorHlc`
  keys (absent, not `undefined`/`null`) — JSON transports must not carry phantom
  nulls.
- **In-batch dedup** (`commitChangeMetadata` `keepMaxHLC`,
  `change-applicator.ts:435`): when two versions of one cell land in a single
  `applyChanges`, both Phase-1-resolved against the **same pre-batch** prior. The
  surviving winner's `oldColumnVersion` is that pre-batch version — so
  `priorHlc`/`priorValue` must reference the pre-batch prior, never an in-batch
  loser. Add a test for two stacked column writes to one pk in one batch.
- **Repeated local overwrites before a pull**: the change-log keeps one entry per
  cell; its `cv.prior` is the *immediately* overwritten version, i.e. "what the
  winning write overwrote" — **not** "the value at last sync". This is the
  intended Lamina semantics; document it so it is not mistaken for a bug.
- **Snapshot load**: `ColumnVersionEntry` and the streaming
  `[versionKey, HLC, SqlValue]` tuples carry only `(hlc, value)`; reconstructed
  cell versions have no prior, which is correct (a snapshot is a fresh basis with
  no history). Deserialize of a prior-less record must succeed.
- **`Uint8Array` / `bigint` prior values**: must round-trip through
  `encodeSqlValue`/`decodeSqlValue` exactly like `value` does.
- **Equal-HLC sites**: `priorHlc` is informational disambiguation only; no
  resolution logic keys off it. Just verify it survives the round-trip.
- **Existing `onConflictResolved` listeners**: the new `ConflictEvent` fields are
  optional and additive — confirm existing consumers/tests still typecheck and
  pass unchanged.
- **Relay through a receiver**: a receiver that persists prior via
  `commitColumnMetadata` and later serves `getChangesSince` must re-emit the prior
  it stored (origin's prior chain is preserved, not reset to the receiver's HLC).

## TODO

### Phase 1 — types & persistence
- Add `priorValue?`/`priorHlc?` to `ColumnChange` and `remotePriorValue?`/
  `remotePriorHlc?` to `ConflictContext` (`protocol.ts`) and `ConflictEvent`
  (`events.ts`).
- Extend `ColumnVersion` with `priorHlc?`/`priorValue?` and update
  `serializeColumnVersion`/`deserializeColumnVersion` (absent-tolerant).

### Phase 2 — producer & apply plumbing
- `recordColumnVersions`: set prior on persisted version + inline `ColumnChange`.
- `resolveLogEntry` + `collectAllChanges`: copy prior onto resolved `ColumnChange`.
- `commitColumnMetadata`: persist prior from `oldColumnVersion`.
- `resolveChange`: pass `change.priorValue`/`priorHlc` into `ConflictContext` and
  both `emitConflictResolved` calls.

### Phase 3 — tests & docs
- `column-version.spec.ts`: serialize/deserialize round-trip with and without
  prior, including `Uint8Array`/`bigint` prior values.
- `sync-protocol-e2e.spec.ts`: two-site round-trip — overwrite a cell on site A,
  pull via `getChangesSince`, assert the received `ColumnChange` carries the
  expected `priorValue`/`priorHlc`; assert a first-insert carries neither.
- `conflict-resolvers.spec.ts`: a resolver observes `remotePriorValue`/
  `remotePriorHlc`; fast-path (no resolver) behavior unchanged.
- Update `docs/sync.md` § Data Structures (`ColumnChange`) and § Reactive Hooks
  (`ConflictEvent`); note the per-cell prior is best-effort and the "no re-read"
  optimization is intentionally not taken.
- Run `yarn workspace @quereus/quereus-sync test` and `yarn lint`; stream output
  with `tee`.
