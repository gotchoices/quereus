description: The persistent store writes secondary indexes to disk but never reads them, so a query filtered on an indexed column scans the whole table; add the missing read path so index lookups actually use the index.
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts        # query() dispatch (~636); iterateEffective (~679); analyzePKAccess (~722); buildPKRangeBounds (~806); updateSecondaryIndexes (~1242, index value written ~1296)
  - packages/quereus-store/src/common/store-module.ts        # computeBestAccessPlan secondary-index branch (~1853); buildIndexEntries index value (~967)
  - packages/quereus-store/src/common/key-builder.ts         # buildIndexPrefixBounds (~296); buildIndexKey (~115); incrementLastByte (~376)
  - packages/quereus-store/src/common/encoding.ts            # encodeCompositeKey / getCollationEncoder
  - packages/quereus-isolation/src/isolated-table.ts         # parseIndexFromFilterInfo (~481) — idxStr format + overlay-merge index-order contract to mirror
  - packages/quereus-store/test/pushdown.spec.ts             # access-plan handled-filter assertions
  - packages/quereus-store/test/index-persistence.spec.ts    # index read coverage
  - packages/quereus-store/test/store-ryow.spec.ts           # read-your-own-writes over the index
difficulty: hard
----

# Store: secondary-index scan read arm + access-plan surface

## Problem

The store maintains secondary indexes on every write (`updateSecondaryIndexes`)
but no code ever reads an index entry. `query()` (store-table.ts ~636) can only
seek/scan by primary key (`analyzePKAccess`). A predicate on a secondary-indexed
column falls back to a full table scan. `getBestAccessPlan` (store-module.ts
~1853) deliberately advertises a cheaper cost for an index-eligible predicate but
marks **no** filters handled — so the engine keeps the residual `Filter` and
results are correct but the scan is full-table.

This ticket adds the **read primitive**: derive an encoded byte window over an
index's key space from a leading-column predicate, iterate it (merging pending
transaction ops — read-your-own-writes), resolve each index entry to its base
row, and dispatch `query()` to it. Then `getBestAccessPlan` advertises the index
path with honestly-handled filters.

This ticket does NOT touch UNIQUE enforcement — that is the follow-on ticket
`store-unique-check-via-index`, which builds its point lookup on this primitive.

## Background facts (verified — do not re-derive)

- **Index key layout** (`buildIndexKey`, key-builder.ts ~115):
  `encode(indexValues) ++ encode(pkValues)`. Index-column bytes are encoded under
  the **table key collation K** (`encodeOptions.collation`, default `NOCASE`) —
  NOT the index's per-column declared collation. The PK suffix uses each PK
  column's own key collation (`pkKeyCollations`), so it byte-matches the data
  store's keys.
- **Index entry value is empty today** (`buildIndexEntries` store-module.ts ~967
  writes `new Uint8Array(0)`; `updateSecondaryIndexes` store-table.ts ~1296 puts
  `emptyValue`).
- **`iterateEffective(store, bounds, reverse)`** (store-table.ts ~679) is
  handle-generic: it merges the coordinator's pending ops for **whatever store
  handle it is passed**. Index puts/deletes are queued under the index-store
  handle (`coordinator.put(key, val, indexStore)`), so calling
  `iterateEffective(indexStore, bounds)` already yields the effective (pending-
  over-committed) index-entry stream. Reuse it directly; do not write a parallel
  merge.
- **`idxStr`** carries the chosen index to `query()` in the format
  `idx=<indexName>(<n>);plan=…` (see `isolated-table.ts` `parseIndexFromFilterInfo`
  ~481). The planner emits this idxStr only when the access plan sets both
  `indexName` and `seekColumnIndexes` (rule-select-access-path.ts). `_primary_` /
  `fullscan` are the PK/scan sentinels.
- **Isolation-merge ordering contract (load-bearing):** when the store runs under
  `quereus-isolation`, `isolated-table.ts` passes the SAME idxStr to both its
  in-memory overlay and the underlying store `query()`, then merges the two
  streams by a sort key of `[indexKeyParts…, pkParts…]`
  (`queryOverlayAsMergeEntries` ~564, `buildSortKey` ~600). **The store's index
  scan MUST emit rows in index-key order** (index-column bytes, then PK-suffix
  bytes) — i.e. exactly the order `indexStore.iterate` yields — or the merge
  produces wrong results. Natural byte-order iteration of the index store
  satisfies this; do not reorder after resolving to rows.

## Design decision: how an index entry resolves to a base row

The index entry's key holds the encoded PK in its suffix, but that suffix is
**not recoverable to SqlValues** — a `NOCASE`/`RTRIM` PK column encodes lossily
('Apple' and 'apple' share bytes) — and for a range scan the index-column prefix
length varies per entry, so the suffix boundary is not known without decoding.

**Chosen approach: carry the encoded data key in the index entry value.** Change
the index value from empty to the row's encoded data-key bytes (exactly what
`buildDataKey`/`encodeDataKey` produces). Resolution is then a direct effective
read: `readEffectiveRowByKey(indexEntry.value)`. This is robust for point and
range scans, needs no composite-key decoder, and reuses the existing point-read
merge.

