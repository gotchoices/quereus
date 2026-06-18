description: Review the local create-table eager drain implementation — new listener factory, worker wiring, tests, and doc update.
files:
  - packages/quoomb-web/src/worker/sync-local-create-drain.ts       # NEW: listener factory
  - packages/quoomb-web/src/__tests__/sync-local-create-drain.test.ts # NEW: 9 Vitest tests
  - packages/quoomb-web/src/worker/quereus.worker.ts                 # wired field + init + teardown
  - docs/migration.md                                                 # § Revival/drain updated: two → three paths
----

## What was built

Completed the trio of low-latency scoped drain paths so that a local `create table`
issued by the app itself triggers an immediate `drainHeldChanges(schema, table)` — matching
the existing inbound-create (library) and lens-redeploy (library) reactive paths.

### New files

**`sync-local-create-drain.ts`** — testable listener factory, mirroring `sync-maintenance.ts`:
- `LocalCreateDrainTarget` — structural interface (only `drainHeldChanges`)
- `LocalCreateDrainLogger` — error callback type
- `createLocalCreateDrainListener(getTarget, log)` — returns an `onSchemaChange` listener
  that filters `{type:'create', objectType:'table', remote:false}` and calls
  `drainHeldChanges(event.schemaName, event.objectName)` fire-and-forget

**`sync-local-create-drain.test.ts`** — 9 Vitest tests (all pass):
- fires drain with correct schema/table names
- ignores `remote:true`
- ignores `type:alter` and `type:drop`
- ignores `objectType:index` and `objectType:column`
- clean no-op when `getTarget()` is null
- swallows a rejected drain and logs it (listener never throws)
- re-reads target each event; goes no-op once target is cleared

### Modified files

**`quereus.worker.ts`** changes:
- Added import for `createLocalCreateDrainListener`
- Added `private syncDrainSchemaUnsub: (() => void) | null = null` field
- In `initializeSyncModule()`: registers `db.onSchemaChange(createLocalCreateDrainListener(...))` after `startSyncMaintenance()`
- In `close()`: tears down the subscription before nulling `syncManager`

**`docs/migration.md`** § Revival/drain:
- Updated "the two reappearance paths" → "the three reappearance paths"
- Added point (3) describing the local-create host path
- Added `sync-drain-reappear-local-ddl` ticket reference

## Validation

- `yarn workspace @quereus/quoomb-web test` — 74/74 pass (9 new + 65 existing)
- `yarn build` — all packages built successfully (2309 modules, no errors)

## Testing use cases

1. **Happy path** — app issues `db.exec("create table T ...")`, schema event fires
   `{type:'create', objectType:'table', remote:false}`, listener calls
   `drainHeldChanges('main', 'T')` and held edits replay without waiting for the 5-min tick.
2. **Remote create** — inbound `create_table` from a peer sets `remote:true`; listener
   ignores it; library handles drain internally via `drainReappearedTables`.
3. **Non-create events** — alter/drop table and index/column creates are filtered out; no
   wasted scoped scans.
4. **Nothing held** — `drainHeldChanges` returns 0 cheaply; no side effects.
5. **Drain failure** — rejected promise is caught and logged; user's `create table` is
   unaffected (transaction already committed before the listener fires).
6. **After close()** — subscription is torn down; late timer fires can't reach the null manager.

## Known gaps / reviewer notes

- **Casing invariant** — the ticket noted that schema-event `objectName` casing should match
  wire `change.table` casing (both originate from engine schema events). This was not
  independently verified in unit tests; casing mismatches degrade gracefully to a no-op drain
  (the periodic sweep still catches it), so it is a latency hazard, not correctness.
- **No E2E test** — the path is exercised end-to-end only in a running quoomb-web worker with
  a real SyncManager; unit tests stub the target. An E2E test would require the sync-e2e-harness
  extracted in the prior ticket (`extract-sync-e2e-test-harness`).
- **`drainOnReappear` independence** — the public primitive `drainHeldChanges` is not gated by
  the library's `drainOnReappear` config flag (confirmed by spec); the worker path calls it
  unconditionally, which is correct and intentional.
