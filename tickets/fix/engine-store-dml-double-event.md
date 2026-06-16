description: A single store-backed DML statement is delivered TWICE on the engine event channels (onDataChange / onTransactionCommit) — the engine's auto-event gate fails to recognize a StoreModule whose events are already hooked at the module level, so the engine auto-emits IN ADDITION to the module's native emitter. Harmless to sync convergence (column versions/tombstones are idempotent) but doubles recorded CRDT facts and inflates opSeq counts for store-backed local transactions.
prereq:
files:
  - packages/quereus/src/util/event-support.ts                 # hasNativeEventSupport(obj) — checks obj.getEventEmitter()
  - packages/quereus/src/runtime/emit/dml-executor.ts          # needsAutoEvents = _needsDataEvents() && !hasNativeEventSupport(vtab) (lines 497, 726, 874)
  - packages/quereus/src/core/database.ts                      # module-level getEventEmitter hook (~line 716); _needsDataEvents
  - packages/quereus/src/core/table-handle.ts                  # TableHandle.getEventEmitter (instance-level)
  - packages/quereus-store/src/common/store-module.ts          # StoreModule.getEventEmitter (line 240) — MODULE level only
  - packages/quereus/src/schema/manager.ts                     # parallel gate for schema events (lines 1519, 2520) — verify same issue for DDL
difficulty: medium
----

# Fix: store-backed DML double-emits on the engine event channels

## Symptom

A single `insert into <store-table>` (and update/delete) arrives on
`db.onDataChange` **and** in the `db.onTransactionCommit` batch as **two**
identical data events. Empirically observed while wiring sync capture through
`db.onTransactionCommit` (ticket `sync-per-transaction-hlc-tick`): a one-row
insert produced two identical data events in the committed batch.

This is **not** introduced by the sync ticket — any `db.onDataChange` listener
plus a store module already triggers it (and quoomb-web subscribes db-level
listeners in production). Routing sync capture through `onTransactionCommit` just
made it visible.

## Root cause (already traced)

The DML executor's auto-event gate is:

```ts
// dml-executor.ts:497 (and 726, 874)
const needsAutoEvents = ctx.db._needsDataEvents() && !hasNativeEventSupport(vtab);
```

`hasNativeEventSupport(obj)` returns true only when `obj.getEventEmitter()` is a
function returning a defined value (`util/event-support.ts`). It is passed the
**vtab instance** (`vtab`), but only `StoreModule` (the *module*) exposes
`getEventEmitter` (`store-module.ts:240`) — its table/connection *instances* do
**not** (`TableHandle.getEventEmitter` exists but is a different surface and is
not what carries the store's native emission).

So `hasNativeEventSupport(vtab)` evaluates `false` → `needsAutoEvents` is `true`
→ the engine **auto-emits** a data event. Meanwhile the StoreModule's native
emitter is hooked at the **module** level (`database.ts` ~line 716) and **also**
emits. Result: two identical events per row mutation.

## Expected behavior

A store-backed DML mutation should produce **exactly one** data event on each
engine channel, whether emitted natively by the module or auto-emitted by the
engine — never both.

## Impact / why it matters

- **Convergence: safe.** Column versions and tombstones are idempotent and the
  duplicate fact resolves to the same value; CRDT state still converges.
- **Cost: real.** It doubles the recorded CRDT facts and inflates per-transaction
  `opSeq` counts for store-backed local transactions, doubling change-log size and
  replicated bandwidth for every store-backed write in production (quoomb-web).
- It also means existing sync tests that assert on fact *presence* (set membership)
  rather than fact *count* silently tolerate the doubling — see
  `echo-loop-quiescence.spec.ts` (uses `Set.has`, not counts).

## Fix direction (choose during implement)

Two candidate fixes — pick one (or both) after confirming the cleanest seam:

1. **Gate fix:** make the auto-event gate recognize a module whose events are
   already hooked at the module level — e.g. have `hasNativeEventSupport` (or the
   gate) consult the owning module's `getEventEmitter`, not just the vtab instance,
   so a store-backed table is correctly detected as natively-emitting.
2. **Instance fix:** have store vtab/table instances expose `getEventEmitter`
   (delegating to the module's emitter) so the existing instance-level check sees
   native support.

Check `schema/manager.ts:1519,2520` — the **schema**-event auto-gate uses the same
`hasNativeEventSupport(moduleReg?.module)` pattern but against the *module*, so DDL
may already be correct (or differently affected). Verify whether DDL double-emits;
fix consistently.

## Acceptance

- A single store-backed insert/update/delete delivers exactly one event on
  `onDataChange` and exactly one corresponding event in the `onTransactionCommit`
  batch (assert on **counts**, not just presence).
- Add a regression test (engine `database-events` suite) that counts events for a
  store-backed single-row DML and asserts == 1 per channel.
- No regression for non-store (memory) modules, which legitimately rely on the
  engine auto-emit path.
