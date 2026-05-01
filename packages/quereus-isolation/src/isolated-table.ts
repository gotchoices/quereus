import type { Database, DatabaseInternal, MaybePromise, Row, SqlValue, TableIndexSchema as IndexSchema, FilterInfo, SchemaChangeInfo, UpdateArgs, VirtualTableConnection, UpdateResult } from '@quereus/quereus';
import { VirtualTable, compareSqlValues, isUpdateOk, IndexConstraintOp, ConflictResolution } from '@quereus/quereus';
import type { IsolationModule, ConnectionOverlayState } from './isolation-module.js';
import { IsolatedConnection, type IsolatedTableCallback } from './isolated-connection.js';
import { mergeStreams, createMergeEntry, createTombstone } from './merge-iterator.js';
import type { MergeEntry, MergeConfig } from './merge-types.js';

/**
 * Information about which index is being scanned.
 */
type IndexScanInfo =
	| { type: 'primary' }
	| { type: 'secondary'; indexName: string; columnIndices: number[] };

/**
 * A table wrapper that provides transaction isolation via an overlay.
 *
 * Each IsolatedTable instance accesses a connection-scoped overlay that is:
 * - Created lazily on first write
 * - Shared across all IsolatedTable instances in the same transaction
 * - Stored in the IsolationModule's connection overlay map
 *
 * This provides true per-connection isolation - each connection's uncommitted
 * changes are invisible to other connections, but visible to all queries
 * within the same connection.
 *
 * Reads merge overlay changes with underlying data.
 * Writes go to overlay only until commit.
 */
export class IsolatedTable extends VirtualTable implements IsolatedTableCallback {
	private readonly isolationModule: IsolationModule;
	private readonly underlyingTable: VirtualTable;
	private readonly readCommitted: boolean;

	private registeredConnection: IsolatedConnection | null = null;

	/**
	 * Tracks savepoint depths that were created before the overlay existed.
	 * When rolling back to one of these savepoints, the overlay is cleared
	 * entirely (restoring the "no uncommitted changes" state).
	 */
	private savepointsBeforeOverlay: Set<number> = new Set();

