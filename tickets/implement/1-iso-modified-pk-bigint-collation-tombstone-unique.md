description: Fix three isolation-layer robustness defects — a crash on big-integer primary keys, duplicate rows when a case-insensitive key changes case, and a missing uniqueness check when an insert reuses a just-deleted key in the same transaction.
files:
  - packages/quereus-isolation/src/isolated-table.ts        # mergedSecondaryIndexQuery (~397-457); insert tombstone-revival branch (~756-768)
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # add reproducing specs here
  - packages/quereus/src/util/key-serializer.ts             # serializeRowKey / resolveKeyNormalizer (reuse, do not modify)
  - docs/design-isolation-layer.md                          # secondary-index merge + cross-layer constraint sections
difficulty: medium
----

## Summary

Three defects in `packages/quereus-isolation/src/isolated-table.ts`, all confirmed by
code inspection. Bugs 1 & 2 share one fix site; bug 3 is separate. All three are
supported cases that currently crash, duplicate, or corrupt.

## Root cause & fix — bug 1 (bigint PK crash) + bug 2 (NOCASE PK duplicates)

**Site:** `mergedSecondaryIndexQuery` (~lines 397-457). It builds a `Set<string>` of
PKs modified in the overlay, keyed with `JSON.stringify(pk)`:

```ts
// ~411
const modifiedPKs = new Set<string>();
for await (const row of overlay.query(this.createFullScanFilterInfo())) {
    const pk = pkIndices.map(i => row[i]);
    modifiedPKs.add(JSON.stringify(pk));          // <-- crash on bigint; collation-blind
}
// ...
// ~433
for await (const underlyingRow of this.underlyingTable.query!(filterInfo)) {
    const pk = pkIndices.map(i => underlyingRow[i]);
    if (modifiedPKs.has(JSON.stringify(pk))) { continue; }   // <-- same two problems
    ...
}
```

- `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` on a bigint
  PK value → any secondary-index scan while the txn has pending changes on a bigint-PK
  table hard-crashes.
- The string key ignores collation. Under a `NOCASE` PK, an overlay row keyed `"ABC"` and
  the underlying row it shadows keyed `"abc"` produce different JSON strings, so the
  underlying row is NOT excluded → the scan yields both (duplicate).

**Fix:** replace both `JSON.stringify(pk)` sites with the engine's canonical,
collation-aware, bigint-safe key encoder — already exported from `@quereus/quereus` and
used the same way by `packages/quereus-store/src/common/store-module.ts`:

```ts
import { serializeRowKey, resolveKeyNormalizer } from '@quereus/quereus';
```

`serializeRowKey(row, indices, normalizers)` tags bigint as `b:<value>` (no throw) and
applies one string normalizer per column, so `NOCASE`/`RTRIM`/`BINARY` map equal values
to identical keys. Precompute the per-PK-column normalizers once from the PK columns'
declared collation, then key both loops off the underlying/overlay `row` directly:

```ts
const pkNormalizers = pkIndices.map(i =>
    resolveKeyNormalizer(this.tableSchema!.columns[i].collation));
// build:
modifiedPKs.add(serializeRowKey(row, pkIndices, pkNormalizers)!);
// check:
if (modifiedPKs.has(serializeRowKey(underlyingRow, pkIndices, pkNormalizers)!)) continue;
```

Notes:
- `serializeRowKey` returns `string | null` (null iff any indexed value is NULL). PK
  columns are NOT NULL, so null cannot occur here; both sides use the same function so
  they stay consistent regardless. The `!` is safe — add a short comment saying why
  rather than silently coercing.
- `pkIndices` is `getPrimaryKeyIndices()`; `this.tableSchema` is set. Same
  collation-aware intent already present in `getComparePK`/`keysEqual` (see their inline
  comments) — this makes the modified-PK set agree with those comparators.

## Root cause & fix — bug 3 (tombstone-revival skips UNIQUE check)

**Site:** `update()`, `case 'insert'`, the tombstone-revival branch (~756-768):

```ts
const existingRow = await this.getOverlayRow(overlay, pk);
if (existingRow && existingRow[tombstoneIndex] === 1) {
    // Convert tombstone to regular row (delete then re-insert same PK)
    const overlayRow = [...(values ?? []), 0];
    const result = await overlay.update({
        operation: 'update', values: overlayRow, oldKeyValues: pk, onConflict: effectiveOR,
    });
    return this.stripTombstoneFromResult(result, tombstoneIndex);   // <-- no UC check
}
```

