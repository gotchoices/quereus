description: When the app itself re-creates a deleted table with a local CREATE TABLE, make its held sync edits replay right away instead of waiting for the background sweep.
prereq:
files:
  - packages/quoomb-web/src/worker/quereus.worker.ts            # initializeSyncModule / close: wire + tear down the listener
  - packages/quoomb-web/src/worker/sync-local-create-drain.ts   # NEW: testable listener factory (mirrors sync-maintenance.ts)
  - packages/quoomb-web/src/__tests__/sync-local-create-drain.test.ts  # NEW: Vitest unit tests (mirrors sync-maintenance.test.ts)
  - packages/quereus-sync/src/sync/manager.ts                   # SyncManager.drainHeldChanges(schema, table) — the public primitive being called
  - packages/quereus-sync/src/sync/change-applicator.ts         # drainReappearedTables / drainHeldChanges — the library-internal reactive paths this mirrors
  - packages/quereus/src/core/database-events.ts                # DatabaseSchemaChangeEvent shape; schema events flushed post-commit
difficulty: easy
----

# Low-latency scoped drain when the app issues a local `create table`

## What this delivers

Complete the trio of low-latency drain paths. The two library-internal paths already fire an
immediate scoped `drainHeldChanges(schema, table)` the moment a retired table reappears:

- inbound `create_table` from a remote peer (`drainReappearedTables` in `applyChanges`), and
- a lens redeploy re-mapping a basis table back into the basis (the `detached → present`
  transition in `sync-manager-impl.ts`).

The third — a **local** `create table` issued by the app itself — currently waits up to one
periodic-maintenance interval (~5 min) for its held edits to replay. This ticket closes that
gap so the locally-driven re-create behaves like the other two.

## Design (resolved)

### Detection: subscribe to `db.onSchemaChange`, no SQL sniffing

The worker already has the engine's schema-change channel. `db.onSchemaChange(listener)`
delivers a `DatabaseSchemaChangeEvent` (`packages/quereus/src/core/database-events.ts:50`):

```ts
interface DatabaseSchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index' | 'column';
  moduleName: string;
  schemaName: string;
  objectName: string;   // table name for a table event
  columnName?: string;
  oldColumnName?: string;
  ddl?: string;
  remote: boolean;      // true ⇒ applied by the sync store-adapter (a remote apply)
}
```

Two properties make this the clean hook (no bespoke statement parser, per AGENTS.md):

1. **Post-commit delivery.** Schema events are batched within a transaction and emitted only
   from `flushBatch()` after a successful commit (`database-events.ts` — `startBatch` /
   `flushBatch`; dropped on rollback). So the listener fires *after* the creating transaction
   commits, satisfying the "drain must run as a separate post-commit apply, never interleaved
   into the creating txn" invariant for free.

2. **`remote` distinguishes local from library-applied.** A local `db.exec('create table …')`
   emits with `remote: false`. The sync store-adapter marks its inbound `create_table` apply's
   event `remote: true` (`store-adapter.ts` `applySchemaChange` → `expectRemoteSchemaEvent`).
   Filtering on `!remote` means the host handles exactly the local case and the library keeps
   owning the remote case — no double work.

The filter is therefore: `event.type === 'create' && event.objectType === 'table' &&
!event.remote`. (Even without the `!remote` guard a double-drain would be a harmless idempotent
no-op — see Edge cases — but the guard keeps the host/library split clean and avoids a wasted
scan.)

Schema events are only generated when `_needsSchemaEvents()` is true (any `onSchemaChange` or
`onTransactionCommit` listener registered). The sync module already registers an
`onTransactionCommit` listener via `transactionSource: db`, and this ticket adds an
`onSchemaChange` listener, so events flow.

### Where to drain: fire-and-forget the public primitive

