----
description: In the in-memory backend, changing a column's declared type inside a transaction ignores that transaction's own uncommitted rows — an unconvertible pending value is wrongly accepted, and a conversion that should apply is silently thrown away when the transaction commits.
prereq: bug-alter-column-set-data-type-leaves-old-values
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn setDataType arm (~2090-2118); effectiveDdlRows; adoptSchemaOnOpenLayers; catch rollback
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # NEW value-rewrite method for own-writes; adoptSchema
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildAllSecondaryIndexes after value conversion
  - packages/quereus-store/src/common/store-module.ts        # alterColumnSetDataType — the REFERENCE (already correct); do not change
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts  # add set-data-type-in-transaction cases
  - docs/memory-table.md                                     # § DDL and transactions
difficulty: medium
----

# `alter column … set data type` must see and convert the issuing transaction's rows (memory backend)

## What is broken

The in-memory backend keeps committed rows in a **base layer** and each open transaction's
uncommitted writes in a **transaction layer** stacked on top. `MemoryTableManager.alterColumn`'s
`setDataType` arm reads and writes `this.baseLayer.primaryTree` directly
(`packages/quereus/src/vtab/memory/layer/manager.ts:2096`), so it neither validates against nor
converts the open transaction's own rows, and it never re-points those layers at the new schema.

Three behaviors, all reproduced against `main` (memory backend, plain `new Database()`):

**Unconvertible pending value accepted.** A value the transaction itself wrote that cannot be
converted is not rejected:

```sql
create table t (id integer primary key, v text);
begin;
insert into t values (1, 'notanumber');
alter table t alter column v set data type integer;   -- accepted; must be rejected (MISMATCH)
commit;
select * from t;                                       -- (1, 'notanumber') in an integer column
```

**A conversion that should apply is discarded.** The committed row's conversion is written to the
base tree, but the pending layer was snapshotted before it and becomes the committed head at commit,
so neither row ends up converted:

```sql
create table t (id integer primary key, v text);
insert into t values (1, '42');
begin;
insert into t values (2, '7');
alter table t alter column v set data type integer;
commit;
select id, typeof(v) from t;   -- 1|text  2|text  — both still text
```

(A related autocommit-only defect — the conversion not reaching readers *even with no transaction*,
plus the secondary-index rebuild gap — is `bug-alter-column-set-data-type-leaves-old-values`, this
ticket's prereq. Both likely share the `physicalType`-equality short-circuit at
`manager.ts:2092`, which skips conversion **and** validation whenever the old and new physical types
coincide. Assume that ticket has landed a correct autocommit conversion — validation that rejects an
unconvertible value, value conversion that reaches readers, and a secondary-index rebuild — and build
the transaction-aware behavior on top of it.)

## Reference contract: the store backend already does this

The persistent store backend is the behavioral reference and memory must match it. Its
`alterColumnSetDataType` (`packages/quereus-store/src/common/store-module.ts:1987`) already:

- runs a **throw-only validation pass over the transaction's effective values** —
  `table.iterateEffectiveValuesAtIndex(colIndex)` yields committed rows overlaid with the issuing
  transaction's pending writes — so an unconvertible pending value rejects the ALTER; and
- **flushes the transaction's buffered writes** (`ddlCommitPendingOps()`) *before* the physical
  rewrite (`mapRowsAtIndex`), so the rewrite converts this transaction's own rows too rather than
  replaying them under the old physical type.

Do not change the store path. The gap is memory-only.

## What is NOT in this ticket (verified, deduped)

The original triage ticket (`bug-alter-column-changes-ignore-open-transaction`) bundled three ALTER
COLUMN attributes. After reproduction only `set data type` remains for this ticket:

- **`set not null`** is the same shape of bug but is owned end-to-end (memory + store + isolation)
  by `bug-set-not-null-ignores-uncommitted-rows`. Not duplicated here.
- **`set default`** is **not a defect** — reproduced as correct. Inside a transaction, an `alter …
  set default 'new'` is honored by both the in-transaction insert and the post-commit insert.
  Defaults are resolved from the catalog `TableSchema` (updated synchronously by the ALTER), not
  from the frozen transaction-layer schema, so the stale-schema concern the triage ticket raised
  does not apply. No work needed; a regression test is optional but cheap.

## Expected behavior

- A value that cannot be converted **in any row the issuing transaction can see** (committed or its
  own pending) rejects the ALTER with `MISMATCH`, leaving the schema, the table and the transaction
  untouched and usable.
