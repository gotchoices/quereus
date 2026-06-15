description: Per-table opt-in (`quereus.sync.replicate = true`) for recording materialized-view / maintained-table maintenance writes in the sync change log. The store backing host reads the tag inside `applyMaintenance` and queues store `DataChangeEvent`s for each realized `BackingRowChange`, so the sync layer records column versions / HLC stamps / change-log entries / delete tombstones — exactly as an ordinary table write. Default off; create-fill/refresh out of scope (see prereq spillover).
difficulty: hard
prereq: mv-noop-upsert-suppression, store-backing-host
files:
  - packages/quereus/src/schema/reserved-tags.ts                 # add the `quereus.sync.replicate` spec + exported constant
  - packages/quereus/src/index.ts                                # re-export the constant (+ getReservedTag) for quereus-store
  - packages/quereus-store/src/common/backing-host.ts            # read the tag, queue DataChangeEvents in applyMaintenance
  - packages/quereus-store/src/common/transaction.ts             # coordinator.queueEvent (already exists — the seam)
  - packages/quereus-store/src/common/events.ts                  # DataChangeEvent shape (insert/update/delete, key, oldRow, newRow, remote)
  - packages/quereus-store/test/backing-host.spec.ts             # (new/extend) store-host emit unit tests
  - packages/quereus/test/schema/reserved-tags.spec.ts           # spec/site/value validation for the new tag
  - docs/migration.md                                            # § Synced vs. local derived tables / § Current gaps — mark implemented
----

# Synced derivations: change-log opt-in (implement)

`docs/migration.md` § Synced vs. local derived tables is the spec. The table row:

> | maintenance writes recorded in the sync change log | the backing host module's decision inside `applyMaintenance`, opted in per table via a reserved tag (default **off** — a privileged maintenance write emits no module data events otherwise) |

Today `StoreBackingHost.applyMaintenance` (and `MemoryBackingHost`) deliberately
queue **no** `DataChangeEvent`s — correct for the common local MV (covering
index, perf cache). A **migration target** is the exception: its derived rows
must replicate so they reach old / never-upgrading peers that store the new
table opaquely. This ticket makes the store host **opt that backing's
maintenance writes into change recording** when the backing carries the reserved
tag `quereus.sync.replicate = true`.

## How the pieces already line up (verified during planning)

- **The tag reaches the host, live.** `buildBackingTableSchema`
  (`packages/quereus/src/runtime/emit/materialized-view-helpers.ts:308`) copies
  the MV's `with tags (…)` onto the backing `TableSchema.tags`. The store
  module's engine-schema listener fires `StoreTable.updateSchema(event.newObject)`
  on `table_modified` (`store-module.ts` ~2304), so an `ALTER TABLE … ADD TAGS`
  after creation propagates to the live `StoreTable`. `StoreModule.getBackingHost`
  constructs a **fresh** `StoreBackingHost(table, table.attachCoordinator())` per
  engine call, so `this.table.getSchema().tags` is always the live tag set.

- **Queuing an event is the whole mechanism.** `@quereus/sync`
  (`sync-manager-impl.ts:155`) subscribes to the store-private
  `StoreEventEmitter.onDataChange`. The coordinator fires queued
  `DataChangeEvent`s on commit (`transaction.ts` ~229) and discards them on
  rollback. `SyncManager.handleDataChange` (`sync-manager-impl.ts:181`):
  - `if (event.remote) return;` — inbound sync writes are never re-recorded.
  - local `insert`/`update` → `recordColumnVersions(...)` (per-column version +
    `changeLog.recordColumnChangeBatch`).
  - local `delete` → `tombstones.setTombstoneBatch` + `changeLog.recordDeletionBatch`.
  So a maintenance write that queues a **local** (non-`remote`) event gets the
  identical recording an ordinary table write gets.

- **Echo safety is already in place.** The `mv-noop-upsert-suppression` contract
  means a value-identical re-derivation produces **no** `BackingRowChange` — so
  the host emits **no** event for it — so no change-log entry — so no peer
  round-trip. We only ever emit events for the entries the host already returns
  in its `changes[]`. The loop closes itself.

## The change

### Phase 1 — engine: reserved-tag spec + export (`packages/quereus`)

Add to `RESERVED_TAG_SPECS` in `schema/reserved-tags.ts`:

```ts
export const SYNC_REPLICATE_TAG = 'quereus.sync.replicate';
// ...
{
  key: SYNC_REPLICATE_TAG,
  sites: siteSet('view-ddl', 'physical-table'),
  valueSchema: 'boolean',
  description: 'Opt this maintained table / materialized view\'s maintenance '
    + 'writes into the sync change log (the backing host records column versions / '
    + 'tombstones for each derivation write). Default off.',
},
```

