/**
 * Store implementation of the engine's backing-host capability
 * (`@quereus/quereus` `vtab/backing-host.ts`) — the privileged surface that lets
 * a materialized view's backing table live in a persistent store
 * (`create materialized view … using store`). The memory module's
 * `MemoryBackingHost` is the reference implementation; this host reproduces its
 * contract over a (StoreTable, TransactionCoordinator) pair.
 *
 * ## Pending state = the per-table coordinator
 *
 * Where the memory host writes a connection's private pending
 * `TransactionLayer`, this host queues ops into the table's shared
 * {@link TransactionCoordinator} — the same pending state `StoreTable`'s read
 * paths merge over the committed store (reads-own-writes). The visibility
 * granularity is therefore per-table-coordinator, not per-connection: every
 * connection this host creates shares one pending view. That satisfies the
 * contract (later reads on the writing connection observe the ops) and is the
 * store's documented RYOW posture; the per-connection invisibility the memory
 * host happens to provide is an isolation property, not a contract point. Under
 * the registered `IsolationModule(StoreModule)` wrapper all backing writes are
 * privileged (they bypass the per-connection overlay entirely), so the single
 * engine transaction sees exactly one coherent pending state.
 *
 * ## Incarnation pinning
 *
 * One host instance is bound to one (StoreTable, coordinator) pair = one
 * backing-table incarnation. `StoreModule.destroy` evicts both the table and
 * the coordinator from the module maps, so a drop+recreate yields fresh
 * instances and `ownsConnection`'s coordinator-identity comparison rejects the
 * old incarnation's connections — memory-parity pinning.
 *
 * ## No events, no secondary structures
 *
 * Privileged writes deliberately queue NO store `DataChangeEvent`s: the
 * MV-over-MV cascade consumes the returned {@link BackingRowChange}s directly,
 * and the sync layer must not replicate derived rows (the sources replicate;
 * each replica derives). Backing tables also carry no secondary indexes,
 * UNIQUE constraints, or FKs (`buildBackingTableSchema` builds none), so the
 * host writes the data store only — asserted, not maintained.
 */

import {
	QuereusError,
	StatusCode,
	compareSqlValues,
	rowsValueIdentical,
	type Row,
	type SqlValue,
	type BackingHost,
	type BackingScanRequest,
	type BackingRowChange,
	type MaintenanceOp,
	type VirtualTableConnection,
} from '@quereus/quereus';

import type { StoreTable } from './store-table.js';
import type { TransactionCoordinator } from './transaction.js';
import { StoreConnection } from './store-connection.js';
import { bytesToHex } from './bytes.js';
import { buildFullScanBounds } from './key-builder.js';
import { serializeRow, deserializeRow } from './serialization.js';

/** The engine's BTreeKeyForPrimary: a bare value for a single-column PK, an array otherwise. */
type BackingKey = SqlValue | SqlValue[];

/**
 * Privileged per-backing-table surface over a store table — see the module
 * header for the design. Resolved fresh per engine call by
 * `StoreModule.getBackingHost`; never cached engine-side, so the captured
 * (table, coordinator) identity always reflects the live incarnation.
 */
export class StoreBackingHost implements BackingHost {
	constructor(
		private readonly table: StoreTable,
		private readonly coordinator: TransactionCoordinator,
	) {}

	/**
	 * True when `conn` is a StoreConnection on THIS incarnation's coordinator.
	 * Coordinators are per (schema.table) and evicted on destroy, so identity
	 * comparison rejects both another table's connection and a stale connection
	 * from a dropped+recreated incarnation.
	 */
	ownsConnection(conn: VirtualTableConnection): boolean {
		return conn instanceof StoreConnection && conn.getCoordinator() === this.coordinator;
	}

	/**
	 * Fresh connection on this incarnation's coordinator. Synchronous by design
	 * (the substrate made the coordinator thunk-constructed). The caller registers
	 * it with the Database; `registerConnection`'s begin + savepoint-stack replay
	 * then drives the coordinator into the live transaction state.
	 */
	connect(): VirtualTableConnection {
		return new StoreConnection(this.table.tableName, this.coordinator);
	}

