description: A long-offline peer can reconnect and send edits for a table the receiver has since deleted; the sync engine now lets an operator choose to drop or durably keep those edits, and always reports them so a straggler's writes are never silently lost.
prereq:
files:
  - packages/quereus-sync/src/sync/change-applicator.ts        # Phase-1 detection + diversion + telemetry
  - packages/quereus-sync/src/metadata/quarantine.ts           # QuarantineStore (put/list/pruneOlderThan)
  - packages/quereus-sync/src/metadata/keys.ts                 # qt: prefix + key/scan-bounds builders
  - packages/quereus-sync/src/sync/protocol.ts                 # UnknownTableDisposition, SyncConfig field, ApplyResult.unknownTable
  - packages/quereus-sync/src/sync/events.ts                   # UnknownTableEvent + onUnknownTable
  - packages/quereus-sync/src/sync/sync-context.ts             # isTableInBasis / recordUnknownTable surface
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # oracle, stats counter, pruneQuarantine
  - packages/quereus-sync/src/sync/manager.ts                  # SyncManager interface additions
  - packages/quereus-sync/src/create-sync-module.ts            # config merge (default applies for external callers)
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts  # 14 unit tests (HLC dead import removed)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts # +1 real-adapter e2e diversion test
  - docs/migration.md                                          # § 4 Contract — Unknown-table disposition
  - docs/sync.md                                               # § Unknown-Table Disposition
----

# Review complete: Unknown-table disposition + telemetry

Out-of-basis straggler changes (edits for a table the receiver has retired) are
detected structurally at Phase 1 of `applyChanges` — before resolution or any
CRDT write — and either `quarantine`d (default, durable + GC-bounded) or
`ignore`d, with always-on telemetry (`onUnknownTable`, `getUnknownTableStats()`,
`ApplyResult.unknownTable`). Implementation landed across commits `2d9951d1` and
`ca95b6ae`; review pass in this stage.

## Review findings

### Validation (all green)
- `yarn workspace @quereus/sync run typecheck` → exit 0.
- `yarn workspace @quereus/sync run test` → **276 passing** (275 pre-existing + 1
  added this pass), 0 failing. The error lines in output are from intentional
  error-path tests (`failingKv`, assertion-violation seam test).
- Ticket test files type-checked explicitly (the package `typecheck` excludes
  `test/`, and the mocha runner uses Node type-stripping, so neither gate sees
  test types) — both ticket files clean.
