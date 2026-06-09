description: Add a transactional `replace-all` maintenance op to the memory-table manager — the wholesale, pending-layer backing replacement the full-rebuild MV arm needs. Keyed diff against current pending contents, emitting the minimal `BackingRowChange[]` so the MV-over-MV cascade is driven unchanged.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database-materialized-views.ts (MaintenanceOp consumer), packages/quereus/test/vtab/ (op unit test), docs/incremental-maintenance.md
----

The full-rebuild materialized-view maintenance arm (later ticket) replaces a backing table's entire contents per writing statement. That replacement must be **transactional** — committing/rolling-back in lockstep with the source write — so it cannot use the CREATE/REFRESH `replaceBaseLayer` primitive, which swaps the committed *base* layer and would not roll back if the statement aborts. This ticket adds the missing primitive: a `MaintenanceOp` that performs a wholesale replacement on the backing's **pending** `TransactionLayer`.

A new variant joins the existing `MaintenanceOp` union (`delete-key` / `upsert` / `delete-by-prefix`) in `vtab/memory/layer/manager.ts`:

```
| { kind: 'replace-all'; rows: Row[] }
```

`applyMaintenanceToLayer` handles it as a **keyed diff** by backing primary key against the layer's current pending-effective contents:

- build the new-row set keyed by backing PK (`primaryKeyFunctions.extractFromRow`);
- scan the current backing rows (same effective-iteration the `delete-by-prefix` arm uses, but over the whole table) into an old-row map keyed by backing PK;
- for each new key: `recordUpsert` (emit `insert` when absent, `update` when the old row differs) — **skip when the old row is byte-for-byte equal** (no-op, no emitted change);
- for each old key absent from the new set: `recordDelete` (emit `delete`).

The returned `BackingRowChange[]` is exactly the realized minimal delta, so a full-rebuild producer drives its MV-over-MV consumers through the existing cascade with no special-casing.

This op is the only structural addition here; wiring it into a maintenance plan is the next ticket.

## Edge cases & interactions
- **Empty new set** (rebuild of an emptied view): every current row is deleted; result is all-`delete` changes.
- **Empty old set** (first write to a never-filled backing): every new row is an `insert`.
- **Identical row at same key**: must be skipped (no emitted `BackingRowChange`, no btree churn) so the cascade and change-events stay minimal and a no-op statement produces no downstream work.
- **Row equality semantics**: use the same value comparison the rest of the manager uses (`compareSqlValues` per column, honoring collation) — not JS `===` — so e.g. equal numerics of differing JS identity are not spuriously re-upserted.
- **Secondary indexes**: `recordUpsert`/`recordDelete` already maintain secondary-index bookkeeping; the diff must go through them (not raw btree writes) so a backing with an auto-index stays consistent.
- **Large new set**: this is the floor's unbounded cost by design; no row cap here (the cost gate / size-threshold reject upstream is what bounds it).
- **Store-path parity**: if the LevelDB store table manager has its own maintenance-op application path, mirror `replace-all` there (or confirm the store backing is always the memory module and this path is memory-only). `yarn test:store` must stay green.
- **Exhaustiveness**: the `MaintenanceOp` switch has a `never` default — adding the variant must extend it so a missing arm is a compile error.

## TODO
- Add the `replace-all` variant to the `MaintenanceOp` union with a doc comment matching the others' tone.
- Implement the keyed-diff handler in `applyMaintenanceToLayer`; return the minimal `BackingRowChange[]`.
- Reuse `compareSqlValues`-based row equality for the skip-identical check.
- Verify/adjust store-path parity; run `yarn test:store`.
- Unit test: empty→full, full→empty, partial overlap (insert+update+delete+identical-skip), collation-sensitive identity, and a backing-with-secondary-index case; assert the returned changes are exactly the minimal delta.
- Update `docs/incremental-maintenance.md` to document the `replace-all` op alongside the existing ops.
