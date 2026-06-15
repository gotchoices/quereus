description: Review the per-table `quereus.sync.replicate` opt-in that records a maintained-table / materialized-view backing's maintenance writes in the sync change log. The store backing host reads the reserved tag in `applyMaintenance` and queues one local store `DataChangeEvent` per realized `BackingRowChange` (column versions / HLC stamps / tombstones, exactly as an ordinary write). Default off; create-fill/refresh out of scope.
prereq:
files:
  - packages/quereus/src/schema/reserved-tags.ts                 # SYNC_REPLICATE_TAG const + spec entry (sites view-ddl, physical-table; boolean); unknown-tag suggestion + module header
  - packages/quereus/src/index.ts                                # re-export SYNC_REPLICATE_TAG + getReservedTag
  - packages/quereus-store/src/common/backing-host.ts            # replicates getter + toDataChangeEvent mapper; queue events after UNIQUE enforce; module header
  - packages/quereus-store/test/backing-host.spec.ts             # emit tests (both flavors) + pending echo-loop stub
  - packages/quereus/test/schema/reserved-tags.spec.ts           # spec/site/value tests + length 17→18 + seeds include
  - docs/migration.md                                            # § Synced vs. local derived tables (named tag) / § Current gaps (struck)
----

# Synced derivations: change-log opt-in — review handoff

## What landed

A maintained table / materialized view backed by `using store(...)` can now opt
its **maintenance writes** into the sync change log via the reserved tag
`quereus.sync.replicate = true`. Default **off** (unchanged behavior: a
privileged maintenance write emits no module data events). The seam is entirely
inside the store backing host — the engine never learns the word "synced".

### Phase 1 — engine reserved tag (`packages/quereus`)
- `SYNC_REPLICATE_TAG = 'quereus.sync.replicate'` constant + `RESERVED_TAG_SPECS`
  entry: sites `view-ddl` + `physical-table` (the two authoring forms of a
  migration target), `valueSchema: 'boolean'`. Mis-site (logical-*) →
  `tag-not-allowed-here`; non-boolean → `invalid-tag-value` (error); typo →
  `unknown-reserved-tag`. Module header + unknown-tag suggestion updated.
- Re-exported `SYNC_REPLICATE_TAG` + `getReservedTag` from the quereus barrel so
  the store package keys off one literal (DRY).

### Phase 2 — store host emit (`packages/quereus-store`)
- `StoreBackingHost.applyMaintenance`: after secondary-UNIQUE enforcement, when
  `replicates` (the live `getSchema().tags?.[SYNC_REPLICATE_TAG] === true`) is
  true, queue one `DataChangeEvent` per realized `change` on `this.coordinator`.
- `toDataChangeEvent` maps `BackingRowChange` → store event (`insert`/`update`/
  `delete`, `key = extractPk(...)`, old/new rows), mirroring the StoreTable DML
  events. `remote` left unset (local derivation); `changedColumns` omitted (the
  sync layer recomputes the per-column diff). Module header rewritten
  ("Events: off by default, opt-in per table").
- Memory host: unchanged (no consumer subscribes to a memory emitter). The tag is
  engine-global but behaviorally store-only — documented.

### Phase 4 — docs
- `docs/migration.md` § Synced vs. local derived tables: table row now names the
  concrete tag + describes the event-per-change mechanism.
- § Current gaps: the per-table change-logging opt-in line is struck (marked
  implemented); create-fill publication remains, pointing at backlog
  `sync-derivation-fill-publication`.

## Why this is echo-safe (the load-bearing invariant)

Events are queued only for entries the host already returns in `changes[]`. The
`mv-noop-upsert-suppression` contract means a value-identical re-derivation
produces **no** `BackingRowChange` → no event → no change-log entry → no peer
round-trip. The loop closes itself. This is the single most important property to
re-verify.

## How to validate / exercise

- **Reserved-tag registry**: `packages/quereus/test/schema/reserved-tags.spec.ts`
  § `quereus.sync.replicate` — valid@{view-ddl,physical-table}, non-boolean
  error, mis-site, typo; plus updated length (18) + seeds-include.
  Run: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/schema/reserved-tags.spec.ts"`
- **Store host emit**: `packages/quereus-store/test/backing-host.spec.ts`
  § `quereus.sync.replicate change-log opt-in` — run against **both** registration
  shapes (isolated wrapper + bare module). Covers: insert/update/delete published
  on commit (buffered until then), value-identical upsert suppressed (echo seam),
  replace-all publishes only genuine diffs, replace-all of identical contents
  publishes nothing (steady-state attach), no-tag → zero events, rollback → zero
  events, and ALTER add/drop-tags live toggle (via `table_modified` →
  `updateSchema`).
  Run: `node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/backing-host.spec.ts"`

All green at handoff: `yarn lint` (quereus) clean; `yarn test` (6318 core +
package suites) passing; `yarn test:store` 6313 passing, 0 failing.

## Known gaps / where to push (treat tests as a floor)

- **Echo-loop integration test is NOT implemented** — it is a single *pending*
  mocha test (`it('echo-loop quiescence across two synced peers …')`) in the
  store spec. The spec's headline cross-peer test (A writes → A derives+logs → B
  ingests → B's re-derivation is value-identical → B logs nothing) needs a
  store+`@quereus/sync` two-peer harness (HLC, change log, ingest) that does not
  exist in this package's test tree. The single-host echo seam (value-identical
  upsert → no event) IS pinned. **Reviewer: decide whether to spawn a fix/plan
  ticket for the real two-peer integration test, or accept the unit-level seam
  coverage.** This is the biggest honest gap.
- **Savepoint-level discard not independently tested.** Full `conn.rollback()` →
  zero events is tested. The coordinator already truncates `pendingEvents` by
  `eventIndex` in `rollbackToSavepoint` (transaction.ts), so a released-back
  savepoint should discard its queued maintenance events — but there is no
  dedicated test asserting *maintenance* events specifically ride that path.
  Low-risk (shared mechanism), but a candidate for an inline minor test.
- **Create-fill / refresh (`replaceContents`) stays event-free — intentional and
  out of scope.** It has no value-identical suppression, so publishing it would
  storm the change log across peers that each derive the same fill. The
  "static-row-never-edited → never-upgrading peer never receives it" gap is parked
  in backlog `sync-derivation-fill-publication`. Confirm the reviewer agrees this
  belongs out-of-band, not silently closed here.
- **MV-over-MV cascade** is unaffected (it consumes the *returned* `changes[]`;
  emission is an additional commit-time side effect). Not separately tested here;
  existing cascade tests cover the return-value path and remained green.
- The emit tests use a regular `create table … using store with tags(…)` as the
  backing (matching the existing backing-host suite), not a real
  `maintained as` / `create materialized view`. The host code path is identical
  (it reads `getSchema().tags`), but a reviewer wanting end-to-end confidence
  could add a sqllogic-level MV-over-store-with-replicate case.
