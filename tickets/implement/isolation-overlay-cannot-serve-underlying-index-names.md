---
description: |
  When the isolation layer wraps a storage module and a transaction has already written, a query that
  scans by a secondary index the underlying module named itself (a synthetic name the isolation layer's
  private scratch table never heard of) crashes with "Secondary index not found" instead of returning
  rows. Only primary-key index names are handled today.
difficulty: hard
files:
  - packages/quereus-isolation/src/isolated-table.ts       # :490 the crash site (overlay.query with foreign idxStr); :443 mergedSecondaryIndexQuery; :543 resolveScanIndex; :594 adaptFilterInfoForOverlay; :663 buildMergeConfig (compareSortKey/extractSortKey)
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts   # :189 the throw ("Secondary index '…' not found")
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts    # resolveIndexSchema — looks names up in the overlay's schema.indexes
  - packages/quereus-isolation/src/filter-info.ts          # makeSecondaryIndexEqSeekFilter / makeFullScanFilterInfo (constraint-carrying filters)
  - packages/quereus-isolation/src/isolation-module.ts     # createOverlaySchema — overlay index set = baseSchema.indexes verbatim
  - packages/quereus-isolation/test/isolation-layer.spec.ts # add regression + reproduction module (see below)
  - packages/quereus/src/vtab/filter-info.ts               # FilterInfo shape: constraints, args, indexInfoOutput, accessPath
---

# Isolation overlay crashes on a secondary index name minted by the underlying module

## State on entry (already reproduced, root-caused, narrowed)