	constructor(
		db: Database,
		module: IsolationModule,
		underlyingTable: VirtualTable,
		readCommitted: boolean = false
	) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		super(db, module as any, underlyingTable.schemaName, underlyingTable.tableName);
		this.isolationModule = module;
		this.underlyingTable = underlyingTable;
		this.readCommitted = readCommitted;
		// Schema comes from underlying - may be populated lazily by the underlying module
		this.tableSchema = underlyingTable.tableSchema;
	}

	/**
	 * Gets the tombstone column name from the module.
	 */
	private get tombstoneColumn(): string {
		return this.isolationModule.tombstoneColumn;
	}

	/**
	 * Gets the connection-scoped overlay state, or undefined if no overlay exists yet.
	 */
	private getOverlayState(): ConnectionOverlayState | undefined {
		return this.isolationModule.getConnectionOverlay(this.db, this.schemaName, this.tableName);
	}

	/**
	 * Gets the overlay table, or undefined if no overlay exists yet.
	 */
	private get overlayTable(): VirtualTable | undefined {
		return this.getOverlayState()?.overlayTable;
	}

	/**
	 * Gets whether this connection has uncommitted changes.
	 */
	private get hasChanges(): boolean {
		return this.getOverlayState()?.hasChanges ?? false;
	}

	/**
	 * Sets the hasChanges flag in the connection-scoped overlay state.
	 */
	private setHasChanges(value: boolean): void {
		const state = this.getOverlayState();
		if (state) {
			state.hasChanges = value;
		}
	}

	/**
	 * Lazily creates the overlay table on first write.
	 *
	 * The overlay is stored in connection-scoped storage, so it persists
	 * across multiple IsolatedTable instances within the same transaction.
	 *
	 * The schema is obtained from the underlying table at this point,
	 * supporting scenarios where schema is discovered lazily from storage.
	 */
	private async ensureOverlay(): Promise<VirtualTable> {
		// Check if overlay already exists for this connection
		const existingState = this.getOverlayState();
		if (existingState) {
			return existingState.overlayTable;
		}

		// Get schema from underlying table (may have been populated lazily)
		const schema = this.underlyingTable.tableSchema;
		if (!schema || schema.columns.length === 0) {
			throw new Error(
				`Cannot create isolation overlay: underlying table '${this.tableName}' has no schema. ` +
				'Ensure the underlying module provides schema before performing writes.'
			);
		}

		// Update our schema reference in case it was populated lazily
		this.tableSchema = schema;

		// Create overlay schema with tombstone column
		const overlaySchema = this.isolationModule.createOverlaySchema(schema);

		// Create the overlay table.
		// overlaySchema already contains indexes (copied from the base schema by
		// createOverlaySchema), so the overlay's BaseLayer initialises all secondary
		// indexes from the schema during construction.  No explicit createIndex loop
		// is needed, and calling it would throw a "duplicate index" error.
		const overlayTable = await this.isolationModule.overlayModule.create(this.db, overlaySchema);

		// Store in connection-scoped storage
		const state: ConnectionOverlayState = {
			overlayTable,
			hasChanges: false,
		};
		this.isolationModule.setConnectionOverlay(this.db, this.schemaName, this.tableName, state);

		return overlayTable;
	}

	/**
	 * Ensures a connection is registered with the database for transaction coordination.
	 * This is called before any read or write operation.
	 */
	private async ensureConnection(): Promise<IsolatedConnection> {
		if (!this.registeredConnection) {
			// Create connection - overlay connection created lazily if needed
			const overlayConn = this.overlayTable
				? await Promise.resolve(this.overlayTable.createConnection?.())
				: undefined;

			this.registeredConnection = new IsolatedConnection(
				this.tableName,
				undefined,
				overlayConn,
				this
			);

			// Register connection with the database for transaction management
			await (this.db as DatabaseInternal).registerConnection(this.registeredConnection);
		}
		return this.registeredConnection;
	}

	// ==================== Connection Management ====================

	/**
	 * Creates a new isolated connection for transaction support.
	 * The connection includes this table as a callback so commit/rollback
	 * operations properly flush/clear the overlay.
	 */
	createConnection(): MaybePromise<VirtualTableConnection> {
		const underlyingConn = this.underlyingTable.createConnection?.();
		// Overlay connection created lazily - may not exist yet
		const overlayConn = this.overlayTable?.createConnection?.();

		// Handle sync/async connection creation
		if (underlyingConn instanceof Promise || overlayConn instanceof Promise) {
			return this.createConnectionAsync(underlyingConn, overlayConn);
		}

		return new IsolatedConnection(
			this.tableName,
			underlyingConn,
			overlayConn,
			this  // Include callback for commit/rollback handling
		);
	}

	private async createConnectionAsync(
		underlyingConn: MaybePromise<VirtualTableConnection> | undefined,
		overlayConn: MaybePromise<VirtualTableConnection> | undefined
	): Promise<VirtualTableConnection> {
		const [underlying, overlay] = await Promise.all([
			underlyingConn,
			overlayConn,
		]);
		return new IsolatedConnection(this.tableName, underlying, overlay, this);
	}

	// ==================== Query Operations ====================

	/**
	 * Query the table, merging overlay with underlying.
	 *
	 * When overlay is empty or doesn't exist, delegates directly to underlying for efficiency.
	 * When overlay has changes, merges both streams using the appropriate key order.
	 *
	 * For primary key scans: merge by PK order
	 * For secondary index scans: merge by (indexKey, PK) order
	 */
	query(filterInfo: FilterInfo): AsyncIterable<Row> {
		if (!this.underlyingTable.query) {
			throw new Error('Underlying table does not support query');
		}

		// Fast path: no overlay or no changes, or a committed-snapshot read — skip overlay
		if (this.readCommitted || !this.overlayTable || !this.hasChanges) {
			return this.underlyingTable.query(filterInfo);
		}

		// Merge overlay with underlying (with connection ensured)
		return this.mergedQueryWithConnection(filterInfo);
	}

	/**
	 * Wrapper that ensures connection before merging.
	 */
	private async *mergedQueryWithConnection(filterInfo: FilterInfo): AsyncGenerator<Row> {
		await this.ensureConnection();
		yield* this.mergedQuery(filterInfo);
	}

	/**
	 * Performs merged query combining overlay and underlying data.
	 *
	 * For primary key scans: uses position-based merge since both streams share
	 * the same sort order and overlay entries align with underlying rows by PK.
	 *
	 * For secondary index scans: uses PK-exclusion approach because overlay entries
	 * may have different index key values than the underlying rows they shadow
	 * (tombstones have null non-PK columns; updates may change the indexed column).
	 */
	private async *mergedQuery(filterInfo: FilterInfo): AsyncGenerator<Row> {
		const overlay = this.overlayTable;
		if (!overlay) {
			yield* this.underlyingTable.query!(filterInfo);
			return;
		}

		const indexInfo = this.parseIndexFromFilterInfo(filterInfo);

		if (indexInfo.type === 'secondary') {
			yield* this.mergedSecondaryIndexQuery(overlay, filterInfo, indexInfo);
			return;
		}

		// Primary key scan - use standard sort-key merge
		const overlayFilterInfo = this.adaptFilterInfoForOverlay(filterInfo);
		const overlayStream = this.queryOverlayAsMergeEntries(overlay, overlayFilterInfo, indexInfo);
		const underlyingStream = this.underlyingTable.query!(filterInfo);
		const mergeConfig = this.buildMergeConfig(indexInfo);
		yield* mergeStreams(overlayStream, underlyingStream, mergeConfig);
	}

	/**
	 * Merged query strategy for secondary index scans.
	 *
	 * Instead of position-based merging (which fails when overlay entries have
	 * different index key values than the underlying rows they shadow), this:
	 * 1. Collects all PKs modified in the overlay (full scan)
	 * 2. Queries underlying via secondary index, excluding modified PKs
	 * 3. Queries overlay via secondary index for non-tombstone data rows
	 * 4. Merges the two disjoint, sorted streams by sort key
	 */
	private async *mergedSecondaryIndexQuery(
		overlay: VirtualTable,
		filterInfo: FilterInfo,
		indexInfo: IndexScanInfo & { type: 'secondary' }
	): AsyncGenerator<Row> {
		if (!overlay.query) {
			yield* this.underlyingTable.query!(filterInfo);
			return;
		}

		const pkIndices = this.getPrimaryKeyIndices();
		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);

		// Step 1: Collect all PKs modified in overlay (full scan)
		const modifiedPKs = new Set<string>();
		for await (const row of overlay.query(this.createFullScanFilterInfo())) {
			const pk = pkIndices.map(i => row[i]);
			modifiedPKs.add(JSON.stringify(pk));
		}

		// Step 2: Query overlay via secondary index for non-tombstone data rows
		const overlayFilterInfo = this.adaptFilterInfoForOverlay(filterInfo);
		const overlayRows: Row[] = [];
		for await (const row of overlay.query(overlayFilterInfo)) {
			if (row[tombstoneIndex] !== 1) {
				overlayRows.push(row.slice(0, tombstoneIndex));
			}
		}

		// Step 3: Query underlying via secondary index, filter out modified PKs
		const mergeConfig = this.buildMergeConfig(indexInfo);
		const compareSortKey = mergeConfig.compareSortKey ?? mergeConfig.comparePK;
		const extractSortKey = mergeConfig.extractSortKey ?? mergeConfig.extractPK;

		// Merge two sorted, disjoint streams
		let oi = 0;
		for await (const underlyingRow of this.underlyingTable.query!(filterInfo)) {
			const pk = pkIndices.map(i => underlyingRow[i]);
			if (modifiedPKs.has(JSON.stringify(pk))) {
				continue; // Skip rows modified in overlay
			}

			// Yield any overlay rows that sort before this underlying row
			while (oi < overlayRows.length) {
				const oKey = extractSortKey(overlayRows[oi]);
				const uKey = extractSortKey(underlyingRow);
				if (compareSortKey(oKey, uKey) <= 0) {
					yield overlayRows[oi++];
				} else {
					break;
				}
			}

			yield underlyingRow;
		}

		// Yield remaining overlay rows
		while (oi < overlayRows.length) {
			yield overlayRows[oi++];
		}
	}

	/**
	 * Parses FilterInfo to determine which index is being used.
	 * Returns null for full table scan or primary key scan, index name for secondary indexes.
	 */
	private parseIndexFromFilterInfo(filterInfo: FilterInfo): IndexScanInfo {
		const { idxStr } = filterInfo;
		if (!idxStr) {
			return { type: 'primary' };
		}

		// Parse idxStr format: "idx=indexName(n);plan=2;..."
		const params = new Map<string, string>();
		idxStr.split(';').forEach(part => {
			const [key, value] = part.split('=', 2);
			if (key && value !== undefined) params.set(key, value);
		});

		const idxMatch = params.get('idx')?.match(/^(.*?)\((\d+)\)$/);
		if (!idxMatch) {
			return { type: 'primary' };
		}

		const indexName = idxMatch[1];
		if (indexName === '_primary_') {
			return { type: 'primary' };
		}

		// Secondary index scan
		return {
			type: 'secondary',
			indexName,
			columnIndices: this.getIndexColumnIndices(indexName),
		};
	}

	/**
	 * Gets the column indices for a secondary index.
	 */
	private getIndexColumnIndices(indexName: string): number[] {
		const schema = this.tableSchema;
		if (!schema?.indexes) return [];

		const index = schema.indexes.find(idx => idx.name.toLowerCase() === indexName.toLowerCase());
		if (!index) return [];

		return index.columns.map(col => col.index);
	}

	/**
	 * Adapts FilterInfo for the overlay table schema (which has an extra tombstone column).
	 * The constraints and index references remain the same since the overlay has matching indexes.
	 */
	private adaptFilterInfoForOverlay(filterInfo: FilterInfo): FilterInfo {
		// The overlay table has the same schema plus a tombstone column at the end.
		// Column indices for data columns are the same, so FilterInfo constraints work as-is.
		// The overlay module will interpret the constraints correctly.
		return filterInfo;
	}

	/**
	 * Queries the overlay table and converts rows to MergeEntry format.
	 *
	 * Uses the same FilterInfo as the underlying query so both streams are in the same order.
	 * For secondary index scans, the sort key includes both the index key and primary key.
	 */
	private async *queryOverlayAsMergeEntries(
		overlay: VirtualTable,
		filterInfo: FilterInfo,
		indexInfo: IndexScanInfo
	): AsyncGenerator<MergeEntry> {
		if (!overlay.query) {
			return;
		}

		const pkIndices = this.getPrimaryKeyIndices();
		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);

		// Query overlay with the same filter constraints
		for await (const overlayRow of overlay.query(filterInfo)) {
			const isTombstone = overlayRow[tombstoneIndex] === 1;
			const pk = pkIndices.map(i => overlayRow[i]);

			// Build sort key based on index type
			const sortKey = this.buildSortKey(overlayRow, pkIndices, indexInfo);

			if (isTombstone) {
				yield createTombstone(pk, sortKey);
			} else {
				// Remove the tombstone column from the row before yielding
				const dataRow = overlayRow.slice(0, tombstoneIndex);
				yield createMergeEntry(dataRow, pk, sortKey);
			}
		}
	}

	/**
	 * Builds the sort key for a row based on the index being scanned.
	 *
	 * For primary key scans: sort key is the PK
	 * For secondary index scans: sort key is [indexKeyParts..., pkParts...]
	 */
	private buildSortKey(row: Row, pkIndices: number[], indexInfo: IndexScanInfo): SqlValue[] {
		if (indexInfo.type === 'primary') {
			return pkIndices.map(i => row[i]);
		}

		// Secondary index: combine index key columns with PK columns
		const indexKey = indexInfo.columnIndices.map(i => row[i]);
		const pk = pkIndices.map(i => row[i]);
		return [...indexKey, ...pk];
	}

	/**
	 * Builds the merge configuration using this table's key functions.
	 *
	 * For primary key scans: compare by PK
	 * For secondary index scans: compare by (indexKey, PK) using underlying's comparator
	 *
	 * @param indexInfo Which index is being scanned. Defaults to primary key scan.
	 */
	private buildMergeConfig(indexInfo: IndexScanInfo = { type: 'primary' }): MergeConfig {
		const pkIndices = this.getPrimaryKeyIndices();

		const extractPK = (row: Row) => pkIndices.map(i => row[i]);
		const comparePK = this.getComparePK();

		if (indexInfo.type === 'primary') {
			// Primary key scan - sort key equals PK
			return {
				extractPK,
				comparePK,
				// No need for separate sort key functions - defaults to PK
			};
		}

		// Secondary index scan - sort key is (indexKey, PK)
		const indexColIndices = indexInfo.columnIndices;
		const extractSortKey = (row: Row): SqlValue[] => {
			const indexKey = indexColIndices.map(i => row[i]);
			const pk = pkIndices.map(i => row[i]);
			return [...indexKey, ...pk];
		};

		// Try to use the underlying table's per-column index comparators if available
		const indexComparators = this.underlyingTable.getIndexComparator?.(indexInfo.indexName);
		const compareSortKey = this.buildCompareSortKey(indexColIndices.length, comparePK, indexComparators);

		return {
			extractPK,
			comparePK,
			extractSortKey,
			compareSortKey,
		};
	}

	/**
	 * Gets the primary key comparator, preferring the underlying table's comparator.
	 */
	private getComparePK(): (a: SqlValue[], b: SqlValue[]) => number {
		// Use underlying table's comparator if available for consistent ordering
		if (this.underlyingTable.comparePrimaryKey) {
			return this.underlyingTable.comparePrimaryKey.bind(this.underlyingTable);
		}

		// Fallback to default comparator
		return (a: SqlValue[], b: SqlValue[]) => {
			for (let i = 0; i < a.length; i++) {
				const cmp = compareSqlValues(a[i], b[i]);
				if (cmp !== 0) return cmp;
			}
			return 0;
		};
	}

	/**
	 * Builds a sort key comparator for secondary index scans.
	 *
	 * Compares by index key columns first (using per-column comparators that
	 * incorporate DESC ordering and collation), then by PK columns.
	 */
	private buildCompareSortKey(
		indexKeyLength: number,
		comparePK: (a: SqlValue[], b: SqlValue[]) => number,
		indexComparators?: ((a: SqlValue, b: SqlValue) => number)[]
	): (a: SqlValue[], b: SqlValue[]) => number {
		return (a: SqlValue[], b: SqlValue[]) => {
			// Compare index key portion first
			for (let i = 0; i < indexKeyLength; i++) {
				const cmp = indexComparators?.[i]
					? indexComparators[i](a[i], b[i])
					: compareSqlValues(a[i], b[i]);
				if (cmp !== 0) return cmp;
			}

			// Index keys equal - compare PK portion
			const pkA = a.slice(indexKeyLength);
			const pkB = b.slice(indexKeyLength);
			return comparePK(pkA, pkB);
		};
	}

	/**
	 * Gets the index of the tombstone column in overlay rows.
	 */
	private getTombstoneColumnIndex(overlay: VirtualTable): number {
		const schema = overlay.tableSchema;
		if (!schema) {
			throw new Error('Overlay table has no schema');
		}
		const idx = schema.columnIndexMap.get(this.tombstoneColumn.toLowerCase());
		if (idx === undefined) {
			throw new Error(`Tombstone column '${this.tombstoneColumn}' not found in overlay schema`);
		}
		return idx;
	}

	/**
	 * Gets the primary key column indices from the underlying table schema.
	 */
	getPrimaryKeyIndices(): number[] {
		const schema = this.tableSchema;
		if (!schema) return [];
		return schema.primaryKeyDefinition.map(pkDef => pkDef.index);
	}

	// ==================== Write Operations ====================

	/**
	 * Performs INSERT, UPDATE, or DELETE on the overlay.
	 * Changes are not visible to underlying until commit.
	 *
	 * The overlay is created lazily on first write, using schema from the underlying table.
	 */
	async update(args: UpdateArgs): Promise<UpdateResult> {
		// Ensure connection is registered for transaction coordination
		await this.ensureConnection();

		// Lazily create overlay on first write
		const overlay = await this.ensureOverlay();

		// Mark that we have changes
		this.setHasChanges(true);

		const { operation, values, oldKeyValues } = args;
		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);

		switch (operation) {
			case 'insert': {
				const pkIndices = this.getPrimaryKeyIndices();
				const pk = values ? pkIndices.map(i => values[i]) : undefined;

				if (pk) {
					const existingRow = await this.getOverlayRow(overlay, pk);
					if (existingRow && existingRow[tombstoneIndex] === 1) {
						// Convert tombstone to regular row (delete then re-insert same PK)
						const overlayRow = [...(values ?? []), 0];
						const result = await overlay.update({
							operation: 'update',
							values: overlayRow,
							oldKeyValues: pk,
							onConflict: args.onConflict,
						});
						return this.stripTombstoneFromResult(result, tombstoneIndex);
					}

					if (!existingRow) {
						// No overlay entry — check underlying for PK conflict
						const pkConflict = await this.checkMergedPKConflict(overlay, pk, tombstoneIndex, args.onConflict);
						if (pkConflict !== null) return pkConflict;

						// Check non-PK UNIQUE constraints against merged view
						const ucResult = await this.checkMergedUniqueConstraints(overlay, values!, [pk], tombstoneIndex, args.onConflict);
						if (ucResult !== null) return ucResult;
					}
				}

				// Normal insert into overlay with tombstone = 0
				const overlayRow = [...(values ?? []), 0];
				const result = await overlay.update({
					...args,
					values: overlayRow,
				});
				return this.stripTombstoneFromResult(result, tombstoneIndex);
			}

			case 'update': {
				// For updates, we need to handle the case where the row exists in:
				// 1. Overlay only (previous insert) - update the overlay row
				// 2. Underlying only - insert into overlay with new values
				// 3. Both (previous update) - update the overlay row

				const pkIndices = this.getPrimaryKeyIndices();
				const targetPK = oldKeyValues ?? (values ? pkIndices.map(i => values[i]) : undefined);

				if (!targetPK || !values) {
					throw new Error('UPDATE requires oldKeyValues or values with primary key');
				}

				const existingOverlayRow = await this.getOverlayRow(overlay, targetPK);
				const overlayRow = [...values, 0]; // tombstone = 0

				if (existingOverlayRow) {
					// Update existing overlay row
					const result = await overlay.update({
						...args,
						values: overlayRow,
						oldKeyValues: targetPK,
					});
					return this.stripTombstoneFromResult(result, tombstoneIndex);
				} else {
					// Insert new overlay row (shadows underlying) — check underlying conflicts first
					const newPK = pkIndices.map(i => values![i]);
					const pkChanged = !this.keysEqual(targetPK, newPK);

					if (pkChanged) {
						const pkConflict = await this.checkMergedPKConflict(overlay, newPK, tombstoneIndex, args.onConflict);
						if (pkConflict !== null) return pkConflict;
					}

					const selfPks: SqlValue[][] = pkChanged ? [targetPK, newPK] : [targetPK];
					const ucResult = await this.checkMergedUniqueConstraints(overlay, values!, selfPks, tombstoneIndex, args.onConflict);
					if (ucResult !== null) return ucResult;

					// For PK-change updates, tombstone the old PK so the underlying row is deleted at flush
					if (pkChanged) {
						await this.insertTombstoneForPK(overlay, targetPK, tombstoneIndex);
					}

					const result = await overlay.update({
						operation: 'insert',
						values: overlayRow,
						onConflict: args.onConflict,
					});
					return this.stripTombstoneFromResult(result, tombstoneIndex);
				}
			}

			case 'delete': {
				// For deletes, insert a tombstone into overlay
				const pkIndices = this.getPrimaryKeyIndices();
				const targetPK = oldKeyValues ?? (values ? pkIndices.map(i => values[i]) : undefined);

				if (!targetPK) {
					throw new Error('DELETE requires oldKeyValues or values with primary key');
				}

				const existingOverlayRow = await this.getOverlayRow(overlay, targetPK);

				if (existingOverlayRow) {
					if (existingOverlayRow[tombstoneIndex] === 1) {
						// Already deleted, nothing to do — return ok without row so callers
						// (e.g. dml-executor auto-event path) know no actual row was removed.
						return { status: 'ok' };
					}
					// Convert to tombstone by updating the tombstone flag
					const tombstoneRow = [...existingOverlayRow.slice(0, tombstoneIndex), 1];
					await overlay.update({
						operation: 'update',
						values: tombstoneRow,
						oldKeyValues: targetPK,
						onConflict: args.onConflict,
					});
					// Return the pre-deletion row so dml-executor emits the auto change event.
					const deletedRow = existingOverlayRow.slice(0, tombstoneIndex) as SqlValue[];
					return { status: 'ok', row: deletedRow };
				} else {
					// Insert tombstone to shadow underlying row
					// Build a minimal row with PK values and tombstone = 1
					const schema = this.tableSchema;
					if (!schema) throw new Error('No table schema');

					const tombstoneRow: SqlValue[] = new Array(schema.columns.length + 1).fill(null);
					pkIndices.forEach((colIdx, i) => {
						tombstoneRow[colIdx] = targetPK[i];
					});
					tombstoneRow[tombstoneIndex] = 1; // Set tombstone flag

					await overlay.update({
						operation: 'insert',
						values: tombstoneRow,
						onConflict: args.onConflict,
					});
					// Return a minimal placeholder row (PK columns only) so dml-executor
					// recognises the delete as successful and emits the auto change event.
					const placeholderRow: SqlValue[] = new Array(schema.columns.length).fill(null);
					pkIndices.forEach((colIdx, i) => {
						placeholderRow[colIdx] = targetPK[i];
					});
					return { status: 'ok', row: placeholderRow };
				}
			}

			default:
				throw new Error(`Unknown operation: ${operation}`);
		}
	}

	/**
	 * Strips the tombstone column from an overlay update result.
	 */
	private stripTombstoneFromResult(result: UpdateResult, tombstoneIndex: number): UpdateResult {
		if (isUpdateOk(result) && result.row) {
			return { status: 'ok', row: result.row.slice(0, tombstoneIndex) };
		}
		return result;
	}

	/**
	 * Gets a row from the overlay by primary key using O(log n) point lookup.
	 */
	private async getOverlayRow(overlay: VirtualTable, pk: SqlValue[]): Promise<Row | undefined> {
		if (!overlay.query) return undefined;

		for await (const row of overlay.query(this.buildPKPointLookupFilter(pk))) {
			return row;
		}
		return undefined;
	}

	/**
	 * Creates a FilterInfo for a full table scan (no constraints).
	 */
	private createFullScanFilterInfo(): FilterInfo {
		return {
			idxNum: 0,
			idxStr: null,
			constraints: [],
			args: [],
			indexInfoOutput: {
				nConstraint: 0,
				aConstraint: [],
				nOrderBy: 0,
				aOrderBy: [],
				colUsed: 0n,
				aConstraintUsage: [],
				idxNum: 0,
				idxStr: null,
				orderByConsumed: false,
				estimatedCost: 1000000,
				estimatedRows: 1000000n,
				idxFlags: 0,
			},
		};
	}

	/**
	 * Creates a FilterInfo for a primary key point lookup (equality on all PK columns).
	 * This produces O(log n) lookups instead of O(n) full scans.
	 */
	private buildPKPointLookupFilter(pk: SqlValue[]): FilterInfo {
		const pkIndices = this.getPrimaryKeyIndices();
		const constraints = pkIndices.map((colIdx, i) => ({
			constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true },
			argvIndex: i + 1,
		}));

		return {
			idxNum: 0,
			idxStr: 'idx=_primary_(0);plan=2',
			constraints,
			args: pk,
			indexInfoOutput: {
				nConstraint: constraints.length,
				aConstraint: constraints.map(c => c.constraint),
				nOrderBy: 0,
				aOrderBy: [],
				colUsed: 0n,
				aConstraintUsage: constraints.map(c => ({ argvIndex: c.argvIndex, omit: true })),
				idxNum: 0,
				idxStr: 'idx=_primary_(0);plan=2',
				orderByConsumed: false,
				estimatedCost: 1,
				estimatedRows: 1n,
				idxFlags: 0,
			},
		};
	}

	// ==================== Merged-View Conflict Detection ====================

	private keysEqual(a: SqlValue[], b: SqlValue[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (compareSqlValues(a[i], b[i]) !== 0) return false;
		}
		return true;
	}

	private async getUnderlyingRow(pk: SqlValue[]): Promise<Row | undefined> {
		if (!this.underlyingTable.query) return undefined;
		for await (const row of this.underlyingTable.query(this.buildPKPointLookupFilter(pk))) {
			return row;
		}
		return undefined;
	}

	private async insertTombstoneForPK(overlay: VirtualTable, pk: SqlValue[], tombstoneIndex: number): Promise<void> {
		const schema = this.tableSchema;
		if (!schema) throw new Error('No table schema');
		const pkIndices = this.getPrimaryKeyIndices();
		const tombstoneRow: SqlValue[] = new Array(schema.columns.length + 1).fill(null);
		pkIndices.forEach((colIdx, i) => { tombstoneRow[colIdx] = pk[i]; });
		tombstoneRow[tombstoneIndex] = 1;
		const existing = await this.getOverlayRow(overlay, pk);
		if (existing) {
			await overlay.update({ operation: 'update', values: tombstoneRow, oldKeyValues: pk });
		} else {
			await overlay.update({ operation: 'insert', values: tombstoneRow });
		}
	}

	/**
	 * Checks if newPK conflicts with an underlying row not already shadowed in the overlay.
	 * Returns null (no conflict or REPLACE applied) or an UpdateResult (IGNORE / constraint).
	 */
	private async checkMergedPKConflict(
		overlay: VirtualTable,
		newPK: SqlValue[],
		tombstoneIndex: number,
		onConflict?: ConflictResolution,
	): Promise<UpdateResult | null> {
		const overlayRow = await this.getOverlayRow(overlay, newPK);
		if (overlayRow) return null; // overlay handles it (tombstone = no conflict; real = overlay enforces)

		const underlyingRow = await this.getUnderlyingRow(newPK);
		if (!underlyingRow) return null;

		if (onConflict === ConflictResolution.IGNORE) return { status: 'ok', row: undefined };
		if (onConflict === ConflictResolution.REPLACE) return null; // same-PK replace: flush will UPDATE underlying
		return {
			status: 'constraint',
			constraint: 'unique',
			message: 'UNIQUE constraint failed: primary key',
			existingRow: underlyingRow,
		};
	}

	/**
	 * Scans the underlying table for a row conflicting with newRow on constrainedCols,
	 * excluding selfPks and rows tombstoned in the overlay.
	 */
	private async findMergedUniqueConflict(
		overlay: VirtualTable,
		constrainedCols: ReadonlyArray<number>,
		newRow: Row,
		selfPks: SqlValue[][],
		tombstoneIndex: number,
	): Promise<{ pk: SqlValue[]; row: Row } | null> {
		if (!this.underlyingTable.query) return null;
		const pkIndices = this.getPrimaryKeyIndices();

		for await (const underlyingRow of this.underlyingTable.query(this.createFullScanFilterInfo())) {
			const pk = pkIndices.map(i => underlyingRow[i]);
			if (selfPks.some(self => this.keysEqual(pk, self))) continue;

			const overlayRow = await this.getOverlayRow(overlay, pk);
			if (overlayRow && overlayRow[tombstoneIndex] === 1) continue;

			const matches = constrainedCols.every(idx => {
				if (newRow[idx] === null || underlyingRow[idx] === null) return false;
				return compareSqlValues(newRow[idx], underlyingRow[idx]) === 0;
			});
			if (matches) return { pk, row: underlyingRow };
		}
		return null;
	}

	/**
	 * Checks all non-PK UNIQUE constraints against the merged view.
	 * Returns null when all pass or REPLACE evictions succeed.
	 */
	private async checkMergedUniqueConstraints(
		overlay: VirtualTable,
		newRow: Row,
		selfPks: SqlValue[][],
		tombstoneIndex: number,
		onConflict?: ConflictResolution,
	): Promise<UpdateResult | null> {
		const schema = this.tableSchema;
		const uniqueConstraints = schema?.uniqueConstraints;
		if (!uniqueConstraints || uniqueConstraints.length === 0) return null;

		for (const uc of uniqueConstraints) {
			if (uc.columns.some(idx => newRow[idx] === null)) continue;

			const conflict = await this.findMergedUniqueConflict(overlay, uc.columns, newRow, selfPks, tombstoneIndex);
			if (!conflict) continue;

			if (onConflict === ConflictResolution.IGNORE) return { status: 'ok', row: undefined };
			if (onConflict === ConflictResolution.REPLACE) {
				await this.insertTombstoneForPK(overlay, conflict.pk, tombstoneIndex);
				continue;
			}
			const colNames = uc.columns.map(i => schema!.columns[i].name).join(', ');
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${schema!.name} (${colNames})`,
				existingRow: conflict.row,
			};
		}
		return null;
	}

	// ==================== Transaction Lifecycle ====================

	async begin(): Promise<void> {
		await this.underlyingTable.begin?.();
		await this.overlayTable?.begin?.();
	}

	async sync(): Promise<void> {
		await this.underlyingTable.sync?.();
		await this.overlayTable?.sync?.();
	}

	async commit(): Promise<void> {
		await this.flushAndClearOverlay();
		await this.underlyingTable.commit?.();
	}

	/**
	 * Flushes overlay changes to underlying (if any) and discards the overlay.
	 * Shared by commit() and onConnectionCommit().
	 */
	private async flushAndClearOverlay(): Promise<void> {
		const overlay = this.overlayTable;
		if (this.hasChanges && overlay) {
			await this.flushOverlayToUnderlying(overlay);
		}
		this.clearOverlay();
	}

	/**
	 * Flushes all overlay changes to the underlying table.
	 * Called during commit to persist changes.
	 *
	 * This method manages the underlying table's transaction lifecycle independently
	 * to ensure that flushed data is committed and won't be rolled back by subsequent
	 * transaction rollbacks.
	 */
	private async flushOverlayToUnderlying(overlay: VirtualTable): Promise<void> {
		if (!overlay.query) return;

		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);
		const pkIndices = this.getPrimaryKeyIndices();

		// Collect all overlay entries first
		const overlayEntries: { row: Row; isTombstone: boolean; pk: SqlValue[]; dataRow: Row }[] = [];
		for await (const overlayRow of overlay.query(this.createFullScanFilterInfo())) {
			const isTombstone = overlayRow[tombstoneIndex] === 1;
			const pk = pkIndices.map(i => overlayRow[i]);
			const dataRow = overlayRow.slice(0, tombstoneIndex);
			overlayEntries.push({ row: overlayRow, isTombstone, pk, dataRow });
		}

		if (overlayEntries.length === 0) return;

		// Begin a transaction on the underlying table for the flush
		await this.underlyingTable.begin?.();

		try {
			// Apply all overlay entries to underlying
			for (const entry of overlayEntries) {
				if (entry.isTombstone) {
					// Delete from underlying
					await this.underlyingTable.update({
						operation: 'delete',
						values: undefined,
						oldKeyValues: entry.pk,
					});
				} else {
					// Check if row exists in underlying to decide insert vs update
					const existsInUnderlying = await this.rowExistsInUnderlying(entry.pk);

					if (existsInUnderlying) {
						await this.underlyingTable.update({
							operation: 'update',
							values: entry.dataRow,
							oldKeyValues: entry.pk,
							preCoerced: true,
						});
					} else {
						await this.underlyingTable.update({
							operation: 'insert',
							values: entry.dataRow,
							preCoerced: true,
						});
					}
				}
			}

			// Commit the underlying table's transaction
			await this.underlyingTable.commit?.();
		} catch (error) {
			// Rollback underlying on error
			await this.underlyingTable.rollback?.();
			throw error;
		}
	}

	/**
	 * Checks if a row with the given primary key exists in the underlying table.
	 * Uses O(log n) point lookup via the PK index.
	 */
	private async rowExistsInUnderlying(pk: SqlValue[]): Promise<boolean> {
		if (!this.underlyingTable.query) return false;

		for await (const _row of this.underlyingTable.query(this.buildPKPointLookupFilter(pk))) {
			return true;
		}
		return false;
	}

	async rollback(): Promise<void> {
		await this.underlyingTable.rollback?.();
		this.clearOverlay();
	}

	/**
	 * Discards the connection-scoped overlay entirely.
	 * The overlay table is per-connection and ephemeral, so simply removing
	 * the reference allows GC to reclaim it. A fresh overlay will be created
	 * lazily via ensureOverlay() on the next write.
	 */
	private clearOverlay(): void {
		this.isolationModule.clearConnectionOverlay(this.db, this.schemaName, this.tableName);
	}

	// ==================== Savepoints ====================
	// Overlay savepoints are managed by IsolatedConnection (which forwards
	// to the overlay's own registered connection). The table-level methods
	// only forward to the underlying table to avoid double-savepointing.

	async savepoint(index: number): Promise<void> {
		await this.underlyingTable.savepoint?.(index);
	}

	async release(index: number): Promise<void> {
		await this.underlyingTable.release?.(index);
	}

	async rollbackTo(index: number): Promise<void> {
		await this.underlyingTable.rollbackTo?.(index);
	}

	// ==================== Schema Operations ====================

	async disconnect(): Promise<void> {
		// Don't disconnect overlay or underlying - they're connection-scoped/shared
	}

	async rename(newName: string): Promise<void> {
		await this.underlyingTable.rename?.(newName);
	}

	async alterSchema(changeInfo: SchemaChangeInfo): Promise<void> {
		// DDL bypasses overlay, goes directly to underlying
		await this.underlyingTable.alterSchema?.(changeInfo);
		// Update our schema reference
		this.tableSchema = this.underlyingTable.tableSchema;
		// Clear any existing overlay - it will be recreated with new schema on next write
		this.isolationModule.clearConnectionOverlay(this.db, this.schemaName, this.tableName);
	}

	async createIndex(indexInfo: IndexSchema): Promise<void> {
		await this.underlyingTable.createIndex?.(indexInfo);
		// Update schema reference
		this.tableSchema = this.underlyingTable.tableSchema;
		// If overlay exists, add index to it too
		await this.overlayTable?.createIndex?.(indexInfo);
	}

	async dropIndex(indexName: string): Promise<void> {
		await this.underlyingTable.dropIndex?.(indexName);
		// Update schema reference
		this.tableSchema = this.underlyingTable.tableSchema;
		await this.overlayTable?.dropIndex?.(indexName);
	}

	// ==================== Internal Helpers ====================

	/**
	 * Gets the underlying table for direct access (testing/debugging).
	 * @internal
	 */
	getUnderlyingTable(): VirtualTable {
		return this.underlyingTable;
	}

	/**
	 * Gets the overlay table for direct access (testing/debugging).
	 * Returns undefined if overlay hasn't been created yet.
	 * @internal
	 */
	getOverlayTable(): VirtualTable | undefined {
		return this.overlayTable;
	}

	/**
	 * Returns whether there are pending uncommitted changes.
	 */
	hasPendingChanges(): boolean {
		return this.hasChanges;
	}

	/**
	 * Gets the tombstone column name.
	 * @internal
	 */
	getTombstoneColumn(): string {
		return this.tombstoneColumn;
	}

	// ==================== IsolatedTableCallback Implementation ====================

	/**
	 * Called by IsolatedConnection when the database commits.
	 * Flushes overlay to underlying and clears overlay.
	 */
	async onConnectionCommit(): Promise<void> {
		await this.flushAndClearOverlay();
		this.savepointsBeforeOverlay.clear();
	}

	/**
	 * Called by IsolatedConnection when the database rolls back.
	 * Clears overlay without flushing.
	 */
	async onConnectionRollback(): Promise<void> {
		this.clearOverlay();
		this.savepointsBeforeOverlay.clear();
	}

	/**
	 * Called by IsolatedConnection when a savepoint is created.
	 *
	 * When the overlay exists, its own registered MemoryVirtualTableConnection
	 * receives createSavepoint from the database's connection iteration.
	 * Calling overlayTable.savepoint() here too would double-push onto the
	 * same savepointStack, corrupting the depth-to-index mapping.
	 *
	 * When the overlay does NOT exist (savepoint before first write), we
	 * record the depth so that a later rollbackToSavepoint can clear the
	 * overlay if one was created after the savepoint.
	 */
	async onConnectionSavepoint(index: number): Promise<void> {
		if (!this.overlayTable) {
			this.savepointsBeforeOverlay.add(index);
		}
		// If overlay exists, its registered connection handles it
	}

	/**
	 * Called by IsolatedConnection when a savepoint is released.
	 */
	async onConnectionReleaseSavepoint(index: number): Promise<void> {
		this.savepointsBeforeOverlay.delete(index);
		// If overlay exists, its registered connection handles it
	}

	/**
	 * Called by IsolatedConnection when rolling back to a savepoint.
	 *
	 * If the target savepoint was created before the overlay existed,
	 * the overlay's registered connection has no snapshot to restore —
	 * so we clear the overlay entirely, restoring "no uncommitted changes".
	 */
	async onConnectionRollbackToSavepoint(index: number): Promise<void> {
		if (this.savepointsBeforeOverlay.has(index)) {
			// Rolling back to before the overlay existed — discard all overlay changes
			this.clearOverlay();
			// Remove savepoints above the target (they're implicitly gone)
			for (const depth of [...this.savepointsBeforeOverlay]) {
				if (depth > index) {
					this.savepointsBeforeOverlay.delete(depth);
				}
			}
		}
		// If overlay's registered connection has this savepoint, it handles rollback
	}
}
