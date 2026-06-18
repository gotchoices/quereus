description: A locally-created table now immediately replays any held edits that were waiting for it, instead of waiting up to a maintenance interval.
files:
  - packages/quoomb-web/src/worker/sync-local-create-drain.ts        # listener factory
  - packages/quoomb-web/src/__tests__/sync-local-create-drain.test.ts # 9 Vitest tests
  - packages/quoomb-web/src/worker/quereus.worker.ts                  # wired field + init + teardown
  - docs/migration.md                                                 # § Revival/drain: two → three paths
  - docs/sync.md                                                      # § Revival/drain: third (host eager) path added in review
----

## What shipped

The third low-latency scoped-drain path: a local `create table` issued by the app
itself now triggers an immediate `drainHeldChanges(schema, table)` — matching the
existing inbound-create (library) and lens-redeploy (library) reactive paths. The
quoomb-web worker subscribes `db.onSchemaChange`, filters
`{type:'create', objectType:'table', remote:false}`, and fires the public drain
primitive fire-and-forget.

- **`sync-local-create-drain.ts`** — `createLocalCreateDrainListener(getTarget, log)`
  returns an `onSchemaChange` listener over a structural `LocalCreateDrainTarget`
  (just `drainHeldChanges`). A real `SyncManager` is structurally assignable.
- **`quereus.worker.ts`** — `syncDrainSchemaUnsub` field; registered after
  `startSyncMaintenance()` in `initializeSyncModule()`; torn down (before nulling
  `syncManager`) in `close()`, surviving `disconnectSync()` so offline re-creates
  still drain.
- **docs** — migration.md (implement) + sync.md (review) updated to three paths.

## Review findings

Reviewed the implement diff (`8f26388d`) with fresh eyes before the handoff, then
read every file it touched and the files it *should* have touched, and traced the
load-bearing engine assumptions to source.

### Checked — correctness (no issues)

- **`remote` filter is meaningful (no double-drain).** Confirmed remote `create_table`
  DDL is executed via `db.exec(change.ddl)` in `store-adapter.ts`, and the store
  module marks the resulting schema event `remote:true`
  (`expectRemoteSchemaEvent`/`pendingRemoteSchemaEvents`). So the worker listener's
  `event.remote` guard correctly excludes the path the library already drains
  reactively (`drainReappearedTables` from `applyChanges`).
- **Post-commit lifecycle (durability + no deadlock).** The implement claim "schema
  events fire post-commit" holds: DDL runs in an implicit/explicit transaction that
  `startBatch()`es schema events; `commitTransaction()` calls `flushBatch()` only
  *after* `connection.commit()` (`database-transaction.ts:308-309`), so the table is
  durable and visible (`schemaManager.getTable`) when the listener runs. Because the
  listener is fire-and-forget (`void drainHeldChanges(...)`), the async drain's
  `ingestExternalRowChanges` (which acquires the exec mutex — "do NOT call from within
  statement execution") defers to a later microtask after `exec` releases the mutex →
  no deadlock.
- **Teardown / late-event safety.** `close()` unsubscribes the listener (1001-1004)
  *before* nulling `syncManager` (1031); `disconnectSync()` (904-910) does **not**
  null `syncManager`, so the "survives disconnectSync" claim is real. A late event
  after unsub is a no-op (listener removed); a late event after a hypothetical null is
  a clean no-op (`getTarget()` returns null).
- **Type safety.** `() => this.syncManager` (`SyncManager | null`) is assignable to
  `LocalCreateDrainTarget | null`; `drainHeldChanges(schema?, table?): Promise<number>`
  matches. Typecheck clean.

### Found & fixed inline (minor)

- **docs/sync.md was stale.** Its § Revival/drain still said "the two library-internal
  reappearance paths" / "Both reappearance paths" and its "Who drives the sweep"
  paragraph documented only the periodic loop — the new host-driven eager local-create
  listener was never added there. The implementer updated docs/migration.md but missed
  the more detailed sync.md. Fixed: the intro now names the host eager path, and "Who
  drives the sweep" describes the `db.onSchemaChange` listener (post-commit event,
  fire-and-forget, **not** gated by `drainOnReappear`, `remote:true`/non-table events
  filtered, torn down on `close()`).

### Checked — tests

- Reviewed the 9 Vitest tests: cover fire-with-names, `remote:true` ignored,
  `alter`/`drop` ignored, `index`/`column` ignored, null-target no-op, rejected-drain
  swallowed+logged, target re-read each event. Solid coverage of the factory's branch
  matrix. `yarn workspace @quereus/quoomb-web test` → **74/74 pass**;
  `... typecheck` → **clean (exit 0)**.
- Lint: not applicable — the only package with a lint script is `packages/quereus`,
  which this ticket does not touch; quoomb-web's `lint` is a no-op echo. Validation was
  the package vitest + `tsc --noEmit`. The code is byte-identical to the implement
  commit (which had build+test green); only docs prose changed in review, which no test
  exercises.

### Not filed (accepted gaps, with reasons)

- **No E2E test for the worker wiring.** The underlying `drainHeldChanges` primitive is
  already E2E-covered (`sync-drain-e2e.spec.ts`, real `Database` + `StoreModule` +
  store adapter); the only untested seam is the 3-line `onSchemaChange → drainHeldChanges`
  wiring, which is typechecked. An E2E would need the `extract-sync-e2e-test-harness`
  output. Latency-optimization seam, not a correctness gate — not worth a ticket.
- **Casing invariant** (implementer's note). If the local create's `objectName` casing
  differed from a held change's `table` casing, the *scoped* eager drain could no-op,
  but this is the same `drainHeldChanges` primitive the periodic no-arg sweep uses, so
  any casing behavior is the library's, already exercised by the sweep — this ticket
  introduces no new casing risk. Degrades to a latency hazard (sweep still catches it),
  not correctness. No ticket.
- **`drainOnReappear` independence** confirmed by spec: the public primitive is
  intentionally ungated; the worker calls it unconditionally. Correct, as intended.

## End