The bug is **live**. Reproduced engine-side (no lamina) by wrapping a custom underlying module that
advertises a `role: 'secondary'` index descriptor named `_compound_v_0` (a name NOT in the table
schema's declared indexes) in `IsolationModule`, staging one overlay write, then scanning by that
index. Exact failure:

```
QuereusError: Secondary index '_compound_v_0' not found.   (StatusCode.INTERNAL)
  scanLayerResolved            vtab/memory/layer/scan-layer.ts:189
  MemoryTable.query            vtab/memory/table.ts
  IsolatedTable.mergedSecondaryIndexQuery  quereus-isolation/src/isolated-table.ts
```

**This is narrower than the original fix ticket described**, because two things it worried about have
since been fixed by the `iso-index-descriptor-engine-seam` / `iso-index-descriptor-isolation-consumer`
tickets (now in `tickets/complete/`):

- The old regex classifier (`PK_INDEX_NAME_RE`) and `getIndexColumnIndices` are **deleted**. The
  isolation layer now reads the planner's typed `FilterInfo.accessPath`. `resolveScanIndex`
  (`isolated-table.ts:543`) takes the secondary scan's `columnIndices` straight from the descriptor's
  `keyColumns` — so the "second, quieter defect" (`getIndexColumnIndices → []` mis-key of the sort
  key) **no longer exists**. Do not re-fix it.
- The **aliased primary-key** case is handled: an aliased-PK descriptor (`role: 'primary'`, name
  `_primary_1`) is retargeted to the overlay's canonical `_primary_` by `adaptFilterInfoForOverlay`
  (`:594`), and an `unresolvedIndex` access path (a name the engine could not resolve AND no
  descriptor) throws loudly rather than mis-merging.

### The single remaining defect

`mergedSecondaryIndexQuery` (`isolated-table.ts:443`) merges the overlay's staged rows with the
underlying's secondary-index stream. Its step 2 (`:487`–`:494`) queries the overlay for its data rows:

```ts
// Step 2: Query overlay via secondary index for non-tombstone data rows
const overlayFilterInfo = this.adaptFilterInfoForOverlay(filterInfo);   // only retargets a PK alias
const overlayRows: Row[] = [];
for await (const row of overlay.query(overlayFilterInfo)) {             // <-- :490 THROWS
	if (row[tombstoneIndex] !== 1) overlayRows.push(row.slice(0, tombstoneIndex));
}
```

`adaptFilterInfoForOverlay` rewrites only a `role: 'primary'` alias; a `role: 'secondary'` descriptor
passes through unchanged, so `overlayFilterInfo` still carries the underlying's `idx=_compound_v_0(…)`
wire string. The overlay is a private `MemoryTable` whose index set is `baseSchema.indexes` verbatim
(`createOverlaySchema`); it never declared `_compound_v_0`, so `scan-plan.resolveIndexSchema` misses
and `scan-layer.ts:189` throws.

The two modules do not share an index vocabulary. An underlying module's scan shapes need not be
schema indexes at all — lamina mints `_column_<id>_`, `_compound_<name>_`, `_nd_<name>_`,
`_intersect_<ids>_`, plus a monotonic per-plan sequence suffix. No name outside the PK family can ever
exist on the overlay, by construction. So this is the general case, not a lamina quirk.

Note the crash site is **only** `:490`. `queryOverlayAsMergeEntries` (`:621`) also calls
`overlay.query`, but it runs only on the primary/full-scan path (from `mergedQuery` `:427`) with an
already-adapted filter, so it is not a second crash site. The UNIQUE-check filters
(`makeSecondaryIndexEqSeekFilter`) only ever name **declared** schema indexes (UNIQUE constraints),
which the overlay does have — also safe.

## The fix

The overlay is a *delta* — it holds only the current transaction's uncommitted writes. It should not
try to reproduce whatever exotic index the underlying chose; it cannot, by construction. Stop asking
it to resolve foreign index names.

**Recommended direction (uniform, covers all underlying index-name families):**

Replace step 2's index-driven overlay query with a **full overlay scan**, then have the isolation
layer itself (a) filter the scanned rows to the query's window and (b) sort them, so the merge stays
correct without the overlay ever seeing the foreign name:

- **One scan, not two.** Step 1 (`:479`–`:485`) already full-scans the overlay to collect
  `modifiedPKs`. Collect the non-tombstone data rows in that **same** full scan (`createFullScanFilterInfo()`,
  which resolves to the overlay's PK walk) — dropping step 2's separate index query entirely, so the
  crash site is gone.
- **Filter in the isolation layer.** A full scan returns every staged row, including rows outside the
  query's `where` window; those must not be yielded. Apply the query's residual constraints
  (`filterInfo.constraints` + `filterInfo.args`, the same EQ/range/IN data `scan-plan.ts` interprets
  via `argvMap`/`findConstraintValueForColumn`) to each overlay row. Implement a small matcher, or
  extract/reuse the constraint-interpretation already in `scan-plan.ts`. **Filter unconditionally** —
  do not rely on the engine adding a residual `Filter` node above the isolation scan, because whether
  it does depends on the underlying's `handledFilters`, which the isolation layer does not control
  (see research note).
- **Sort in the isolation layer.** The merge in step 3 (`:502`–`:526`) walks `overlayRows` with a
  monotonic index and requires them pre-sorted by the sort key. Sort the collected rows with the
  `compareSortKey`/`extractSortKey` already built by `buildMergeConfig` (`:663`). This decouples merge
  correctness from whatever order the overlay's full scan happens to emit — a strict improvement over
  today's reliance on the overlay re-planning the same index.

This is candidate direction #1 from the source ticket, refined. It needs no name classification, no
column-set matching, and handles `_compound_`, `_column_`, `_nd_`, and `_intersect_` identically.

**Alternative (retarget-by-key-columns), documented and rejected as primary:** find an overlay index
whose key columns equal the descriptor's `columnIndices` and `retargetFilterInfoIndex` the filter to
it, so the overlay re-plans and filters itself. Rejected because a synthetic underlying shape
(single-column with no declared index; an index intersection) may match **no** single overlay index,
so it still needs the full-scan fallback — and once you have the fallback, the retarget path is a
pure optimization that duplicates code. If overlay full scans ever show up as hot (see tripwire),
add retarget-by-columns as an optimization on top, not as the correctness path.

### Research note for the implementer

Confirm whether an underlying module that drives a secondary index typically marks its index
constraints as **handled** (`handledFilters[i] = true`) in `getBestAccessPlan`. If handled, the engine
adds no residual `Filter` above the isolation scan, so the isolation layer's own filtering is
**mandatory** for correctness (the recommendation assumes this). If not handled, the engine's residual
Filter would also cover it, but self-filtering is still correct and strictly safer — keep it
unconditional either way. The existing `idx_email` equality test
(`isolation-layer.spec.ts:3234`) merges correctly today *only* because the overlay re-plans `idx_email`
(a declared index) and applies the equality itself — that is exactly the mechanism this fix must
replace for foreign names.

## Reproduction / regression asset

The following underlying module (from the confirmed reproduction) mints a synthetic secondary index
name the overlay cannot know, pinning the contract engine-side without lamina. Add it (and a spec
based on it) to `isolation-layer.spec.ts` as the regression. The spec must assert the merged **row set
AND order**, with a live (dirty) overlay, over the synthetic secondary index. Add a variant with a
`where v = <val>` equality to prove the isolation-side residual filter drops overlay rows outside the
window.

```ts
const SYNTH = '_compound_v_0';                       // NOT a declared schema index
const store = new Map<string, Row[]>();

class SynthUnderlyingTable extends VirtualTable {
	private readonly key: string;
	constructor(db: Database, module: SynthUnderlyingModule, schema: TableSchema) {
		super(db, module, schema.schemaName, schema.name);
		this.tableSchema = schema;
		this.key = `${schema.schemaName}.${schema.name}`.toLowerCase();
		if (!store.has(this.key)) store.set(this.key, []);
	}
	async disconnect(): Promise<void> {}
	async update(args: UpdateArgs): Promise<UpdateResult> {
		const rows = store.get(this.key)!;
		if (args.operation === 'insert' && args.values) {
			rows.push([...args.values]);
			rows.sort((a, b) => Number(a[0]) - Number(b[0]));
			return { status: 'ok', row: args.values };
		}
		return { status: 'ok' };
	}
	async *query(_filterInfo: FilterInfo): AsyncIterable<Row> {   // accepts idx=_compound_v_0; emits in v order
		const rows = [...(store.get(this.key) ?? [])];
		rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
		for (const r of rows) yield r as Row;
	}
}

class SynthUnderlyingModule implements VirtualTableModule<SynthUnderlyingTable, BaseModuleConfig> {
	async create(db: Database, schema: TableSchema) { return new SynthUnderlyingTable(db, this, schema); }
	async connect(db: Database, _p: unknown, _m: string, schemaName: string, tableName: string, _o: BaseModuleConfig, imported?: TableSchema) {
		return new SynthUnderlyingTable(db, this, imported ?? db.schemaManager.getTable(schemaName, tableName)!);
	}
	async destroy(): Promise<void> {}
	getBestAccessPlan(_db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const vIdx = tableInfo.columnIndexMap.get('v')!;
		const descriptor: IndexDescriptor = { name: SYNTH, role: 'secondary', keyColumns: [{ columnIndex: vIdx, desc: false }], unique: false };
		return { handledFilters: new Array(request.filters.length).fill(false), rows: request.estimatedRows ?? 100, cost: 10, indexName: SYNTH, idxNum: 0, indexDescriptor: descriptor } as unknown as BestAccessPlanResult;
	}
}
```

Direct-injection driver that reproduces the crash (mirrors the `_primary_extra` spec at `:3259`):

```ts
const iso = new IsolationModule({ underlying: new SynthUnderlyingModule() });
db.registerModule('isolated', iso);
await db.exec('create table t (id integer primary key, v text) using isolated');
await db.exec("insert into t values (1,'a'),(2,'b'),(3,'c')");            // auto-commit → underlying
const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
const overlay = await iso.overlayModule.create(db, iso.createOverlaySchema(underlying.tableSchema!));
await overlay.update({ operation: 'insert', values: [4, 'd', 0] });        // stage a dirty write
iso.setConnectionOverlay(db, 'main', 't', { overlayTable: overlay, hasChanges: true, db });
const vIdx = underlying.tableSchema!.columnIndexMap.get('v')!;
const idxStr = `idx=${SYNTH}(0);plan=2`;
const base = makeFullScanFilterInfo();
const filter: FilterInfo = {
	...base, idxStr,
	accessPath: { kind: 'index', plan: 'eqSeek', index: { name: SYNTH, role: 'secondary', keyColumns: [{ columnIndex: vIdx, desc: false }], unique: false } },
	indexInfoOutput: { ...base.indexInfoOutput, idxStr },
};
const table = await iso.connect(db, undefined, 'isolated', 'main', 't', {} as unknown as BaseModuleConfig) as IsolatedTable;
const rows = await asyncIterableToArray(table.query!(filter));
// TODAY: throws "Secondary index '_compound_v_0' not found." AFTER FIX: [[1,'a'],[2,'b'],[3,'c'],[4,'d']]
```

(The `BestAccessPlanResult` cast is a shortcut; prefer `AccessPlanBuilder` + `setIndexDescriptor`, as
`packages/quereus/test/vtab/test-aliased-index-module.ts` does, when landing the permanent module.)

## Tripwire (do not file as a ticket — record at the site)

Full-scanning the overlay per merged secondary read is fine while overlays hold one transaction's
writes (small). If isolation-write volume ever makes overlays large and this shows up hot, add the
retarget-by-key-columns optimization (scan the overlay by a same-columns declared index when one
exists, full-scan otherwise). Leave a `// NOTE:` at the merged-scan site saying so.

## TODO

- In `mergedSecondaryIndexQuery`, collect non-tombstone overlay data rows during the existing Step-1
  full scan and delete the Step-2 `overlay.query(overlayFilterInfo)` (the `:490` crash site).
- Apply the query's residual constraints (`filterInfo.constraints` + `args`) to the collected overlay
  rows in the isolation layer — reuse/extract `scan-plan.ts`'s constraint interpretation or write a
  minimal EQ/range/IN matcher over the descriptor's `columnIndices`.
- Sort the collected overlay rows with `buildMergeConfig`'s `compareSortKey`/`extractSortKey` before
  the step-3 merge (removes the dependence on overlay emission order).
- Confirm the primary-key and declared-secondary paths still route unchanged (existing specs must stay
  green — `idx_email`, `_primary_extra`, suffixed-PK suites).
- Add the reproduction module + regression spec above to `isolation-layer.spec.ts`: assert row set AND
  order under a dirty overlay over the synthetic secondary name, plus a `where v = <val>` variant that
  proves out-of-window overlay rows are filtered.
- Leave the full-scan tripwire `// NOTE:` at the merged-scan site.
- `yarn build`, `yarn workspace @quereus/isolation test` (was 210 passing), and `yarn test` green.
- Add one line to the review handoff's `## Review findings` naming the parked tripwire.

## Acceptance (cross-repo)

On landing, the lamina project un-skips
`packages/lamina-quereus-test/src/isolation-overlay-underlying-index-names.test.ts` and closes its
`tickets/blocked/quereus-isolation-overlay-cannot-serve-underlying-index-names.md`. That test is
lamina's acceptance check; the reproduction module above is this repo's own, so the contract is pinned
engine-side independent of lamina.
