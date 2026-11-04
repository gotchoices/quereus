description: Inside a transaction, reading a table wrapped by the isolation layer can return a row twice (once with its old value, once with the new) or return rows in the wrong order, when the underlying module sorts or walks its primary keys differently from the in-memory table that holds the uncommitted changes.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus-isolation/src/isolated-table.ts   # IndexScanInfo (:29), mergedQuery primary branch (:487-492), resolveScanIndex (:619), queryOverlayAsMergeEntries (:883), buildMergeConfig (:940)
  - packages/quereus-isolation/src/merge-iterator.ts   # mergeStreams; unchanged, its "both inputs sorted by the same key" contract is what the fix now honours
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # new describe, next to 'DESC primary key (overlay/underlying merge ordering)' (:6589)
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts  # header comment describes the old requirement
  - packages/quereus/src/vtab/index-descriptor.ts      # doc comment on IndexDescriptor.reverse
  - docs/design-isolation-layer.md                     # "The Problem" (:687), "Solution: Module-Provided Comparator" (:713), "Collation Considerations" (:730-731)
repro: verified
----

## The defect

A merged primary-key read (`IsolatedTable.mergedQuery`, primary branch) walks two streams in step with `mergeStreams`:

- the underlying stream, in the order the underlying module emits it;
- the overlay stream, straight out of the overlay `MemoryTable`, in the memory table's own primary-key order, always forward.

`mergeStreams` needs both inputs ordered by the comparator it is given. Nothing makes the overlay stream satisfy that. There are two ways it fails, both at the same site:

- **Different order.** The underlying supplies a `comparePrimaryKey` that ranks some keys opposite to the memory table. Lamina does this for TIMESPAN and JSON key members, because it keys them by canonical text.
- **Reversed walk.** The underlying drives an `order by k desc` under a primary descriptor with `reverse: true`. `resolveScanIndex` reduces every primary path to `{ type: 'primary' }`, dropping `reverse`, so the merge compares a reversed underlying stream against a forward comparator and a forward overlay stream. The secondary branch already honours `reverse` (`buildMergeConfig`, :978); the primary branch does not.

In either case the merge moves past an underlying row before the staged row that shadows it comes up, so the committed row is emitted as well as its staged replacement.

## Reproduction

Measured at HEAD with the fixture below, an underlying that orders text keys by length then value, so it ranks `b` before `aa` while the overlay ranks `aa` before `b`.

| Scenario | Actual at HEAD | Expected |
| --- | --- | --- |
| rows `aa`, `b`; stage an update of each; `select v from t` | `committed-b, staged-aa, staged-b` | `staged-b, staged-aa` |
| rows `aa`, `b`; delete `aa`, update `b`; `select v from t` | `committed-b, staged-b` | `staged-b` |
| reversed walk, rows `aa`, `b`, `ccc`; update `b`; `select v from t order by k desc` | `staged-b, committed-ccc, committed-aa, committed-b` | `committed-ccc, committed-aa, staged-b` |

The plan for the reversed case is `INDEX SCAN t USING _primary_1 ORDER BY 0 DESC`. The module's ordering claim absorbs the sort, so nothing above the merge corrects the output.

A memory underlying with `order by k desc` and one staged update returns the right rows at HEAD. The likely reason is that nothing asks the memory backend for a reversed walk, so the engine sorts above the scan: a search finds `ordCons` only being read, never emitted, and `packages/quereus/src/vtab/memory/layer/scan-layer.ts:253` says the same for secondary indexes. That query's plan was not inspected.