When an INSERT reuses a PK tombstoned earlier in the same transaction, this early-returns
without calling `checkMergedUniqueConstraints`. If the revived row collides with a non-PK
UNIQUE constraint, it is missed here and later flushed with `trustedWrite: true` — which
tells `StoreTable`/`MemoryTable` to skip their own UNIQUE re-check (see `UpdateArgs.trustedWrite`
in `packages/quereus/src/vtab/table.ts` and the `trustedWrite` arms in
`packages/quereus-store/src/common/store-table.ts`). Result: an opaque INTERNAL error at
commit, or silent store corruption.

**Fix:** run the same merged UNIQUE check the normal insert path runs (~794), and surface
any REPLACE evictions, before the overlay write:

```ts
if (existingRow && existingRow[tombstoneIndex] === 1) {
    const evicted: Row[] = [];
    const ucResult = await this.checkMergedUniqueConstraints(
        overlay, values!, [pk], tombstoneIndex, args.onConflict, evicted);
    if (ucResult !== null) return ucResult;

    const overlayRow = [...(values ?? []), 0];
    const result = await overlay.update({
        operation: 'update', values: overlayRow, oldKeyValues: pk, onConflict: effectiveOR,
    });
    const stripped = this.stripTombstoneFromResult(result, tombstoneIndex);
    return this.attachEvicted(stripped, evicted, tombstoneIndex);
}
```

`selfPks = [pk]` excludes the row's own PK from conflict detection. This mirrors the
non-tombstone insert path (checkMergedUniqueConstraints at ~794 + `attachEvicted` at ~806);
overlay-internal collisions are still caught by `overlay.update()` itself, so the two
layers together cover the same ground as a fresh insert.

## Reproducing tests (add to `packages/quereus-isolation/test/isolation-layer.spec.ts`)

Existing specs drive everything through `db.exec` with `USING isolated` over a
`MemoryTableModule` underlying (see top of the file). Follow that pattern. Each repro
needs a transaction with **pending overlay changes** so the merge path (not the fast
delegate-to-underlying path) runs.

- **bigint PK secondary-index scan:** table with `id INTEGER PRIMARY KEY` holding bigint
  values plus a secondary index on a non-PK column; `begin`, do a pending write, then a
  query that plans the secondary index. Currently throws
  `TypeError: Do not know how to serialize a BigInt`; after fix it returns rows. (Confirm
  the PK actually surfaces as JS `bigint` at merge time — memory vtab yields bigint for
  large integer literals; use a value beyond `Number.MAX_SAFE_INTEGER` to be sure.)
- **NOCASE PK case-change:** `id TEXT COLLATE NOCASE PRIMARY KEY` + a secondary index;
  seed+commit a row `('abc', ...)`, then in a new txn update its PK to `'ABC'`, then scan
  via the secondary index. Assert exactly one merged row (pre-fix yields two).
- **tombstone-revival UNIQUE collision:** table with PK plus a separate `UNIQUE` column;
  seed+commit rows A (pk=1, u='x') and B (pk=2, u='y'); in one txn `delete` A, then
  `insert` a new row at pk=1 with `u='y'` (collides with B on UNIQUE). Assert a clean
  constraint violation (`StatusCode.CONSTRAINT` / UNIQUE), not an INTERNAL error, and that
  B is intact after rollback.

## TODO

- [ ] Import `serializeRowKey`, `resolveKeyNormalizer` from `@quereus/quereus` in `isolated-table.ts`.
- [ ] Replace both `JSON.stringify(pk)` sites in `mergedSecondaryIndexQuery` with `serializeRowKey` keyed on precomputed per-PK-column normalizers; comment the non-null `!`.
- [ ] Route the insert tombstone-revival branch through `checkMergedUniqueConstraints` + `attachEvicted` before the overlay write.
- [ ] Add the three reproducing specs above to `isolation-layer.spec.ts`.
- [ ] Update `docs/design-isolation-layer.md` — note the modified-PK set uses the canonical collation-aware key encoder, and that tombstone-revival inserts run the merged UNIQUE check.
- [ ] `yarn workspace @quereus/quereus-isolation test 2>&1 | tee /tmp/iso-test.log; tail -n 60 /tmp/iso-test.log` (Windows: `Tee-Object`); then `yarn lint` for signature/type drift.