- Write sites to change: `updateSecondaryIndexes` (store-table.ts ~1296) and
  `buildIndexEntries` (store-module.ts ~967) — both must write the encoded data
  key (`newIndexKey`'s corresponding `buildDataKey(newPk, …)` /
  `buildDataKey(pkValues, …)`) as the value instead of the empty array. They
  already compute the PK values, so the data key is one `encodeCompositeKey` call.
- Backwards-compat is explicitly waived (AGENTS.md: "Backwards compat: don't
  worry yet"). An index store written by an older build holds empty values;
  resolving one yields an empty data key → wrong. That is acceptable for now, but
  **state it in the review handoff** and prefer the safest read: if an index
  value is empty, treat the entry as unresolvable and fall back — see Edge cases.
- NOTE tripwire (record at the resolution site as a `// NOTE:` comment): index
  scan does one extra data-store `get` per matched entry (the row lives in the
  data store, not the index). Fine now; if index-covered scans ever dominate a
  profile, consider a covering payload (store the serialized row in the index
  value) — but that costs an index rewrite on every column change, not just index
  columns, so it is deliberately not done here.

## Design: the scan arm

Add to `StoreTable`:

- `analyzeIndexAccess(filterInfo): IndexAccessPattern | null` — parse
  `filterInfo.idxStr` for `idx=<name>(…)`; resolve `<name>` against
  `schema.indexes` (skip and return null for `_primary_`/`fullscan`/unknown, or
  when the parsed index is not in `schema.indexes`). Then, mirroring
  `analyzePKAccess`: collect EQ constraints on the leading index column(s) →
  `point`; else a range (LT/LE/GT/GE) on the **leading** index column → `range`;
  else null. Composite point requires EQ on a contiguous leading prefix of the
  index columns.
- Bound derivation:
  - point / leading-prefix EQ → reuse `buildIndexPrefixBounds(prefixValues,
    {collation: K}, indexDirections)` (already exists, key-builder.ts ~296).
  - leading-column range → a new `buildIndexRangeBounds` mirroring
    `buildPKRangeBounds` (store-table.ts ~806): same GE/GT/LE/LT → gte/lt mapping
    with the same DESC direction swap, but encoding each bound value under **K**
    (the index-column key collation) with the leading index column's direction.
    Keep the MAX lower / MIN upper across constraints; an `undefined` upper
    (increment overflow) leaves that side unbounded (safe superset).
- `scanIndex(indexStore, access, filterInfo)` generator:
  `for await (const entry of iterateEffective(indexStore, access.bounds)) {
     const row = await readEffectiveRowByKey(entry.value);
     if (row && matchesFilters(row, filterInfo)) yield row;
   }`
  `matchesFilters` stays the authoritative, collation-aware row filter — the byte
  window is only ever a **superset** of the qualifying rows (same contract as
  `scanPKRange`).
- `query()` dispatch (store-table.ts ~636): after the PK-point / PK-range arms,
  before the full-scan fallback, try `analyzeIndexAccess`; on a hit, ensure the
  index store (`ensureIndexStore(index.name)`) and `yield* scanIndex(...)`.

## Design: `getBestAccessPlan` surface

In the secondary-index branch (`computeBestAccessPlan` store-module.ts ~1853):

- For an index whose **leading** column has an EQ (point/prefix) or range filter,
  build the plan with `.setIndexName(index.name)` and
  `.setSeekColumns([leadingIndexColumnIndex, …])` so the planner emits an
  `idx=<name>(…)` idxStr, and mark the covered filters handled via
  `setHandledFilters`.
- **Collation-safety guard against under-fetch (mandatory).** The index-column
  window is encoded under K, but `matchesFilters` compares under the *column's
  declared collation*. Marking a filter handled drops the residual Filter, so the
  window must be a guaranteed superset. That holds only when K is
  coarser-or-equal to the column's declared collation. To stay provably safe with
  minimal logic, mark a covered filter handled **only** when the index column is
  non-text, OR its declared collation equals K, OR (K has a registered byte
  encoder AND K is `NOCASE` while the column collation is `BINARY`) — i.e. window
  coarser-or-equal. Otherwise keep the current behavior for that index: advertise
  the cheaper cost but leave the filters **unhandled** (residual Filter retained —
  correct, just not sped up). If K itself has no registered byte encoder
  (`getCollationEncoder(K) === undefined`), do not seek at all (leave unhandled) —
  mirrors `buildPKRangeBounds`' comparator-only fallback.
- Keep advertising PK-ordering only for PK-driven scans; an index scan may
  advertise ordering on the index's leading column later, but that is not required
  here (leaving `providesOrdering` unset keeps any Sort in place — safe).

## Edge cases & interactions

- **Read-your-own-writes over the index.** An index seek inside an open
  transaction must see pending index puts/deletes, not just committed entries.
  Achieved by iterating `iterateEffective(indexStore, …)`. Then resolving via
  `readEffectiveRowByKey` also merges the DATA store's pending ops. Test: within a
  txn, insert a row, seek it by an indexed column; update the indexed column, seek
  the old value (miss) and the new value (hit); delete, seek (miss) — all before
  commit. (Extend `store-ryow.spec.ts`.)
- **Stale index entry vs effective row.** A committed index entry can point at a
  row the current transaction has deleted or whose indexed column it changed. The
  index-store pending merge suppresses/adds the entry; but as defense in depth the
  resolved row is re-checked by `matchesFilters` (a row whose indexed column no
  longer matches is dropped), and a resolved-null row (pending-deleted) is skipped.
  Mirror the memory layer's live-recheck discipline (`checkUniqueViaIndex`).
- **Composite / DESC indexes.** Bound derivation must apply each index column's
  `desc` bit-inversion exactly as `buildIndexKey` does (the `indexDirections`
  array). A DESC leading column swaps the GE/GT/LE/LT → gte/lt assignment (copy
  the table from `buildPKRangeBounds`).
- **NULL bound / `= NULL`.** The planner never pushes `= NULL`; a range op against
  NULL rejects every row in `matchesFilters`. Skip NULL/undefined bound values in
  the window builder (same as `buildPKRangeBounds`).
- **Partial index.** A partial secondary index only stores in-scope rows. A seek
  into it returns a subset of the table restricted to the predicate's scope; that
  is exactly what the planner asked for only if the query predicate implies the
  index predicate. The planner already gates partial-index selection; the store's
  job is only to iterate what is physically present and re-filter with
  `matchesFilters`. Add a test that a partial-index seek never returns an
  out-of-scope row and that a query needing out-of-scope rows does not choose the
  partial index (or, if it does, still returns correct rows via the retained
  residual filter — but with the handled-marking, ensure the planner does not
  push an under-covered predicate; verify in `pushdown.spec.ts`).
- **Empty-value (legacy) index entry.** If an index value is empty (older on-disk
  index, or any code path still writing empty), `readEffectiveRowByKey(empty)`
  keys the data store by a zero-length key — which is a *valid* full-scan lower
  bound, not a row key, so `store.get(empty)` returns null and the entry is
  skipped. Confirm `get` of an empty key returns null across providers (memory /
  LevelDB) and add an assertion; if any provider throws, guard with an
  `entry.value.length === 0 → continue` check. Document in the handoff that old
  index stores need a rebuild to be readable.
- **Isolation overlay merge ordering** (see Background): the scan MUST emit in
  index-key order. Because `iterateEffective(indexStore, …)` yields committed +
  pending in merged byte order and we resolve-in-place without reordering, this
  holds. Add an isolation-path test (extend `isolated-store.spec.ts`) that a
  secondary-index-filtered query over an isolated store returns correct, complete
  rows including overlay-pending inserts/deletes.
- **`query()` arm precedence.** PK point/range must still win when the predicate
  also matches an index (PK is cheaper and already handled). Only reach the index
  arm when `analyzePKAccess` returned `scan`. Preserve that ordering.

## TODO

### Phase 1 — index entry carries the data key
- Change `updateSecondaryIndexes` (store-table.ts ~1296) to write the encoded
  data key (`buildDataKey(newPk, …)`) as the index value instead of `emptyValue`.
- Change `buildIndexEntries` (store-module.ts ~967) to write `buildDataKey(
  pkValues, encodeOptions, pkDirections, pkCollations)` as the value.
- Add the `// NOTE:` tripwire about the extra per-entry data-store get.

### Phase 2 — the scan primitive
- Add `buildIndexRangeBounds` (mirror `buildPKRangeBounds`, encode under K + index
  leading-column direction).
- Add `analyzeIndexAccess(filterInfo)` (parse idxStr; point/range/null).
- Add `scanIndex(indexStore, access, filterInfo)` (iterateEffective → resolve →
  matchesFilters), emitting in index-key order.
- Wire `query()` dispatch between the PK-range arm and the full-scan fallback.

### Phase 3 — access-plan surface
- Rewrite the `computeBestAccessPlan` secondary-index branch to set
  `indexName` + `seekColumns` + handled filters, with the collation-safety guard
  (unhandled-but-cheaper when K may under-fetch or has no encoder).

### Phase 4 — tests + validation
- Extend `pushdown.spec.ts` (handled-filter assertions for index EQ + range;
  collation-guard cases keep filters unhandled), `index-persistence.spec.ts`
  (index seek returns correct rows after reopen), `store-ryow.spec.ts` (pending
  index puts/deletes visible), `isolated-store.spec.ts` (overlay merge over an
  index scan), and a composite/DESC index seek case (new spec or extend
  `pk-desc-iteration.spec.ts` sibling).
- Run `yarn workspace @quereus/quereus-store test 2>&1 | tee /tmp/store-unit.log`
  and `yarn lint`. The full store-path SQL logic suite (`yarn test:store`) is
  slow; run it if wall-clock allows, else defer to the reviewer/CI and say so in
  the handoff (stream with `tee`, never silent redirect).
