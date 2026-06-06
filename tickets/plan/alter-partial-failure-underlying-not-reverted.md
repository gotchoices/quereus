description: ALTER TABLE through the isolation layer applies the change to the shared underlying/base table immediately (before migrating per-connection overlays). If the subsequent overlay migration throws — e.g. a NOT NULL per-row backfill rejection, or the INTERNAL "tombstone column missing" guard — the underlying schema/data change is left in place while the engine skips the schema-catalog update. Investigate whether mid-transaction ALTER should be atomic (revert the underlying on overlay-migration failure) and how that interacts with DDL not being overlay-staged.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus/src/runtime/emit/alter-table.ts
----

## Concern

`IsolationModule.alterTable` (packages/quereus-isolation/src/isolation-module.ts) does:

```
const updated = await this.underlying.alterTable(db, schemaName, tableName, change);
// ...then, for each affected per-connection overlay:
const newState = await this.migrateOverlayForAlter(db, oldState, updated, change, dropColumnIdx);
```

`underlying.alterTable` mutates the **shared** underlying/base table (memory base layer or
store) right away — DDL is not overlay-staged. The per-connection overlay migration runs
afterward and can throw:

- a `CONSTRAINT` from the NOT NULL per-row backfill check in `computeAddColumnValue`
  (added by `alter-add-column-overlay-staged-rows-default-backfill`), or
- the pre-existing `INTERNAL` "Tombstone column '…' missing from overlay schema" guard, or
- any error surfacing from `overlayModule.create` / `newOverlayTable.update`.

When it does, the underlying is already altered (its committed rows migrated to the new
column layout) while the engine — seeing the throw propagate out of `module.alterTable` —
does not update the schema catalog. The connection that issued the ALTER will roll back its
own overlay, but the **shared base** retains the structural change, which other connections
may observe.

This is **pre-existing** (it predates the default-backfill fix; that fix only adds one more
throw site that mirrors committed-row semantics) and is fundamentally about mid-transaction
DDL not being transaction-scoped in the isolation layer.

## Why this is a backlog item, not an inline fix

- It is architectural (DDL isolation / atomicity), not a regression in the default-backfill
  change.
- A correct fix likely needs the underlying module to expose a rollback/inverse for the
  applied change, or the isolation layer to validate the overlay backfill (dry-run the
  per-row NOT NULL check) **before** calling `underlying.alterTable`, or to stage DDL.
- Each option has trade-offs that warrant design discussion.

## Acceptance ideas (for whoever picks this up)

- Decide the intended semantics for a mid-transaction ALTER whose overlay migration fails:
  is the underlying expected to be reverted, or is partial application acceptable and merely
  to be documented at the API boundary?
- If atomicity is desired: either pre-validate the overlay backfill before mutating the
  underlying, or wrap `underlying.alterTable` + overlay migration so a failure reverts both.
- Add a test that asserts the chosen behavior (e.g. ALTER ADD COLUMN NOT NULL DEFAULT
  (new.x) with a NULL-yielding staged row → after the throw, the underlying base table's
  column set is unchanged, or is documented as changed).
