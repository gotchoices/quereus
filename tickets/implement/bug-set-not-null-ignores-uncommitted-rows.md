----
description: Tightening a column to NOT NULL inside an open transaction ignores the rows that transaction just wrote, so an ALTER that should be rejected is accepted and the table ends up holding a NULL in a column declared to have none. Route the check (and the DEFAULT backfill) through the transaction's own uncommitted rows, on both storage backends and through the isolation overlay.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts          # alterColumn setNotNull arm (2054-2099) + typeConvert machinery it should reuse
  - packages/quereus/src/vtab/memory/layer/manager.ts          # effectiveDdlRows (2942), convertBaseRows (2959), convertColumnOnOpenLayers (3178)
  - packages/quereus-store/src/common/store-module.ts          # alterColumnChange (1808) + alterColumnSetNotNull (1953) — thread & scan `rows`
  - packages/quereus-isolation/src/isolation-module.ts         # alterTable (1280), migrateOverlayForAlter (1582), translateOverlayRow (1746), validateOverlayMigration (1683), deriveAddColumnBackfill (1641)
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts # memory repro lives here
difficulty: hard
----

# `alter column … set not null` does not see the transaction's own rows

## Confirmed reproduction

Memory backend, verified this run (temporary spec, ALTER **accepted** — expected reject):

```sql
create table t (id integer primary key, v text null);
begin;
insert into t values (1, null);
alter table t alter column v set not null;   -- expected CONSTRAINT reject. actual: accepted.
```

The ticket author confirmed the same on the store module behind the isolation layer. The row
survives with `v = null` under a `NOT NULL` column.

## Root cause, per layer

Three storage layers each independently ignore the issuing transaction's own pending rows when
deciding whether to reject or backfill. A sibling fix already exists for the neighbouring
attributes and is the template to copy:

* `alter column … set data type` was fixed for the memory backend in
  `tickets/complete/alter-column-set-data-type-sees-transaction-rows.md`.
* the UNIQUE-DDL analogue (`create unique index`, `add constraint … unique`) was fixed across
  the isolation seam in `isolation-ddl-validation-ignores-overlay-rows`.

### 1. Memory backend — `manager.ts` `alterColumn`, setNotNull arm (lines 2054-2099)

The NULL scan reads `this.baseLayer.primaryTree` (committed only) directly:

```ts
const tree = this.baseLayer.primaryTree;
for (const path of tree.ascending(tree.first())) {
    const row = tree.at(path)!;
    if (row[colIndex] === null) nullRows.push(row);
}
```

Every sibling arm in the same method instead scans `rows ? await rows() : this.effectiveDdlRows()`
(see the setDataType arm at 2129-2145 and `validateUniqueOverEffectiveRows` at 2990). `set not
null` is the only arm that never looks at the effective view, so a pending NULL is invisible → the
ALTER is wrongly accepted.

The **backfill** half is also latently broken. When a literal DEFAULT is present it backfills via
`tree.upsert(newRow)` **in place** on the base tree (2078-2084) and only sets `valuesRewritten`
(→ `rebuildAllSecondaryIndexes`, 2238-2245). Two problems once an open transaction exists:
* in-place mutation of a base tree that open layers derive from is what `inheritree` forbids
  (`MutatedBaseError`) — the very reason setDataType REPLACES the tree (2223-2237); and
* the transaction's own pending NULL rows live in the pending layer, not the base, so `upsert`
  never fills them, and `convertColumnOnOpenLayers` is never called for this path — so a pending
  NULL row would commit unfilled even after a "successful" backfill.

`set not null` backfill is just a column value-map `v => v === null ? defaultLiteral : v`. It should
flow through the **same** machinery setDataType already uses: validate over the effective rows,
`convertBaseRows` + `rebuildPrimaryTreeFromRows` to replace the base, and
`convertColumnOnOpenLayers` to fill the open layers — with no type change and no PK re-key.

### 2. Store backend — `store-module.ts` `alterColumnSetNotNull` (line 1953)

`alterColumnChange` receives `rows` (the isolation-supplied `EffectiveRowSource`) but calls
`alterColumnSetNotNull(table, oldSchema, oldCol, colIndex, change)` (1831) **without** it. The
helper scans `table.rowsWithNullAtIndex(colIndex)` — the store's OWN effective rows. Run directly
that is fine; run behind the isolation layer the issuer's inserts are staged in the overlay, not in
the store, so `rowsWithNullAtIndex` returns 0 and the reject is missed. It must consult `rows` when
supplied, exactly as the store's UNIQUE arms already do (`validateUniqueOverExistingRows`, called
with `rows ? rows() : rowsFromEntries(...)` at 1887-1892). The committed-store backfill via
`mapRowsAtIndex` stays; the overlay-resident pending rows are the isolation layer's job (part 3).

### 3. Isolation layer — `isolation-module.ts`

`alterTable` (1280) already threads the issuer's effective rows down to `underlying.alterTable` as
`rowSource` (1352-1356), so once parts 1-2 consult `rows`, the **issuer reject** case works
end-to-end: the underlying throws CONSTRAINT before any overlay migration → atomic abort.

Two gaps remain, both because the overlay migration only understands `addColumn`:

* **Backfill of the issuer's own overlay rows.** `translateOverlayRow` (1746) treats every
  `alterColumn` as a pure passthrough (`newData = data`, 1769-1774). With a usable DEFAULT the
  issuer's staged NULL rows are never filled, so a commit writes NULL into the now-NOT-NULL column.
  This needs the same treatment `addColumn` gets: a precomputed backfill context
  (`deriveAddColumnBackfill`, 1641 / `AddColumnBackfillContext`, ~line 90) and a per-row value in
  `translateOverlayRow` — but mapping the EXISTING column at `colIndex` (`null → foldedDefault`)
  rather than appending a new one.
