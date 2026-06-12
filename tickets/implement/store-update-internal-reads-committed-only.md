description: Route StoreTable.update()'s internal reads (insert PK-conflict probe, update/delete oldRow reads, PK-change conflict probe) through the pending-overlay read primitive so bare-StoreModule DML decisions agree with RYOW queries. Reproduced and root-caused in fix stage; all four arms confirmed defective on the bare module, memory-module control passes.
files:
  - packages/quereus-store/src/common/store-table.ts        # update() arms (~lines 834-1113); readEffectiveRowByKey (~1453) is the read primitive
  - packages/quereus-store/src/common/transaction.ts        # getPendingOpsForStore — no changes expected, read-side index already lands
  - packages/quereus-store/test/store-ryow.spec.ts          # host suite for the new DML-RYOW tests (or a sibling store-dml-ryow.spec.ts)
  - packages/quereus-isolation/src/isolated-table.ts        # reference only: flushOverlayToUnderlying (~1320-1393) — the trustedWrite caller whose invariants are pinned below
  - packages/quereus-store/README.md                        # § Module Capabilities RYOW bullet — extend to cover DML conflict probes
----

# Make bare-store DML internal reads pending-aware

## Confirmed reproduction (fix stage)

A scratch mocha spec against the bare `StoreModule` (in-memory provider, no
isolation wrapper) confirmed every arm; the memory-module control behaved
correctly. With `begin` open:

- `insert (1,'a'); insert (1,'b')` → **no error**, silent overwrite (memory module raises UNIQUE).
- `insert (1,'a'); insert or ignore (1,'b')` → row ends up `'b'` (must stay `'a'`).
- `insert (1,'a'); insert or replace (1,'b'); commit` → `getEstimatedRowCount()` = **2** (one row stored).
- `insert (1,'old'); update set v='new'; commit` with index on `v` → **2** index entries (old entry leaked).
- `insert; delete; commit` → stats stuck at **1**, index entry leaked, table empty.
- `insert (1),(2); update set id=2 where id=1` → **no error**, pending row 2 silently overwritten.
- update/delete events for intra-transaction rows carry `oldRow: undefined`.

## Root cause

`StoreTable.update()`'s four internal reads use committed-only `store.get(...)`:

1. insert arm PK-conflict probe — `existing = await store.get(key)`
2. update arm old-image read — `oldRowData = await store.get(oldKey)`
3. update arm PK-change conflict probe — `existingAtNew = await store.get(newKey)` (the
   in-code comment "Read through the coordinator…" documents intended behavior never implemented)
4. delete arm old-image read — `oldRowData = await store.get(key)`

A row written earlier in the same coordinator transaction lives only in the
pending bucket, so these probes report "absent": no PK conflict raised, no index
cleanup (`updateSecondaryIndexes` gets `oldRow: null`), wrong stats deltas
(`existing`/`oldRow` null gates `trackMutation`), and events without `oldRow`.

`readEffectiveRowByKey(key)` (store-table.ts ~1453) is the existing primitive:
pending delete ⇒ null, pending put ⇒ its row, else committed `get`,
deserialized. It addresses the coordinator's default-store bucket by role, so it
is correct even with a lazily-resolved default store, and degrades to the bare
committed read outside a transaction.

## Fix design

Replace the four committed-only reads with effective reads, returning `Row | null`
directly (drop the intermediate `Uint8Array`/`deserializeRow` juggling):

- **insert arm**: keep the `trustedWrite` probe committed-only (pinned — see
  constraints), read effective otherwise:

  ```ts
  const existingRow = args.trustedWrite
      ? ((v => v ? deserializeRow(v) : null)(await store.get(key)))
      : await this.readEffectiveRowByKey(key);
  ```

  Downstream uses of `existing` become `existingRow` (constraint result's
  `existingRow`, the `oldRow` for REPLACE-as-update event, the `!existing` stats
  gate, `replacedRow`). With the effective read, an insert-over-pending-row at
  the same PK now: raises UNIQUE under ABORT, no-ops under IGNORE, and under
  REPLACE re-puts the key (coordinator put is last-write-wins in the bucket),
  removes the pending row's secondary-index entries via
  `updateSecondaryIndexes(oldRow=pendingRow, …)` (a coordinator index-delete
  cancels the earlier pending index-put; a commit-batch delete of a
  never-committed index key is a harmless no-op), skips the `+1` stats delta,
  and emits an update event carrying the pending `oldRow`.

