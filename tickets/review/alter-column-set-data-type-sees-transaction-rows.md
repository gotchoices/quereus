----
description: Review the fix that makes the in-memory backend's "change a column's type inside a transaction" see and convert that transaction's own uncommitted rows, instead of ignoring them.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn setDataType arm; convertBaseRows; convertColumnOnOpenLayers; openTransactionLayersOldestFirst
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # new convertColumn method
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts  # new "set data type" describe block
  - docs/memory-table.md                                     # § DDL and transactions
difficulty: medium
----

# Review: `alter column … set data type` sees & converts the issuing transaction's rows (memory backend)

## What the fix does

`alter table … alter column … set data type <T>` on the in-memory backend used to read and
convert **only the committed base tree** (`this.baseLayer.primaryTree`), ignoring the open
transaction's own uncommitted rows. Two consequences (both reproduced on `main` before the fix):

1. an **unconvertible pending value** was silently accepted (should reject with `MISMATCH`);
2. a **conversion that should apply was discarded** at commit, because the pending layer — snapshotted
   before the base was converted — became the committed head and shadowed the converted base.

The fix (memory backend only; the store backend was already correct and is untouched):

- **Validates over EFFECTIVE rows, not the base tree.** The `setDataType` arm now runs a throw-only
  conversion pass over `rows ?? effectiveDdlRows()` (committed rows overlaid with the transaction's
  own pending writes) *before any mutation*. An unconvertible value the transaction can see rejects
  the ALTER (`MISMATCH`) atomically; one only in a row it has **deleted** does not block it.
- **Replaces the base primary tree** with the converted rows (`convertBaseRows` +
  `BaseLayer.rebuildPrimaryTreeFromRows`) instead of the previous **in-place `tree.upsert`**. In-place
  base mutation is illegal (`inheritree` `MutatedBaseError`) whenever the open transaction's layers
  derive from that tree — the whole point of this ticket. Replacement also rebuilds every secondary
  index from the converted values. This changed the **autocommit** path too (no more in-place upsert);
  the existing sqllogic `41.2-alter-column` tests 7 & 9 still pass.
- **Converts the transaction's own layers.** New `TransactionLayer.convertColumn` (modelled on
  `rekeyPrimaryKey`) rebuilds each open layer's primary tree over its parent's freshly-converted tree,
  rewrites its own-written values at the column index, collapses its `ownWrites` replay log to net
  per-key effect carrying the converted value (so the commit-time rebase replays converted rows), and
  rebuilds its secondary indexes. Driven oldest-first by `convertColumnOnOpenLayers`.
- **PK-column retype is rejected** (`CONSTRAINT`, "Cannot change the data type of primary key
  column …") both in-transaction and in autocommit: retyping a key column changes the physical key
  bytes, which the value-only rewrite cannot re-key. This is the type-change analogue of the SET
  COLLATE primary-key carve-out.
- The `openTransactionLayersOldestFirst()` walk is now shared by `adoptSchemaOnOpenLayers` (collate)
  and `convertColumnOnOpenLayers` (type).

## How to exercise it

`cd packages/quereus`, then:

- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn test` — **6913 passing, 0 failing** (13 pending). The new cases are in
  `test/ddl-in-transaction-validation.spec.ts` under *"alter column … set data type converts the
  transaction's own rows"* (11 cases). Run just that file:
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/ddl-in-transaction-validation.spec.ts"`

Cases covered (all green): unconvertible pending value → `MISMATCH` + transaction still usable;
pending-unconvertible rejects even when every committed row converts (committed row stays text);
committed + pending both convert (in-transaction and after commit, `typeof` = new type); unconvertible
value only in a **pending-deleted** row → accepted; a later insert is coerced to the new type; a
secondary index resolves rows by the converted numeric key; conversion across a savepoint (two layers,
oldest-first); after `ROLLBACK` the converted committed row keeps the new type (DDL not undone);
PK-column retype rejected in-transaction and in autocommit; `set default` in a transaction honored
(the verified non-bug).

Manual smoke (memory, plain `new Database()`):
```sql
create table t (id integer primary key, v text);
insert into t values (1, '42');
begin;
insert into t values (2, '7');
alter table t alter column v set data type integer;
select id, typeof(v) from t order by id;   -- 1|integer  2|integer  (was 1|text 2|text on main)
commit;
select id, typeof(v) from t order by id;   -- 1|integer  2|integer
```

## Known gaps / things to look hardest at

- **Store parity for PK-column retype (highest-value check).** Memory now **rejects** a PK-column
  `set data type` with `CONSTRAINT`. The store backend's `alterColumnSetDataType` does **not**
  special-case the PK column (it calls `mapRowsAtIndex`), so the two backends may diverge on this
  input. I did **not** verify what store does for a PK-column retype. Worth confirming whether store
  rejects, re-keys, or corrupts — and whether the contracts should be unified. Not filed as a ticket
  pending that check; if store also mis-handles it, it deserves its own `bug-`/`debt-` ticket.
- **Isolation overlay is not converted.** When a wrapper (the isolation layer) supplies `rows`, the
  transaction's pending rows live *outside* this manager, so `convertColumnOnOpenLayers` finds no open
  layers and no-ops — the overlay's own rows are not converted. This mirrors the pre-existing collate
  gap `isolation-ddl-validation-ignores-overlay-rows`; the spec file header already documents that the
  isolation overlay does not honor these DDL rules. Flagging, not fixing, here.
- **Post-rollback staleness of shadowed values.** A base/own value that fails to convert is left
  as-is on the reasoning that it is shadowed by a pending delete/overwrite and never read. After a
  `ROLLBACK` (which undoes the DML but not the DDL — the known `feat-ddl-transaction-capability`
  behavior) that value re-appears under the new type. This is consistent with how the collate path
  already behaves and with `bug-rolled-back-rows-violate-surviving-ddl`; no new ticket.
- **Rollback fragility if `convertColumn` ever threw mid-chain.** Validation runs first and
  convert-failures are skipped, so `convertColumn` is effectively non-throwing; the `alterColumn`
  catch only restores the base tree/schema, not partially-converted layers. Same fragility the collate
  path carries. If a future change makes the per-layer conversion able to throw, the catch needs to
  become layer-aware.
- **`convertColumn` rebuilds every secondary index per layer**, not only those covering the altered
  column — matches the base's unconditional rebuild; a perf tripwire only for wide-index tables under
  deep savepoint stacks.

## Not in scope (verified during the prereq/this ticket)

- `set not null` in a transaction — separate ticket `bug-set-not-null-ignores-uncommitted-rows`
  (its in-place base `tree.upsert` backfill has the same `MutatedBaseError` exposure under an open
  transaction; **left untouched** here).
- `set default` in a transaction — reproduced as **correct**; a regression assertion is included.
- Store backend — reference implementation, unchanged.

## Store test deferral

`yarn test:store` was **not** run. The diff touches only memory-vtab files
(`manager.ts`, `transaction.ts`), a memory-only spec, and docs — zero store code and no shared
sqllogic — so the store suite exercises none of these changes. Deferred to CI / a human if store
parity (see PK-retype note above) is to be confirmed under LevelDB.