* **Foreign overlays.** A different open connection's overlay may hold a NULL under the
  newly-NOT-NULL column. `rowSource` is issuer-only, so the underlying never sees it.
  `validateOverlayMigration` (1683) currently only runs value checks for `addColumn`
  (`if (!addColumnCtx) return`, 1698). It must reject a foreign overlay NULL the same way the
  addColumn NOT-NULL path does — with no usable DEFAULT the overlay is **poisoned** (tier-3 handling
  at 1386-1400); with a DEFAULT it is backfilled during migration. The issuer's own overlay with a
  no-DEFAULT NULL is caught up front by the underlying's throw, so it aborts atomically before
  migration (never poisoned) — same asymmetry addColumn already implements.

## Expected behavior (unchanged from source ticket)

* A NULL in any row the issuing transaction can see (committed or its own pending) rejects the ALTER
  with `CONSTRAINT`, leaving table and transaction untouched.
* A NULL only in a row that transaction has already deleted does **not** block the ALTER (the
  effective view already excludes it).
* With a usable literal DEFAULT, those rows are backfilled instead — pending/overlay rows included.
* A rejection is atomic: nothing mutated, transaction stays usable.

## TODO

### Phase 1 — memory backend

- In `manager.ts` `alterColumn` setNotNull arm (2054-2099), replace the direct
  `baseLayer.primaryTree` scan with a scan over the effective rows (`rows ? for await (rows())`
  else `this.effectiveDdlRows()`), mirroring the setDataType arm at 2129-2145.
- Reject path (no usable literal DEFAULT, any effective NULL): throw `CONSTRAINT` before any
  mutation — the existing pre-mutation ordering + catch already give atomicity.
- Backfill path (usable literal DEFAULT): route through the setDataType machinery instead of the
  in-place `tree.upsert`. Cleanest is to reuse the `typeConvert` seam with a value-map
  `v => v === null ? defaultLiteral : v`: drive `convertBaseRows` + `rebuildPrimaryTreeFromRows`
  (base replacement, 2235-2237) and `convertColumnOnOpenLayers` (open-layer fill, 2268) — no
  `setDataType`/PK-rekey branch, no logical-type change. Retire the `valuesRewritten` in-place
  branch for this arm (or keep it only for the no-open-layers autocommit fast path if measurably
  worth it — default to the unified path).
- Confirm the catch (2280-2299) still restores cleanly (base tree saved in
  `basePrimaryTreeBeforeRekey`, as the typeConvert path already does).

### Phase 2 — store backend

- Pass `rows` from `alterColumnChange` (1831) into `alterColumnSetNotNull`.
- In `alterColumnSetNotNull` (1953), when `rows` is supplied, decide reject-vs-backfill from a scan
  of `rows()` (null at `colIndex`) instead of `table.rowsWithNullAtIndex`; keep the committed-store
  `mapRowsAtIndex` backfill for the store's own rows. Match the `rows ? rows() : <own scan>` shape
  the UNIQUE arm uses at 1887-1892.

### Phase 3 — isolation layer

- Add a setNotNull backfill context analogous to `AddColumnBackfillContext` /
  `deriveAddColumnBackfill` (1641): resolve the folded literal DEFAULT + the new-NOT-NULL flag +
  `colIndex` from the `alterColumn`/`setNotNull` change. Reuse `tryFoldLiteral` as addColumn does.
- Extend `translateOverlayRow` (1746) so an `alterColumn` setNotNull-with-DEFAULT maps the value at
  `colIndex` (`null → foldedDefault`) for non-tombstone rows, instead of the current passthrough.
  Keep the caller's async-backfill-in-loop shape (`computeAddColumnValue` at 1718) if an evaluator
  is ever needed; a literal DEFAULT needs no evaluator.
- Extend `validateOverlayMigration` (1683) to reject a staged NULL at `colIndex` (no usable DEFAULT)
  for the setNotNull change, so the tier-3 foreign path poisons it (1386-1400) and the issuer path
  aborts atomically — matching addColumn's `computeAddColumnValue` CONSTRAINT throw (1727-1732).

### Phase 4 — tests & docs

- Add memory cases to `ddl-in-transaction-validation.spec.ts` (pattern at lines 62-75): pending-only
  NULL rejects; pending row already-deleted does NOT block; usable DEFAULT backfills the pending
  row; rejection leaves the transaction usable (a subsequent statement + rollback/commit works).
- Add store + isolation coverage (issuer reject, issuer DEFAULT-backfill, foreign-overlay poison).
  If a suitable isolation spec exists, extend it; otherwise add one. Run `yarn test` (memory) and
  `yarn test:store` (store path) — stream with `2>&1 | tee`, never silent-redirect.
- Update `docs/memory-table.md` § DDL and transactions to list `set not null` alongside the other
  row-validating DDL now honoring the effective view. Update the spec-file header comment
  (`ddl-in-transaction-validation.spec.ts` lines 1-11) which currently says the store isolation
  overlay does NOT honor these rules — this ticket closes that for `set not null`.

## Notes / scope

* The `set data type` isolation overlay gap is the SAME missing machinery this ticket builds in
  phase 3 (see `alter-column-set-data-type-sees-transaction-rows.md` findings, "Isolation overlay
  not converted"). It is **out of scope** here, but the phase-3 context/translate/validate seam is
  the natural place a later ticket would hook a setDataType overlay convert. Leave a `NOTE:` at the
  new isolation seam pointing this out rather than filing a ticket now.
* The source ticket's scope note asks whether a pending unconvertible row aborts `set data type`
  behind isolation. That is the deferred gap above — not re-investigated here; do not expand this
  ticket to cover it.
