description: Review the new `replace-all` `MaintenanceOp` on the memory-table manager — the wholesale, transactional pending-layer replacement (keyed diff → minimal `BackingRowChange[]`) the full-rebuild MV arm will drive.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/vtab/maintenance-replace-all.spec.ts, docs/incremental-maintenance.md
----

## What landed

A new `replace-all` variant on the `MaintenanceOp` union in
`vtab/memory/layer/manager.ts`, handled by `applyMaintenanceToLayer`:

```
| { kind: 'replace-all'; rows: Row[] }
```

It replaces the backing's **entire pending-effective contents** with `rows`,
realized as a **keyed diff by backing PK** against the layer's current rows,
returning the realized minimal `BackingRowChange[]` (the same delta the
MV-over-MV cascade already consumes). The op targets the *pending*
`TransactionLayer` (created lazily, like a user write), so it commits/rolls-back
in lockstep with the source write — unlike the CREATE/REFRESH `replaceBaseLayer`
primitive, which swaps the committed *base* layer and would not roll back on an
aborted statement.

Algorithm (single op):
1. Snapshot current effective rows into a PK-keyed btree (`oldByKey`) via the
   whole-table effective scan (`scanLayerImpl`, no `equalityPrefix`).
2. Build a PK-keyed set of the new rows (`newKeys`) for the delete-pass membership test.
3. **Upsert pass** (new-row input order): `insert` when the key is absent, `update`
   when present and the row differs, **skip** when the row is equal.
4. **Delete pass** (ascending PK order): `recordDelete` every old key absent from the new set.

Both passes go through `recordUpsert`/`recordDelete`, so secondary-index and
change-tracking bookkeeping stay correct. Key matching and the skip-identical
check are **collation-aware**: keys compare via the table's PK comparator
(`comparePrimaryKeys`), and rows compare via a new `rowsEqual` helper using
`compareSqlValues` per column (honoring each column's collation) — never JS `===`.
The switch retains its `never` default, so a future op variant is a compile error.

## How to exercise / validate

Direct layer-level unit tests in `test/vtab/maintenance-replace-all.spec.ts`
(modeled on the sibling `maintenance-prefix-delete.spec.ts`): build a memory table,
`manager.connect()`, call `applyMaintenanceToLayer(conn, [{ kind: 'replace-all', rows }])`,
and assert both the returned `BackingRowChange[]` **and** the resulting primary
(and secondary-index) scan. Cases covered:

- **empty → full** — every new row is an `insert`.
- **full → empty** (`rows: []`) — every current row is a `delete`, ascending PK order.
- **partial overlap** — `insert` + `update` + `delete` + identical-skip, asserting the
  returned changes are *exactly* the minimal delta (updates/inserts in new-row order,
  then deletes in ascending PK order).
- **all-identical replacement** — complete no-op (empty changes, rows unchanged).
- **cross-type numeric** — old `5` (number) seeded via a raw `upsert`, new `5n` (bigint):
  `compareSqlValues`-equal → skipped; JS `===` would have spuriously re-upserted.
- **NOCASE PK, collation-equal skip** — lower-cased keys NOCASE-match stored keys and the
  payload matches → whole replacement is a no-op (stored casing retained).
- **NOCASE PK, collation-equal key + changed payload** — resolves to a single `update`
  that flips the stored key (`'Apple'`→`'apple'`), **not** insert + delete (which would
  leak the old secondary-index entry).
- **secondary index** — insert/update/delete maintained; index scan reflects the new v-set.
- **mixed op batch** — `upsert` then `replace-all` diffs against the *post-upsert* effective
  state (reads-own-writes within the batch).

Commands run (all green):
- `yarn typecheck` — clean.
- `yarn lint` — clean.
- targeted: `maintenance-replace-all.spec.ts` + `maintenance-prefix-delete.spec.ts` — 20 passing.
- `yarn test` (memory) — 5420 passing, 0 failing.
- `yarn test:store` — 5415 passing, 0 failing.

## Store-path parity — resolved

Confirmed **memory-only by design**, no store mirror needed: `MaintenanceOp` /
`applyMaintenanceToLayer` exist only on `MemoryTableManager` and its single consumer
(`database-materialized-views.ts`); MV backing tables are always the `memory` module
(`buildBackingTableSchema` → `getModule('memory')`, and `getBackingManager` throws
otherwise). `yarn test:store` stays green (it never reaches this arm).

## Honest gaps / what to scrutinize

- **Not wired to any producer yet.** Nothing emits a `replace-all` op today — the
  full-rebuild arm that drives it is the next ticket (`mv-full-rebuild-arm`, which has
  `prereq: mv-rebuild-replace-all-op`). So this op is currently exercised **only** by the
  direct unit tests; there is no SQL/sqllogic or end-to-end integration coverage yet, and
  the equivalence harness (`test/incremental/maintenance-equivalence.spec.ts`) is the next
  ticket's gate. Treat the unit suite as a floor, not proof of integration.
- **Row-equality semantics is a judgment call worth a second look.** The ticket body said
  "byte-for-byte equal" in one spot but "honoring collation (`compareSqlValues`)" in another;
  I followed the **collation-honoring** definition (explicit in the edge-cases section). The
  visible consequence: under a NOCASE PK, a new row that differs from its old row *only* by
  the key's letter-case (all other columns equal) is **skipped** — the backing keeps the old
  casing. If the full-rebuild arm ever needs the stored binary value to track the body
  exactly, this skip would need revisiting. Documented inline and in the new doc paragraph.
- **No duplicate-key guard on `rows`.** A `replace-all` with two rows sharing a backing PK
  (a producer bug — the body must be a set, enforced elsewhere via `materializedViewNotASetError`)
  would process both (second sees the first as existing → `update`). Not defended against
  because it cannot arise from a set-producing body; flag if you disagree.
- **Memory cost is the unbounded floor by design.** Builds two ad-hoc btrees (old snapshot +
  new-key set), O(n+m). No row cap here — the cost-gate / size-threshold reject upstream is
  what bounds it (per the ticket). Worth confirming the two-btree approach over, say, removing
  matched keys from `oldByKey` in place — I avoided relying on `deleteAt`-during-later-iteration.
- **Change-emission order** (inserts/updates in input order, deletes in ascending PK order) is
  deterministic and asserted, but is a choice; the cascade consumer is order-insensitive.