- **update arm**: `const oldRow = await this.readEffectiveRowByKey(oldKey)` —
  unconditional (trusted included; see safety analysis). Fixes index cleanup,
  `uniqueColumnsChanged(oldRow, coerced)` gating, and the event's `oldRow`.

- **update arm, PK-change probe**: `const existingAtNewRow = await
  this.readEffectiveRowByKey(newKey)` (guard stays `pkChanged &&
  !args.trustedWrite` — trusted flush never changes a PK). A PK-change onto a
  pending row now conflicts/evicts; the REPLACE path's
  `deleteRowAt(newPk, replacedAtNewPk)` already queues delete-then-put in the
  coordinator, which nets correctly (put wins).

- **delete arm**: `const oldRow = await this.readEffectiveRowByKey(key)` —
  unconditional. Fixes index cleanup, the `-1` stats delta (netting an
  insert+delete to zero), and the event's `oldRow`. `coordinator.delete(key)`
  already cancels a pending put; the commit batch may carry a delete of a
  never-committed key, which is a no-op.

`readEffectiveRowByKey` re-awaits `ensureStore()` internally; `update()` has
already resolved it, so this is a settled-promise await — fine. If preferred,
factor a private overload taking the resolved store, but don't duplicate the
overlay logic.

## Trusted-flush safety analysis (why unconditional effective reads are safe in update/delete arms)

`flushOverlayToUnderlying` (isolated-table.ts ~1320) wraps the flush in its own
coordinator mini-transaction (`underlyingTable.begin()`), orders tombstone
deletes before inserts/updates, and the overlay holds **at most one entry per
PK**. Therefore when any flush write probes its own key, no pending op exists at
that key yet in the mini-transaction — the effective read equals the committed
read on every trusted-path probe. The only pinned committed-only read is the
insert arm's `trustedWrite` INTERNAL-invariant guard (kept verbatim per
`store-backing-host-substrate` analysis). Note the flush's **delete** arm does
NOT pass `trustedWrite` at all, so the delete-arm change must hold for it; the
deletes-first ordering plus one-entry-per-PK gives effective ≡ committed there
too. State this reasoning in a comment where the arms diverge.

## Use cases to pin (validated failing in fix stage — turn into tests)

Add a `describe` block to `store-ryow.spec.ts` (or a sibling
`store-dml-ryow.spec.ts` with the same in-memory provider harness; pass a
`StoreEventEmitter` to the `StoreModule` constructor and capture
`onDataChange` events for the event assertions; use `module.getTable('main',
't')!.getEstimatedRowCount()` for stats and the provider's store map —
`main.t_idx_<name>` keys — to count index entries):

- `begin; insert (1,'a'); insert (1,'b')` → raises UNIQUE (PK), matching memory module.
- `begin; insert (1,'a'); insert or ignore (1,'b')` → row stays `'a'`.
- `begin; insert (1,'a'); insert or replace (1,'b'); commit` → one row `'b'`, estimated row count 1, update event with `oldRow [1,'a']`.
- `begin; insert; update` changing an indexed column; `commit` → exactly one index entry.
- `begin; insert; delete; commit` → no rows, estimated row count 0, zero index entries.
- `begin; insert (1),(2); update set id=2 where id=1` → UNIQUE error; with `or replace`, result reports the pending row as `replacedRow` and one row remains at id=2.
- update/delete events for intra-transaction rows carry the pending `oldRow`.
- Regression guard: all existing suites must stay green, especially
  `isolated-store.spec.ts` (flush invariants) and `store-ryow.spec.ts`.

## TODO

- Convert the four internal reads in `StoreTable.update()` per the fix design,
  keeping the `trustedWrite` insert guard committed-only and updating the
  stale "Read through the coordinator" comment on the PK-change probe to
  describe the now-real behavior.
- Add a comment capturing the trusted-flush safety analysis (deletes-first +
  one-entry-per-PK ⇒ effective ≡ committed on trusted probes) where the insert
  arm diverges from the other arms.
- Add the pinned-use-case tests (list above) to `store-ryow.spec.ts` or a
  sibling spec using the existing in-memory provider harness.
- Extend the `README.md` § Module Capabilities RYOW bullet: DML conflict
  probes (PK conflict, old-image reads) also read through the pending merge.
- Run `yarn workspace @quereus/store run test`, then `yarn build` and
  `yarn test` at the root; run `yarn test:store` since this touches the store
  DML path exercised by the LevelDB logic-test run.