- **Sites `view-ddl` + `physical-table`** cover both authoring forms of a
  migration target: the canonical **table form** (`create table Contact_v2 (…)
  using store() maintained as …` → CREATE TABLE → `physical-table`, validated
  at create) and the **materialized-view form** (`create materialized view
  Contact_v2 using store() … with tags (…)` → `view-ddl`, validated lazily at
  the view-mutation boundary). Do **not** add logical-* sites — the tag governs
  a physical backing, not a lens column.
- `valueSchema: 'boolean'` — the prover/host read `=== true`; a non-boolean
  value is `invalid-tag-value` (error) at create.
- Update the `unknownReservedTag` suggestion string to mention
  `quereus.sync.replicate`.

Re-export from `packages/quereus/src/index.ts` so `@quereus/quereus-store` can
import the literal DRY-ly (reserved-tags is currently **not** in the barrel —
add `export { SYNC_REPLICATE_TAG, getReservedTag } from './schema/reserved-tags.js';`,
or fold into the existing schema export block).

### Phase 2 — store host: emit events for opted-in maintenance writes (`packages/quereus-store`)

In `StoreBackingHost.applyMaintenance` (`common/backing-host.ts`), after the
per-op switch builds `changes[]` and after the secondary-UNIQUE enforcement,
when the backing is opted in, queue one `DataChangeEvent` per realized change on
`this.coordinator`:

```ts
import { SYNC_REPLICATE_TAG } from '@quereus/quereus';
// ...
private get replicates(): boolean {
  return this.table.getSchema().tags?.[SYNC_REPLICATE_TAG] === true;
}

// at the end of applyMaintenance, before `return changes`:
if (this.replicates) {
  const schema = this.table.getSchema();
  for (const change of changes) {
    this.coordinator.queueEvent(this.toDataChangeEvent(schema, change));
  }
}
```

`toDataChangeEvent` maps a `BackingRowChange` to the store event shape (mirrors
the ordinary StoreTable DML events — `store-table.ts` insert ~1022 / update
~1153 / delete ~1793):

- `insert`  → `{ type:'insert', schemaName, tableName, key: extractPk(newRow), newRow }`
- `update`  → `{ type:'update', schemaName, tableName, key: extractPk(newRow), oldRow, newRow }`
- `delete`  → `{ type:'delete', schemaName, tableName, key: extractPk(oldRow), oldRow }`

Notes:
- Leave `remote` **unset** (false) — these are local derivations. (`remote: true`
  is for inbound sync writes via `applyExternalRowChanges`, a different path.)
- Omit `changedColumns` — `recordColumnVersions` recomputes the per-column diff
  from `oldRow`/`newRow` itself (parity with the store's own update event, which
  also omits it).
- `applyMaintenance` already begins a coordinator transaction when none is
  active, so `queueEvent` always buffers into `pendingEvents` (fires on commit /
  discards on rollback). Queue events **after** secondary-UNIQUE enforcement so a
  thrown constraint error leaves nothing queued.
- The MV-over-MV cascade is unaffected: it consumes the **returned** `changes[]`;
  event emission is an additional commit-time side effect, not a change to the
  return value.

### Phase 3 — memory host: no change (document why)

`MemoryBackingHost` stays event-free — the sync layer subscribes to the
**store** emitter only, so there is no consumer for memory-host events. The
reserved tag is engine-global (validated everywhere) but behaviorally
**store-only**, consistent with the doc's "the sync-store module is simply a
host that demands them." Add a one-line note in `backing-host.ts`'s "No events"
header (store package) that the opt-in flips this for replicate-tagged backings,
and leave the memory module header as-is.

### Phase 4 — docs

- `docs/migration.md` § Current gaps: strike "per-table change-logging opt-in
  for maintenance writes" from the pending list (the rest of the
  Sync-layer-policies bullet — unknown-table disposition, retention-horizon
  retirement, mapped-since bookkeeping — stays).