- `packages/quereus` `yarn lint` → exit 0 (covers the cross-table changes that
  were swept into this ticket's commits; not regressed).

### Correctness — checked, no defects
- **Phase-1 diversion + `commitMetadata`-fold ordering** (the load-bearing
  crash-safety claim): quarantine `put` is staged inside the `admitGroup`
  `commitMetadata` callback, which runs strictly before `watermarkHLC` advances.
  A crash before the hold is durable leaves the clock un-advanced, so the batch
  re-resolves and re-quarantines idempotently. Verified by construction + the
  idempotent-re-apply test.
- **No-CRDT-pollution invariant**: a diverted change `continue`s before
  `resolveChange`, so it never reaches `dataChangesToApply` / `appliedChanges` /
  `resolvedDataChanges` → `commitChangeMetadata` never sees it. The
  "writes no CRDT metadata" test confirms `getChangesSince` surfaces nothing for
  the retired table.
- **Quarantine key idempotency + round-trip**: `qt:{schema}.{table}:` + 30-byte
  HLC + type byte + `:pk[:column]`. HLC (incl. `opSeq`) makes intra-transaction
  changes distinct; an identical re-delivered change overwrites its own key.
  Serialization uses the same `encodeSqlValue`/`hlcToJson` encoders as column
  versions, so `Uint8Array`/`bigint` survive. Value (not key) carries the change,
  so keys are never parsed back — no parse-ambiguity surface.
- **`pruneQuarantine` horizon math**: `cutoff = now - retentionHorizonMs`,
  `receivedAt < cutoff` ⟺ `now - receivedAt > retentionHorizonMs` — exactly the
  tombstone TTL test. Tested both sides of the horizon.
- **Detection edges**: in-batch `create_table` makes a table known; `drop_table`
  makes it unknown; self-origin echo skip runs first (self never quarantined);
  mixed batch applies known + diverts unknown; absent oracle is inert. All tested.
- **Config field roll-out**: `unknownTableDisposition` is required on `SyncConfig`,
  but `createSyncModule` (the only external construction path) merges
  `DEFAULT_SYNC_CONFIG`, and `CreateSyncModuleOptions extends Partial<SyncConfig>`,
  so sync-client / coordinator callers are unaffected. No other package constructs
  a bare `SyncConfig` literal.
- **Docs**: `docs/migration.md` § 4 Contract and `docs/sync.md` § Unknown-Table
  Disposition (table, telemetry, config, events, `ApplyResult`) read accurately
  against the code — including the snapshot-path / absent-oracle scope carve-outs.

### Minor — fixed inline this pass
- **Added a real-adapter end-to-end test** (`store-adapter-seam.spec.ts`):
  proves a genuinely out-of-basis table (oracle returns `undefined`) is diverted
  to quarantine through the production `createStoreAdapter` — no throw, no error
  state, durably held, nothing relayed — the companion to the existing
  ownership-mismatch case where the adapter's defensive throw *does* fire. This
  closes the handoff's gap #1 (the unit harness only proved control flow against
  a fake `applyToStore`).
- **Removed a dead `type HLC` import** in `unknown-table-disposition.spec.ts`
  (used only in test-description strings). It was invisible to the package
  `typecheck` (excludes `test/`) but is dead code in the ticket's own new file.

### Acknowledged, no action (by design / acceptable)
- **Telemetry double-counts on idempotent re-apply**: a crash-before-watermark
  re-delivery re-fires `onUnknownTable` and re-bumps the cumulative
  `getUnknownTableStats()` counters, even though the quarantine entry itself is
  idempotent (HLC-keyed). This is observe-only telemetry and is consistent with
  how the per-call `applied`/`skipped` counters also re-count on retry; the
  durable state (quarantine entries) remains exactly-once. Not worth guarding.
- **`commitMetadata` performs three separate non-atomic writes** (CRDT batch,
  per-migration `recordMigration`, quarantine batch). Each is independently
  idempotent and a partial commit converges on re-apply (watermark advances only
  after all three, in `admitGroup`). The per-migration write was already separate
  pre-ticket; the quarantine batch follows the same pattern. Acceptable.
- **create+drop of the same table in one batch** → `dropped` wins
  (`known = (… || created) && !dropped`) → diverted. Correct by construction;
  rare; left untested (low value).
- **Fault-injection test** between data-apply and quarantine-write (handoff
  gap #2): the ordering is correct by construction and covered indirectly by the
  idempotent-re-apply test; a dedicated interrupt-injection harness is not worth
  a standalone ticket.
- **`pruneQuarantine()` / `pruneTombstones()` are caller-driven**, not auto-
  scheduled — parity with the existing tombstone pattern; an operator/host must
  call them. Documented.

### Deferred (out of scope, already ticketed)
- **`store-and-forward` disposition** (durably hold AND re-offer to peers that
  still have the table) — needs outbound `getChangesSince` integration. Parked in
  `tickets/backlog/sync-unknown-table-store-and-forward.md`; the disposition type
  stays `'ignore' | 'quarantine'` until it lands. Confirmed the backlog ticket
  exists.
- **Snapshot paths** (`applySnapshot` / `applySnapshotStream`) — bootstrap a whole
  basis, not a straggler delta; an unknown table there still hits the adapter's
  defensive throw. Documented in both docs and covered by the existing seam tests.

No major findings → no new tickets filed.