	/**
	 * Privileged ordered op application into the coordinator's pending state.
	 * Begins an implicit coordinator transaction when none is active (the lazy
	 * analogue of memory's `ensureTransactionLayer`); commit/rollback ride the
	 * registered connection. Before-images come from an effective point read
	 * (pending view → committed `store.get`) per op — one O(log n) read per point
	 * op; the store's write path doesn't otherwise know the image, and reporting
	 * the EFFECTIVE change is the cascade contract. Stats deltas are buffered via
	 * `trackPrivilegedMutation` and land at coordinator commit.
	 */
	async applyMaintenance(conn: VirtualTableConnection, ops: readonly MaintenanceOp[]): Promise<BackingRowChange[]> {
		this.assertOwned(conn);
		const changes: BackingRowChange[] = [];
		if (ops.length === 0) return changes;
		if (!this.coordinator.isInTransaction()) {
			this.coordinator.begin();
		}

		for (const op of ops) {
			switch (op.kind) {
				case 'delete-key': {
					const key = this.table.encodeDataKey(this.normalizePkValues(op.key));
					const existing = await this.table.readEffectiveRowByKey(key);
					if (existing) {
						this.coordinator.delete(key);
						this.table.trackPrivilegedMutation(-1);
						changes.push({ op: 'delete', oldRow: existing });
					}
					break;
				}
				case 'upsert': {
					const key = this.table.encodeDataKey(this.extractPk(op.row));
					const existing = await this.table.readEffectiveRowByKey(key);
					if (existing && rowsValueIdentical(existing, op.row)) {
						// Value-identical upsert (byte-faithful `rowsValueIdentical`,
						// against the EFFECTIVE row): nothing changes, so queue no op and
						// report nothing — the suppression contract whose normative
						// statement lives in the engine's vtab/backing-host.ts. Deliberately
						// collation-UNAWARE: a collation-equal / byte-different upsert is a
						// real change that must replace the stored bytes and report an
						// update.
						break;
					}
					this.coordinator.put(key, serializeRow(op.row));
					if (!existing) this.table.trackPrivilegedMutation(+1);
					changes.push(existing
						? { op: 'update', oldRow: existing, newRow: op.row }
						: { op: 'insert', newRow: op.row });
					break;
				}
				case 'delete-by-prefix': {
					// Seek to the leading-PK slice (per-column DESC/collation encoded
					// bounds) and early-terminate — the ordered prefix scan the cost
					// contract requires. Collect-then-delete mirrors memory's arm; the
					// ordered pending view is already a snapshot, so this is for clarity,
					// not correctness.
					const bounds = this.table.encodePkPrefixBounds(op.keyPrefix);
					const matched: Array<{ key: Uint8Array; row: Row }> = [];
					for await (const entry of this.table.iterateEffectiveEntries(bounds)) {
						matched.push({ key: entry.key, row: deserializeRow(entry.value) });
					}
					for (const { key, row } of matched) {
						this.coordinator.delete(key);
						this.table.trackPrivilegedMutation(-1);
						changes.push({ op: 'delete', oldRow: row });
					}
					break;
				}
				case 'replace-all': {
					await this.applyReplaceAll(op.rows, changes);
					break;
				}
				default: {
					// A new MaintenanceOp must extend this switch; never-assignment makes
					// that a compile error rather than a silent no-op.
					const exhaustiveCheck: never = op;
					throw new QuereusError(`Unknown maintenance op: ${JSON.stringify(exhaustiveCheck)}`, StatusCode.INTERNAL);
				}
			}
		}
		return changes;
	}

	/**
	 * The `replace-all` arm: wholesale transactional replacement realized as the
	 * minimal keyed diff against the current effective contents. Keys are compared
	 * by ENCODED data-key bytes, which fold each PK column's key collation — so a
	 * new row whose key differs only by collation (e.g. 'apple' vs a stored 'APPLE'
	 * under a NOCASE-keyed PK) matches its old row and resolves to an `update`,
	 * mirroring memory's PK-comparator diff. Value-identical rows at the same key
	 * are skipped (no storage churn, no emitted change) under each column's
	 * declared collation, exactly as `applyMaintenanceToLayer` skips them.
	 */
	private async applyReplaceAll(rows: readonly Row[], changes: BackingRowChange[]): Promise<void> {
		// Snapshot the old effective contents first (stable before-image for the
		// diff). Map preserves insertion order = scan order = ascending key order,
		// so the delete pass below emits in PK order like memory's.
		const oldByKey = new Map<string, { key: Uint8Array; row: Row }>();
		for await (const entry of this.table.iterateEffectiveEntries(buildFullScanBounds())) {
			oldByKey.set(bytesToHex(entry.key), { key: entry.key, row: deserializeRow(entry.value) });
		}

		const newKeys = new Set<string>();
		for (const newRow of rows) {
			const key = this.table.encodeDataKey(this.extractPk(newRow));
			const hex = bytesToHex(key);
			newKeys.add(hex);
			const existing = oldByKey.get(hex);
			if (!existing) {
				this.coordinator.put(key, serializeRow(newRow));
				this.table.trackPrivilegedMutation(+1);
				changes.push({ op: 'insert', newRow });
			} else if (!this.rowsEqual(existing.row, newRow)) {
				this.coordinator.put(key, serializeRow(newRow));
				changes.push({ op: 'update', oldRow: existing.row, newRow });
			}
			// else: equal under each column's collation — a no-op, no emitted change.
		}

		for (const { key, row } of oldByKey.values()) {
			if (newKeys.has(bytesToHex(key))) continue;
			this.coordinator.delete(key);
			this.table.trackPrivilegedMutation(-1);
			changes.push({ op: 'delete', oldRow: row });
		}
	}