Fixture (lightly tidied from the version that produced these results, so the first TODO's "confirm both fail" step matters):

```ts
function byLengthThenValue(a: SqlValue, b: SqlValue): number {
	const x = String(a);
	const y = String(b);
	return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

class LengthOrderedTable extends VirtualTable {
	private readonly rows: Row[];

	constructor(db: Database, private readonly mod: LengthOrderedModule, schema: TableSchema) {
		super(db, mod, schema.schemaName, schema.name);
		this.tableSchema = schema;
		const key = `${schema.schemaName}.${schema.name}`.toLowerCase();
		if (!mod.store.has(key)) mod.store.set(key, []);
		this.rows = mod.store.get(key)!;
	}

	comparePrimaryKey(a: SqlValue[], b: SqlValue[]): number {
		return byLengthThenValue(a[0], b[0]);
	}

	async disconnect(): Promise<void> { /* no-op */ }

	async update(args: UpdateArgs): Promise<UpdateResult> {
		if (args.operation === 'insert' && args.values) {
			this.rows.push([...args.values] as Row);
			return { status: 'ok', row: args.values };
		}
		return { status: 'ok' };
	}

	async *query(_filterInfo: FilterInfo): AsyncIterable<Row> {
		const dir = this.mod.reverse ? -1 : 1;
		yield* [...this.rows].sort((a, b) => dir * byLengthThenValue(a[0], b[0]));
	}
}

class LengthOrderedModule implements VirtualTableModule<LengthOrderedTable, BaseModuleConfig> {
	readonly store = new Map<string, Row[]>();

	constructor(readonly reverse = false) {}

	async create(db: Database, schema: TableSchema): Promise<LengthOrderedTable> {
		return new LengthOrderedTable(db, this, schema);
	}

	async connect(db: Database, _pAux: unknown, _m: string, _s: string, _t: string, _o: BaseModuleConfig, schema?: TableSchema): Promise<LengthOrderedTable> {
		return new LengthOrderedTable(db, this, schema!);
	}

	async destroy(): Promise<void> { /* per-instance */ }

	getBestAccessPlan(_db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const builder = AccessPlanBuilder.fullScan(request.estimatedRows ?? 100)
			.setHandledFilters(new Array(request.filters.length).fill(false));
		if (!this.reverse || !request.requiredOrdering?.length) return builder.build();
		const descriptor: IndexDescriptor = { ...primaryKeyDescriptor(tableInfo)!, name: '_primary_1', reverse: true };
		return { ...builder.setOrdering(request.requiredOrdering).setIndexDescriptor(descriptor).build(), orderingIndexName: '_primary_1' };
	}
}
```

The reversed plan has to come from an ordering request. A full-scan plan with only `setIndexName` and a descriptor stays a sequential scan with a `fullScan` access path, so `reverse` never reaches the merge.

## The fix

Sort the overlay entries under the merge's own comparator before merging, on every merged primary-key read, and carry `reverse` through the primary arm.

- `IndexScanInfo` primary arm becomes `{ type: 'primary'; reverse: boolean }`. `resolveScanIndex` passes `false` for `fullScan` and `empty`, and `path.index.reverse === true` for a primary descriptor.
- `buildMergeConfig`'s primary arm sets `compareSortKey` to the negated `comparePK` when reversed. `mergeStreams` already prefers `compareSortKey`. Drop the parameter's default value; both callers pass one.
- The overlay side collects its entries, sorts them by `compareSortKey ?? comparePK` on `sortKey`, and then yields them. `queryOverlayAsMergeEntries` is the natural home, taking the comparator as a parameter, since `mergedQuery` is its only caller.

The sort is unconditional rather than limited to underlying tables that supply `comparePrimaryKey`. A reversed walk needs it whichever comparator is in use, a host-supplied `IsolationConfig.overlay` has no guaranteed order at all, and the secondary branch already does the same thing (`overlayRows.sort`, :574). This removes the "overlay emits in merge order" assumption instead of narrowing it.

Tradeoff: the overlay is no longer read lazily. A merged full scan with a `limit` now reads every staged row in its window before yielding, where it used to stop early. The overlay holds one transaction's staged writes and a seek is still narrowed by the overlay's own query, so this should be small, but the cost has not been measured. Record it with a `NOTE:` at the sort, as the secondary branch does at :549.

### Trial of this fix

The first two table rows and a reversed scenario (updates of `aa` and `b`, insert of `ccc`) pass with these changes applied temporarily, and the rest of the `@quereus/isolation` suite stays green (448 passing, one failure, which came from the reversed test before it was given an ordering request). The trial edit has been removed; the source tree is unchanged. Not yet run against the fix: the third table row exactly as written, and the store, sync and plugin packages that depend on this layer.

### Rejected alternatives

- **Build the overlay `MemoryTable` with the underlying's comparator.** Avoids the sort but ties the overlay's B-tree to a module hook, and does not help a reversed walk.
- **Exclude shadowed rows by a primary-key set, as the secondary branch does.** Independent of order, but it would replace the underlying's comparator with the engine's serialized key identity as the judge of "same row" on this path. The comparator is the contract the module states.

### Limits that remain

- The underlying's scan must agree with its own `comparePrimaryKey`. That is the module's contract, and the fix does not guard it.
- A module that encodes direction only in `idxStr` and does not set `reverse` still merges wrongly. The doc comment on `IndexDescriptor.reverse` lists the memory vtab's `ordCons=DESC` as allowed to do this, but nothing emits it today. Correct that comment rather than adding handling: an emission-order consumer learns direction only from `reverse`.

## TODO

- Add the fixture and two tests to `isolation-layer.spec.ts`: two staged updates under the opposing order (table row 1), and one staged update under the reversed walk (table row 3). Confirm both fail before the source change.
- Add `reverse` to the primary arm of `IndexScanInfo` and set it in `resolveScanIndex`.
- Negate the comparator for a reversed primary scan in `buildMergeConfig`, and drop its default parameter.
- Collect and sort the overlay entries on the primary path, with a `NOTE:` recording the loss of early exit and when to revisit it.
- Update the `mergedQuery` doc comment, which still says both streams share the same sort order.
- Update `docs/design-isolation-layer.md`: state in "The Problem" that the underlying alone sets the merge order; replace the sentence at :713 with what the code does (it neither passes comparators to the overlay nor validates them; it sorts staged entries under the merge comparator for each read, and honours `reverse`); correct "The overlay uses the same comparator" and "Both iterate in the same order" at :730-731.
- Correct the `IndexDescriptor.reverse` doc comment, and the header comment in `key-set-seek-merge.spec.ts` that says the primary-key merge needs both streams in ascending key order.
- Run `yarn workspace @quereus/isolation test`, then `yarn test` for the store, sync and plugin packages, and `yarn build`.
