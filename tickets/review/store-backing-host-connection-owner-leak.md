description: Fix memory leak where store connections registered under the bare table name were never evicted on drop/rename because the cleanup code expects the schema-qualified name.
files:
  - packages/quereus-store/src/common/backing-host.ts          # connect() now uses qualified name
  - packages/quereus-store/src/common/store-table.ts            # ensureCoordinator() now uses qualified name
  - packages/quereus-store/test/backing-connection-leak.spec.ts # new regression tests
----

## What changed

Two one-line fixes, each aligning the store's connection naming with the memory module's convention:

**`backing-host.ts` `connect()` (line 134):**
```ts
// before
return new StoreConnection(this.table.tableName, this.coordinator, this.table);
// after
return new StoreConnection(`${this.table.schemaName}.${this.table.tableName}`, this.coordinator, this.table);
```

**`store-table.ts` `ensureCoordinator()` (line 549):**
```ts
// before
this.connection = new StoreConnection(this.tableName, coordinator);
// after
this.connection = new StoreConnection(`${this.schemaName}.${this.tableName}`, coordinator);
```

Both `StoreTable` and `StoreBackingHost` already expose `schemaName`, so no new fields were needed.

## New regression test

`packages/quereus-store/test/backing-connection-leak.spec.ts` — two cases:
1. **MV-backing host connections** — 10× drop/recreate of `create materialized view mv using store as select …` must keep `db.getAllConnections().length` flat at baseline.
2. **Ordinary DML connections** — 10× drop/recreate of a plain `create table … using store` with an INSERT per cycle must keep the count flat.

The test casts `db` as `{ getAllConnections(): unknown[] }` to access `DatabaseInternal`'s method without importing internal types.

## Validation

- `yarn workspace @quereus/store run test`: **658 passing** (was 656 before; both new regression tests pass)
- `yarn workspace @quereus/quereus run lint`: **exit 0**, no errors

## Known gaps / notes for reviewer

- The `connectionId` string is now `store-main.churn-<n>` instead of `store-churn-<n>`. This is cosmetic only (logs + opaque map key); the ticket's analysis confirmed no consumer assumes the bare-name format.
- The fix covers both leak shapes (host-connection `StoreTable` pin AND unbounded DML connection growth) because `removeConnectionsForTable` is the sole cleanup site and it already ran on every drop/rename — it just never matched.
- No engine changes were needed.

## Review findings

_To be filled by the reviewer._