	/**
	 * Atomically replace the COMMITTED contents (create-fill / refresh).
	 *
	 * If the coordinator holds an open transaction, it is committed FIRST: a
	 * committed bulk replace inside an explicit transaction is effectively
	 * DDL-committing on a store-backed table, the same posture `renameTable`
	 * takes (and the analogue of memory's `replaceBaseLayer` draining in-flight
	 * transaction layers before the base swap).
	 *
	 * Duplicate encoded data keys among `rows` are detected BEFORE any write, so a
	 * thrown `onDuplicateKey()` (the MV "must be a set" gate) leaves the committed
	 * contents untorn. The clear + rewrite then rides ONE provider batch (deletes
	 * of displaced old keys, then puts), so a provider with atomic batches gives
	 * concurrent readers pre- or post-swap state, never partial. Routed through
	 * the table's `openDataStore()` so the lazy first-access `saveTableDDL` fires
	 * — the catalog write a freshly created `using store` backing relies on to
	 * survive reopen. Stats reset to the exact new count.
	 */
	async replaceContents(rows: readonly Row[], onDuplicateKey?: () => QuereusError): Promise<void> {
		if (this.coordinator.isInTransaction()) {
			await this.coordinator.commit();
		}

		const entries = new Map<string, { key: Uint8Array; value: Uint8Array }>();
		for (const row of rows) {
			const key = this.table.encodeDataKey(this.extractPk(row));
			const hex = bytesToHex(key);
			if (entries.has(hex)) {
				throw onDuplicateKey
					? onDuplicateKey()
					: new QuereusError(
						`UNIQUE constraint failed: ${this.table.tableName} PK.`,
						StatusCode.CONSTRAINT,
					);
			}
			entries.set(hex, { key, value: serializeRow(row) });
		}

		const store = await this.table.openDataStore();
		const batch = store.batch();
		for await (const entry of store.iterate(buildFullScanBounds())) {
			// Keys being rewritten are skipped (the put below covers them), so the
			// batch carries no delete/put order dependence on the same key.
			if (!entries.has(bytesToHex(entry.key))) {
				batch.delete(entry.key);
			}
		}
		for (const { key, value } of entries.values()) {
			batch.put(key, value);
		}
		await batch.write();

		await this.table.resetStats(rows.length);
	}

	/**
	 * Reads-own-writes scan over the effective state (coordinator pending merged
	 * over committed), in PK order. `equalityPrefix` (leading-PK values, in
	 * PK-definition order) becomes encoded byte bounds — seek + early-terminate,
	 * the O(log n) prefix scan the cost contract requires, never a full-store
	 * visit. The ownership guard runs eagerly (before the first pull), matching
	 * the memory host's synchronous INTERNAL throw on a foreign connection.
	 */
	scanEffective(conn: VirtualTableConnection, req: BackingScanRequest): AsyncIterable<Row> {
		this.assertOwned(conn);
		const bounds = this.table.encodePkPrefixBounds(req.equalityPrefix ?? []);
		const reverse = req.descending ?? false;
		const table = this.table;
		return (async function* () {
			for await (const entry of table.iterateEffectiveEntries(bounds, reverse)) {
				yield deserializeRow(entry.value);
			}
		})();
	}

	/** INTERNAL guard: the privileged surface only accepts this incarnation's connections. */
	private assertOwned(conn: VirtualTableConnection): void {
		if (!this.ownsConnection(conn)) {
			throw new QuereusError(
				`connection '${conn.connectionId}' does not belong to backing table `
					+ `'${this.table.schemaName}.${this.table.tableName}' (or to this incarnation of it)`,
				StatusCode.INTERNAL,
			);
		}
	}

	/** PK values (in PK-definition order) extracted from a full backing row. */
	private extractPk(row: Row): SqlValue[] {
		return this.table.getSchema().primaryKeyDefinition.map(pk => row[pk.index]);
	}

	/**
	 * Normalize the engine's `BTreeKeyForPrimary` (bare value for a single-column
	 * PK — see `buildPrimaryKeyFromValues` — array otherwise) to a values array in
	 * PK-definition order, ready for {@link StoreTable.encodeDataKey}.
	 */
	private normalizePkValues(key: BackingKey): SqlValue[] {
		const pkLength = this.table.getSchema().primaryKeyDefinition.length;
		if (pkLength === 1) {
			return [key as SqlValue];
		}
		return key as SqlValue[];
	}

	/**
	 * SQL-value row equality under each column's declared collation (mirrors the
	 * memory manager's `rowsEqual`): the **`replace-all`** wholesale diff's
	 * skip-identical comparison ONLY, so equal values of differing JS identity
	 * (bigint vs number) are not spuriously re-upserted. Rows of differing width
	 * compare unequal. The point-op `upsert` skip instead uses the byte-faithful
	 * `rowsValueIdentical` (see vtab/backing-host.ts for why the disciplines differ).
	 */
	private rowsEqual(a: Row, b: Row): boolean {
		if (a.length !== b.length) return false;
		const columns = this.table.getSchema().columns;
		for (let i = 0; i < a.length; i++) {
			if (compareSqlValues(a[i], b[i], columns[i]?.collation) !== 0) return false;
		}
		return true;
	}
}