- Update the store `backing-host.ts` module header ("No events, no secondary
  structures") to describe the opt-in.

## Edge cases & interactions

- **Default off (no regression).** No tag / `= false` → zero events; existing MV
  maintenance is byte-for-byte unchanged. Pin with a negative test.
- **Value-identical upsert (echo prevention).** Opted-in backing, `upsert` equal
  to the effective row → suppression yields no `BackingRowChange` → zero events.
  This is the echo seam — test it explicitly.
- **`replace-all` reconcile/attach.** Opted-in, `applyMaintenance('replace-all')`
  (the later-upgrading-peer attach path) publishes only genuine insert/update/
  delete diffs; value-identical paired rows publish nothing. In the steady-state
  window (tables already agree) the attach writes — and publishes — **zero** rows
  (the doc's "identical content writes nothing").
- **delete-key / delete-by-prefix.** Each realized delete queues a `delete`
  event → sync records a **tombstone** + deletion-log entry. A `delete-key` of an
  absent key produces no change → no event.
- **Live tag toggling via ALTER.** `alter table mv add tags (quereus.sync.replicate
  = true)` after creation must take effect (via the `table_modified` →
  `updateSchema` propagation) without reopen; `drop tags` reverts to off. Test
  both directions.
- **Transaction rollback / savepoints.** Maintenance events ride the coordinator:
  a rolled-back source write (or a released-back savepoint) discards its queued
  maintenance events — nothing is published. The coordinator already truncates
  `pendingEvents` by `eventIndex` on savepoint rollback; confirm with a test.
- **Inbound remote writes not re-logged.** An inbound sync write to a replicated
  backing lands via `getTableForExternalWrite`/`applyExternalRowChanges` as an
  ordinary `remote: true` change — `handleDataChange` skips it. The local
  re-derivation it triggers (`applyMaintenance` from ingest) is a **local**
  event; if value-identical to the already-ingested derived row, suppression
  drops it (quiescence). This is the echo-loop the spec demands — see the
  integration test below.
- **MV-over-MV cascade.** Backing B (opted-in) is a source for MV C: B's changes
  both publish (B's events) and cascade to C; C publishes iff C is itself
  opted-in. Opt-in is per-table and independent.
- **Create-fill / refresh is OUT OF SCOPE.** `replaceContents` (create-fill,
  full-rebuild refresh) stays event-free in this ticket — it has no value-
  identical suppression, so publishing it would storm the change log across peers
  that each derive the same fill. The "static row never edited after deploy →
  never-upgrading old peer never receives it" gap is parked in backlog ticket
  `sync-derivation-fill-publication`. The reconcile/attach path
  (`applyMaintenance('replace-all')`) is covered here and is the path a
  later-upgrading peer actually uses.

## Key tests (TDD)

Primary (run under `yarn test` / `yarn test:store`):

- **Reserved-tag registry** (`test/schema/reserved-tags.spec.ts`):
  - `quereus.sync.replicate = true` valid at `view-ddl` and `physical-table`
    (no diagnostics).
  - non-boolean value → `invalid-tag-value` (error).
  - at `logical-column` / `logical-table` → `tag-not-allowed-here`.
  - typo `quereus.sync.replicat` → `unknown-reserved-tag`.
- **Store backing-host emit** (`packages/quereus-store/test/backing-host.spec.ts`,
  new or extend): construct a `StoreBackingHost` over a backing `StoreTable`
  whose `getSchema().tags` carries the tag; attach a coordinator with an
  event-emitter spy; for each op assert the queued event fires on commit with the
  right `{type,key,oldRow,newRow}`:
  - `upsert` insert → one `insert` event; `upsert` over existing → `update`
    with old+new; `delete-key` → `delete` with oldRow.
  - **value-identical `upsert` → zero events.**
  - `replace-all` → only the genuine diffs; identical paired row → no event.
  - **without the tag → zero events** (current behavior preserved).
  - rollback after `applyMaintenance` → zero events delivered.
  - `alter`-toggle: schema with tag on → events; updateSchema to tag off →
    subsequent maintenance emits nothing.

Integration (may land in a later phase — heavier; `@quereus/sync` or a
store+sync harness):

- **Echo-loop quiescence (the spec's explicit test):** peer A source write → A
  derives + logs the derived row → B ingests the source + derived changes → B's
  own derivation of the ingested source change is value-identical → B logs
  nothing new → quiescence (no ping-pong). Assert B's change log gains exactly
  one (A-origin) derived entry per A write and zero B-origin derived entries from
  re-derivation.

## TODO

- [ ] Add `SYNC_REPLICATE_TAG` constant + `RESERVED_TAG_SPECS` entry (sites
      `view-ddl`,`physical-table`; `boolean`); update the unknown-tag suggestion.
- [ ] Re-export `SYNC_REPLICATE_TAG` (+ `getReservedTag`) from `packages/quereus/src/index.ts`.
- [ ] `StoreBackingHost`: `replicates` getter + `toDataChangeEvent` mapper; queue
      events at the end of `applyMaintenance` when opted in (after UNIQUE enforce).
- [ ] Update store `backing-host.ts` "No events" header + `docs/migration.md`
      § Current gaps / § Synced vs. local derived tables.
- [ ] Reserved-tag spec/site/value tests.
- [ ] Store backing-host emit tests (incl. suppression, no-tag, rollback,
      replace-all diff, ALTER-toggle).
- [ ] Describe (and stub if time permits) the echo-loop integration test.
- [ ] `yarn lint` (quereus) + `yarn test`; `yarn test:store` for the store path.