The host calls the public `syncManager.drainHeldChanges(event.schemaName, event.objectName)`
directly — fire-and-forget with `void … .catch(log)`. This is **independent of the library's
`drainOnReappear` config flag**: that flag is a library-internal gate for the two reactive
*library* paths and is not surfaced to the worker. The worker never sets it false (it defaults
true), so there is no practical conflict; the public primitive is deliberately not gated by the
flag (proven by `unknown-table-disposition.spec.ts` — "an explicit host sweep still drains").
If a future host ever needs to disable the eager local drain, add a worker-level toggle then.

### Decomposition: a testable listener factory (mirror `sync-maintenance.ts`)

Keep the worker thin and the logic unit-testable without Comlink/IndexedDB, exactly as
`createSyncMaintenanceTicker` does. Add `packages/quoomb-web/src/worker/sync-local-create-drain.ts`:

```ts
import type { DatabaseSchemaChangeEvent } from '@quereus/quereus';

/** Minimal structural view of the one primitive the listener calls (a SyncManager is assignable). */
export interface LocalCreateDrainTarget {
  drainHeldChanges(schema?: string, table?: string): Promise<number>;
}

/** Reports a failed eager drain. Advisory — the held entries stay for the periodic sweep. */
export type LocalCreateDrainLogger = (schema: string, table: string, error: unknown) => void;

/**
 * Build an onSchemaChange listener that eagerly replays a reappeared table's held
 * out-of-basis changes the moment the app locally re-creates it — as a SEPARATE
 * post-commit apply (the schema event already fires after commit). Only a local
 * `create table` qualifies: remote create_table applies are drained reactively inside
 * the library (drainReappearedTables); alter/drop and index/column events never revive
 * a held table. Fire-and-forget: a drain failure is logged, never re-thrown, so it can
 * never surface as a failure of the user's create table.
 */
export function createLocalCreateDrainListener(
  getTarget: () => LocalCreateDrainTarget | null,
  log: LocalCreateDrainLogger,
): (event: DatabaseSchemaChangeEvent) => void {
  return (event) => {
    if (event.type !== 'create' || event.objectType !== 'table' || event.remote) return;
    const target = getTarget();
    if (!target) return;
    void target
      .drainHeldChanges(event.schemaName, event.objectName)
      .catch((error) => log(event.schemaName, event.objectName, error));
  };
}
```

Wire it in `initializeSyncModule()` (alongside `startSyncMaintenance()`), storing the unsub in a
new field, e.g. `private syncDrainSchemaUnsub: (() => void) | null = null`:

```ts
this.syncDrainSchemaUnsub = db.onSchemaChange(
  createLocalCreateDrainListener(
    () => this.syncManager,
    (schema, table, error) =>
      console.warn(`[quoomb-web] eager drain on local create ${schema}.${table} failed:`, error),
  ),
);
```

Tear it down in `close()` (NOT `disconnectSync()` — like the maintenance loop, it lives with the
sync *module* so held changes can still drain while offline):

```ts
if (this.syncDrainSchemaUnsub) { this.syncDrainSchemaUnsub(); this.syncDrainSchemaUnsub = null; }
```

Note this is a dedicated subscription, separate from the existing UI-forwarding
`schemaChangeSubscribers` plumbing (which only subscribes when a UI subscriber exists) — the
drain hook must be live whenever the sync module is initialized.

## Edge cases & interactions

- **Separate post-commit apply (core invariant).** The listener fires from `flushBatch()` after
  commit, and the drain is a `void`-ed separate `drainHeldChanges` call — never interleaved into
  the creating transaction. Verify a `begin … create table … commit` block fires the listener
  once, after commit.
- **Nothing held ⇒ cheap no-op.** Every local `create table` triggers a scoped
  `quarantine.list(schema, table)`; when nothing is held it returns `[]` and `drainHeldChanges`
  returns 0. This runs on *every* local table creation — acceptable (a single bounded scoped
  scan), and the reason the path is "worth wiring" despite the local case's rarity.