- A value that is unconvertible only in a row the transaction has already **deleted** does not block
  the change (validate the *effective* view, not the raw base).
- When the change is accepted, the new type and the converted values hold for the rest of the
  transaction and **survive commit** — both the committed rows and the transaction's own pending
  rows read back converted, and `typeof` reflects the new physical type.
- Any secondary index on the altered column is rebuilt so its keys reflect the converted values, in
  both the base and the transaction's own layers.

## Implementation sketch

Mirror the structure the `set collate` fix already established in `alterColumn` — validate over
effective rows before any mutation, mutate the base, then adopt the change onto the open layers —
adding one genuinely new piece: converting the transaction layers' *own-written row values* (schema
adoption today only re-keys structures; it never rewrites a stored value).

TODO:

- **Validate over effective rows, not the base tree.** In the `setDataType` arm, replace the
  `this.baseLayer.primaryTree` scan with a throw-only pass over `effectiveDdlRows()` (use
  `rows ?? effectiveDdlRows()`, matching `validateUniqueOverEffectiveRows`), so an unconvertible
  pending value rejects and a deleted-away one does not. This runs before any mutation, so a
  rejection is atomic.

- **Convert the base rows** as the prereq ticket makes correct (ensure the physical-type
  short-circuit no longer skips a real conversion), and rebuild any secondary index on the column.

- **Convert the transaction's own layers.** After the base is converted and the schema swapped, walk
  the DDL connection's open layers oldest-first (as `adoptSchemaOnOpenLayers` does) and, for each
  `TransactionLayer`, rewrite every own-written row's value at the altered column index through the
  same convert function, then rebuild that layer's affected secondary indexes. Add the value-rewrite
  method to `TransactionLayer` (e.g. `convertColumn(colIndex, convert, newSchema)`): it must update
  both `primaryModifications` entries and the `ownWrites` log's `newRow`s so the commit-time rebase
  (`getOwnWrites()` replay in `MemoryTableManager.rebaseLayerOntoHead`) also carries converted
  values. Follow `adoptSchema`/`reindexOwnWrites` for the index-maintenance pattern.

- **Call `adoptSchemaOnOpenLayers` (or the new convert-and-adopt path) for `setDataType`.** Today it
  is gated on `collationChanged` only (`manager.ts:2203`); the type change needs the same
  schema-adoption so the rest of the transaction and the committed head see the new type. If a plain
  `adoptSchema` (schema swap + secondary rebuild) plus the value rewrite is cleaner than extending
  the existing method, either is fine — keep it oldest-first so each layer inherits its parent's
  already-converted trees.

- **PK-column carve-out.** Retyping a primary-key column changes the key encoding (the
  `rekeyPrimaryKey` territory), and is the type-change analogue of the collation PK case parked in
  `alter-collate-pk-in-transaction`. Decide the contract: either handle it via `rekeyPrimaryKey`-style
  re-keying, or reject/`BUSY` a PK-column retype while a transaction is open (mirroring the collate
  carve-out). Whatever is chosen, do not silently corrupt the primary tree; add a guard + test.

- **Rollback safety.** The `catch` in `alterColumn` restores the base schema/tree and rebuilds
  secondaries. Confirm a throw from the new value-rewrite path (it should not throw, since validation
  ran first) still leaves the layer chain consistent; if the rewrite can partially apply across the
  chain, either make it all-or-nothing or extend the rollback.

- **Tests.** Add memory-backend cases to `test/ddl-in-transaction-validation.spec.ts`:
  unconvertible pending value → `MISMATCH`, transaction untouched; convertible committed + pending
  rows → both read back converted, `typeof` = new type, in-transaction and after commit; an
  unconvertible value only in a pending-deleted row → change accepted; a secondary index on the
  column enforces/scans correctly under the converted keys after commit. Optional: a `set default`
  in-transaction regression assertion (documenting the verified non-bug).

- **Docs.** Extend `docs/memory-table.md` § DDL and transactions to note that `set data type`
  now validates and converts the issuing transaction's own rows and survives commit, matching the
  store backend.

## Validation

`cd packages/quereus`, then `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) and
`yarn test`. If touching anything the store path shares, spot-check `yarn test:store` for the
`ddl` / alter cases (slow — stream with `tee`; skip the full suite if wall-clock is a problem and
note the deferral).
