description: A write now remembers the value it overwrote (and when), and carries that "before" snapshot alongside each synced column change, so a receiving replica can see what changed from what without a separate lookup.
prereq:
files:
  - packages/quereus-sync/src/sync/protocol.ts                  # ColumnChange.priorValue/priorHlc, ConflictContext.remotePrior*
  - packages/quereus-sync/src/sync/events.ts                    # ConflictEvent.remotePrior*
  - packages/quereus-sync/src/metadata/column-version.ts        # ColumnVersion.priorHlc/priorValue + (de)serialize
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # recordColumnVersions, resolveLogEntry, collectAllChanges
  - packages/quereus-sync/src/sync/change-applicator.ts         # commitColumnMetadata, resolveChange enrichment
  - packages/quereus-sync/src/metadata/quarantine.ts            # before-image fidelity on quarantined wire Change (review fix)
  - packages/quereus-sync/test/metadata/quarantine.spec.ts      # new — quarantine round-trip (review fix)
  - docs/sync.md                                                # § Data Structures, § Pluggable Conflict Resolution, § Reactive Hooks
difficulty: medium
----

# Inline per-cell before-image on `ColumnChange` — COMPLETE

An optional, purely-additive per-cell **before-image** mirroring Lamina's
`UpdateCellFact(new_value, prior_value?, prior_hlc?)`. A write records the cell
version it overwrote, and that `(priorValue, priorHlc)` pair rides on the synced
`ColumnChange` and is surfaced to conflict resolvers/events — for audit trails,
undo, and conflict debugging — without a second lookup. Absent on first writes and
snapshot-reconstructed cells; the no-resolver / no-prior HLC fast path is unchanged.

See the implement-stage handoff (commit `53808460`) for the full design narrative
and the validation matrix. This file records the review pass.

## Review findings

### Scope reviewed
Read the implement diff with fresh eyes before the handoff summary, then traced
every producer/consumer of `ColumnChange` and `ColumnVersion`:
- **Serialization** (`column-version.ts`): self-describing `{ v, pv?, ph? }` payload,
  absent-tolerant deserialize, `encodeSqlValue`/`hlcToJson` for prior. Verified the
  prior HLC round-trips **all** fields incl. `opSeq` (`hlcToJson`/`hlcFromJson`).
- **Producer** (`recordColumnVersions`) and **relay** (`resolveLogEntry`,
  `collectAllChanges`): conditional spread, prior sourced from the CRDT cell version.
- **Apply** (`commitColumnMetadata`): local-lineage prior from `oldColumnVersion`.
- **Resolver/event exposure** (`resolveChange`): conditional spread into
  `ConflictContext` + both `emitConflictResolved` calls; fast path byte-identical.
- **Snapshot paths** (`snapshot.ts`, `snapshot-stream.ts`): confirmed they construct
  `{ hlc, value }` only — intentionally prior-less ("fresh basis"), per the docs.
- **Falsy/edge priors** (`0`/`false`/`''`/`null`, `Uint8Array`, `bigint`): the gate
  keys on `priorHlc !== undefined` (not value truthiness) and `priorValue ?? null`;
  all round-trip. No phantom `undefined`/`null` keys leak onto the wire.
- **Docs** (`docs/sync.md`): read the § Data Structures / Conflict Resolution /
  Reactive Hooks additions against the code — accurate and consistent with reality.

### Major findings
**None.** No new tickets filed.

### Minor findings — fixed in this pass
- **Quarantine dropped the before-image, violating its own "verbatim / full
  fidelity" contract.** `quarantine.ts` is the *other* wire-`Change` (de)serializer
  in the package (used to hold retired-table straggler deltas for late/manual replay
  via `list()`). Its docstring promises the raw wire `Change` is "stored verbatim so
  a manual / late replay has full fidelity," but `serializeQuarantineEntry` /
  `deserializeQuarantineEntry` were not updated and silently discarded the new
  `priorValue`/`priorHlc`. **Fixed**: added `pv?`/`ph?` to the serialized shape,
  written/restored together (same `priorHlc !== undefined` gate + conditional-spread
  pattern as the rest of the change, so prior-less changes stay free of phantom
  fields). Added `test/metadata/quarantine.spec.ts` (4 tests: no-prior absence,
  prior round-trip incl. `opSeq`, `Uint8Array`/`null` prior values, delete passthrough).

### Design decision the implementer flagged — disposition: ACCEPTED as designed
The implementer raised a genuine fork: the stored before-image is **replica-local
lineage** (`commitColumnMetadata` persists from `oldColumnVersion`, what *this*
replica overwrote) rather than **origin lineage** (the incoming `change.prior`).
Consequence: a dedup'd single delta to a *fresh* receiver (one that never saw v1)
stores v2 with no prior — the origin's chain is not persisted past that hop (the
wire change and the resolver still see it via `remotePrior*`; only storage drops it).

**Decision: keep local-lineage, no change.** It matches the ticket's two explicit
Phase-2 "persist from `oldColumnVersion`" instructions, is self-consistent, is the
documented intent (`docs/sync.md` § Data Structures: "Replica-local lineage" +
"Best-effort"), and is tested on the causal-order relay path. The dropped-chain edge
is acceptable under the documented best-effort contract. A `?? change.prior` fallback
(origin-lineage) is a *separate* semantics change, not a defect fix — not filed; if
product later wants origin-lineage chain preservation, that is a new enhancement.

### Validation
- `yarn workspace @quereus/sync test` → **294 passing, 0 failing** (290 pre-fix +
  4 new quarantine tests). The `[Sync] Error handling transaction commit` lines are
  pre-existing intentional error-injection tests in `sync-manager.spec.ts`, not failures.
- `tsc -p packages/quereus-sync/tsconfig.test.json --noEmit` (strict, src + tests) → exit 0.
- `yarn lint` covers only `@quereus/quereus` (no eslint config exists for
  `quereus-sync`); the strict typecheck above is the real type gate for this package.

### Known gaps carried forward (not blocking, not bugs)
- **LevelDB store round-trip unverified.** `test:store` is slow / not agent-runnable
  in-budget. The format change lives entirely in `column-version.ts` (opaque bytes to
  the store) and is exercised via `InMemoryKVStore`, so the LevelDB path should be
  unaffected — left for CI / a human to confirm out-of-band.
- **No negative test for the documented dropped-chain (fresh-receiver dedup'd delta).**
  This is now the *intended* local-lineage behavior, not a bug; a lock-in assertion
  would be nice-to-have but was not added to avoid scope creep.
