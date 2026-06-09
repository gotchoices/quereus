description: quereus-sync's store-adapter rebuilds PK data keys under the whole-table collation only, ignoring the per-column PK key collation the store now writes. A synced table with a divergent per-column PK collation gets mismatched key bytes on apply (wrong-key insert / missed delete).
files: packages/quereus-sync/src/sync/store-adapter.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/src/common/index.ts, packages/quereus-store/src/index.ts
----

## Problem

`store-pk-collate-physical-rekey` gave the store a **per-column** primary-key key
collation: each text PK column is now encoded under its own declared collation
(`StoreTable.pkKeyCollations` → `buildDataKey(pk, opts, dirs, collations)`), not under one
fixed table-level collation K. Before that ticket a divergent per-column PK collation was
rejected (`UNSUPPORTED`), so K *was* the whole-key collation and every consumer that
re-derived a data key from K agreed with the store.

`quereus-sync` is such a consumer. `applyRowChanges` in
`packages/quereus-sync/src/sync/store-adapter.ts:218` reconstructs the row's data key to
apply a remote insert/update/delete directly against the KV store:

```ts
const encodeOptions = { collation };                       // table-level K only
const pkDirections = tableSchema.primaryKeyDefinition.map(p => !!p.desc);
const dataKey = buildDataKey(pk, encodeOptions, pkDirections);   // ← no 4th (collations) arg
```

It passes **no per-column collations**. So for any synced table with a PK column whose key
collation diverges from K — now reachable via `create table t (x text collate binary
primary key)` on a default NOCASE-K store, or an `alter … set collate` re-key — the sync
adapter computes **different key bytes** than the store module wrote:

- the store keys `'A'` under BINARY → bytes `…41…`;
- the adapter keys `'A'` under K=NOCASE → bytes `…61…`.

Result: a remote **insert/update** lands at a phantom key the store can't see, and a remote
**delete** never matches the store's row → silent divergence / orphaned + phantom rows in a
synced replica. Non-divergent tables (the only kind that existed before the rekey ticket)
are unaffected, which is why nothing caught this.

## Expected behavior

The sync adapter must key rows **identically** to the store module: resolve the per-column
PK key collations from the table schema and pass them as the 4th `buildDataKey` argument,
exactly as `StoreTable` does.

## Fix sketch

- Export `resolvePkKeyCollations(pkDef, columns, fallbackK)` from the `@quereus/store`
  public barrel (`packages/quereus-store/src/common/index.ts` → `src/index.ts`); it is
  currently only re-exported internally to `store-module.ts` from `store-table.ts`.
- In `applyRowChanges`, compute
  `const pkCollations = resolvePkKeyCollations(tableSchema.primaryKeyDefinition, tableSchema.columns, collation)`
  and call `buildDataKey(pk, encodeOptions, pkDirections, pkCollations)`. `collation` (the
  param already threaded in) is the correct fallback K.
- Confirm there is no second data-key reconstruction elsewhere in the sync path (a grep at
  filing time found only this one `buildDataKey` call across quereus-sync /
  quereus-sync-client / sync-coordinator).

## Tests

- A quereus-sync round-trip / apply test that syncs a table with an explicit
  `collate binary` text PK (case-distinct `'a'`/`'A'`) on a default-NOCASE store and asserts
  the applied rows are readable + deletable through the store module (i.e. the adapter's key
  bytes match `StoreTable`'s). Today such a test would write to the wrong key.

## Related / out of scope

- The same adapter applies row changes **directly to the KV store** and (per the same grep)
  never calls `buildIndexKey`, so it does not appear to maintain **secondary indexes** on
  applied changes. That is a separate, pre-existing concern (a synced table with a secondary
  index would have stale index entries regardless of collation); flag it for its own
  investigation rather than folding it in here.
