----
description: On persistent-store tables, adding a UNIQUE constraint (or changing a column's text-comparison rule) checks the existing rows for duplicates but skips rows written earlier in the still-open transaction, so a duplicate can survive.
files:
  - packages/quereus-store/src/common/store-module.ts   # validateUniqueOverExistingRows (~1130), call sites ~1450 and ~1704
  - packages/quereus-store/src/common/store-table.ts    # iterateEffectiveEntries (~2177)
  - packages/quereus/test/logic/                        # sqllogic tests
difficulty: easy
----

# Store `ADD CONSTRAINT … UNIQUE` / `SET COLLATE` must validate effective rows

## Background

`StoreModule.buildIndexEntries` takes its row stream as a parameter precisely so
callers can choose visibility, and `createIndex` already passes
`table.iterateEffectiveEntries(buildFullScanBounds())` — committed rows merged with
the open transaction's pending puts/deletes. See the comment block at
`store-module.ts:831-841`.

`validateUniqueOverExistingRows` was never given the same treatment. It takes a
`KVStore` and calls `dataStore.iterate(...)` directly, so it sees committed rows only.
Both of its callers are therefore blind to the current transaction's own writes:

- `alterTable` → `case 'addConstraint'` → `constraint.type === 'unique'` (~line 1450)
- `alterTable` → `SET COLLATE` non-PK re-validation (~line 1704)

Consequence, with the store module:

```sql
begin;
insert into t values (1, 'a'), (2, 'a');
alter table t add constraint u unique (v);   -- accepted; should raise UNIQUE constraint failed
commit;                                       -- table now holds a duplicate under a UNIQUE constraint
```

The equivalent hole in the memory backend is a separate ticket
(`bug-memory-ddl-validation-ignores-pending-rows`) — the two backends do not share
this code.

## Expected behavior

Row-validating DDL sees exactly the rows a `select` in the same transaction would see.
`ADD CONSTRAINT … UNIQUE` and a `SET COLLATE` that narrows a covering UNIQUE must raise
`UNIQUE constraint failed` when the transaction's own uncommitted rows already violate
the constraint.

## Shape of the fix

Change `validateUniqueOverExistingRows` to take an `AsyncIterable<KVEntry>` instead of a
`KVStore`, mirroring `buildIndexEntries`. Both call sites pass
`table.iterateEffectiveEntries(buildFullScanBounds())` and no longer need to
`getStore(...)` first. The body is otherwise unchanged — it already deserializes each
entry's value and never touches the store handle for anything else.

Update the method's doc comment: the `dataStore` paragraph becomes an `entries`
paragraph explaining that callers pass the effective (pending-over-committed) stream, and
why (a validator that ignored pending rows would let a same-transaction duplicate through).

Note that no store mutation happens in either arm before the validation returns, so a
throw still leaves the table untouched — the existing "throws BEFORE any mutation/persist"
guarantee in the `SET COLLATE` comment stays true.

## Adjacent hazard — do not fix here

The `SET COLLATE`-on-a-PK-column arm (`rekeyRows` + `rebuildSecondaryIndexes`, ~1718)
re-encodes the *committed* data store in place while the coordinator still holds pending
ops keyed under the old bytes. That is a distinct defect, tracked as
`bug-store-alter-rekey-ignores-pending-ops` in `tickets/fix/`. Leave `rebuildSecondaryIndexes`
reading the raw committed stream (its own comment explains why) and do not widen scope.

## TODO

- Change `validateUniqueOverExistingRows(dataStore: KVStore, …)` to
  `validateUniqueOverExistingRows(entries: AsyncIterable<KVEntry>, …)`; iterate `entries`.
- Update its doc comment to explain the effective-stream contract, referencing
  `buildIndexEntries`'s identical parameterization.
- Update the `addConstraint` unique call site to pass `table.iterateEffectiveEntries(buildFullScanBounds())`;
  drop the now-unused `getStore` call.
- Update the `SET COLLATE` non-PK re-validation call site the same way; hoist the single
  `iterateEffectiveEntries` call per constraint (it is a fresh async generator each time,
  so call it inside the `for (const uc of coveringConstraints)` loop).
- Add a mocha spec under `packages/quereus-store/test/` (alongside `alter-table.spec.ts`,
  which shows the harness for a store-backed `Database`). Cases: inside `begin`, insert two
  rows that collide, `alter table … add constraint … unique (v)` ⇒ rejected with
  `UNIQUE constraint failed`; pending rows that do NOT collide ⇒ constraint accepted and a
  subsequent colliding insert in the same transaction is rejected; the same pair for
  `alter table … alter column v set collate nocase` over a UNIQUE column holding pending
  `'a'` / `'A'`.
- Do NOT add sqllogic coverage here — the logic suite runs against the memory backend by
  default, which still has the same hole until `bug-memory-ddl-validation-ignores-pending-rows`
  lands. That ticket adds the shared sqllogic file.
- Run `yarn workspace @quereus/quereus-store test` and `yarn test`; `yarn lint`.