- **Idempotent with the periodic sweep and any library drain.** Re-resolution is LWW-idempotent;
  a second `quarantine.delete` is a no-op. A remote create that the library already drained, if
  it somehow also reached the host path, would re-drain to 0.
- **`remote` filter correctness.** Confirm a local `create table` emits `remote: false` and a
  store-adapter inbound `create_table` emits `remote: true`, so the host handles only the local
  case. (A regression that flipped local→remote would silently disable this path — cover it.)
- **Non-create / non-table events ignored.** `alter`/`drop` table, and `index`/`column` events,
  never revive a held table — the filter must drop them (no wasted scoped scans).
- **create → drop quickly (oracle gate).** Local `create T` then `drop T` (same txn, or two
  txns): the create event fires the drain, but by the time it runs the table may be absent →
  `drainTableGroup`'s `getTableSchema` oracle gate makes it a no-op. Harmless.
- **Schema/table name casing.** `buildQuarantineScanBounds` keys on the raw `schema.table`
  strings verbatim (NOT lowercased — unlike `buildBasisLifecycleKey`). The held entries carry the
  wire-side `change.schema`/`change.table` casing; the local create event carries the engine's
  `schemaName`/`objectName`. Pass the event's names directly. A casing mismatch degrades
  gracefully — the scoped `quarantine.list` returns `[]` and the periodic sweep (which scopes
  with `()` and reads each held entry's own stored casing) still drains it on the next interval —
  so it is a latency, not a correctness, hazard. As part of implementing, confirm the engine's
  schema-event `objectName` casing matches the wire `change.table` casing for the common path
  (both originate from engine schema events on their respective peers); if a systematic mismatch
  exists, normalize at the call site.
- **No single-flight needed.** Unlike the maintenance ticker, distinct local creates fire
  table-scoped, independent, idempotent drains — concurrent/overlapping calls are safe, so the
  listener deliberately does NOT hold an in-flight guard.
- **Drain failure never fails the user's `create table`.** The transaction has already committed
  before the listener runs; the drain is `void`-ed with `.catch(log)`; and `emitSchemaEvent`
  already wraps each listener in try/catch (`database-events.ts`). Double-protected.
- **Lifecycle.** Listener registered in `initializeSyncModule`, torn down only in `close()`
  (survives `disconnectSync()`), so offline-accumulated held edits drain on a local re-create
  even while disconnected.

## TODO

- Add `packages/quoomb-web/src/worker/sync-local-create-drain.ts` with
  `createLocalCreateDrainListener` (+ `LocalCreateDrainTarget` / `LocalCreateDrainLogger`), per
  the design above.
- Wire it into `QuereusWorker.initializeSyncModule()` and add the `syncDrainSchemaUnsub` field +
  teardown in `close()`.
- Add `packages/quoomb-web/src/__tests__/sync-local-create-drain.test.ts` (Vitest, mirroring
  `sync-maintenance.test.ts`) covering:
  - fires `drainHeldChanges('main', 'orders')` for `{type:'create', objectType:'table', remote:false}`,
    passing through `schemaName`/`objectName`;
  - ignores `remote:true`;
  - ignores `type:'alter'` and `type:'drop'`;
  - ignores `objectType:'index'` and `objectType:'column'`;
  - clean no-op when `getTarget()` returns null;
  - a rejected `drainHeldChanges` is swallowed and logged (listener never throws);
  - re-reads the target each event (goes no-op once cleared).
- Run `yarn workspace @quereus/quoomb-web test` (Vitest) and `yarn build`. Stream long output
  with `… 2>&1 | tee /tmp/out.log; tail -n 80 /tmp/out.log` (Git Bash) per AGENTS.md.
- Touch `docs/migration.md` § 4 Contract (and/or `docs/sync.md`) to note the local `create table`
  path now joins the inbound-create and lens-redeploy paths in firing an eager scoped drain — one
  sentence, completing the documented trio.


## End
