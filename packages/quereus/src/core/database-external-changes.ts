/**
 * External row-change ingestion — the batch driver behind
 * `Database.ingestExternalRowChanges`.
 *
 * A write applied directly to module storage (sync-inbound replication, a
 * host's direct row store) bypasses the DML executor and therefore the
 * post-write pipeline: (1) change capture (`_record*` → `Database.watch`
 * post-commit dispatch + commit-time global assertions), (2) row-time MV
 * maintenance, (3) parent-side FK actions. This driver replays exactly those
 * facets — selected per call — over a caller-reported, ordered batch of
 * changes, inside the coordinated transaction. The batch is the external
 * analogue of one DML statement: it mirrors `runWithStatementSavepoints` and
 * the DML generators' per-statement amortization (one
 * {@link BackingConnectionCache}, one deferred full-rebuild set, one
 * savepoint-broadcast scope per batch). See
 * `docs/materialized-views.md` § External row-change ingestion for the full
 * contract (facet semantics, trust boundary, transaction & visibility rules).
 */

import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { Row } from '../common/types.js';
import type { TableSchema } from '../schema/table.js';
import type { BackingRowChange } from '../vtab/backing-host.js';
import type { BackingConnectionCache } from './database-materialized-views.js';
import type { Database } from './database.js';
import type { ExternalRowChange, IngestExternalChangesOptions } from './database-internal.js';
import {
	assertTransitiveRestrictsForParentMutation,
	executeForeignKeyActionsAndLens,
} from '../runtime/foreign-key-actions.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('core:external-changes');

/**
 * Module-scope counter producing unique batch-savepoint names, mirroring the
 * DML executor's `stmtSavepointCounter`: names must be unique within the
 * TransactionManager's savepoint stack, and an FK-cascade DML nested inside
 * the batch opens its own statement savepoints inside the batch savepoint.
 */
let externalBatchCounter = 0;

/**
 * Resolve and memoize the {@link TableSchema} for one reported change. The
 * memo is per-batch: resolution is deterministic while the exec mutex is held
 * (no DDL can interleave), so one lookup per distinct (schema, table) pair
 * serves the whole batch.
 */
function resolveTableSchema(
	db: Database,
	memo: Map<string, TableSchema>,
	item: ExternalRowChange,
): TableSchema {
	const schemaName = item.schemaName ?? db.schemaManager.getCurrentSchemaName();
	const memoKey = `${schemaName}.${item.tableName}`.toLowerCase();
	const cached = memo.get(memoKey);
	if (cached) return cached;
	const tableSchema = db._findTable(item.tableName, schemaName);
	if (!tableSchema) {
		throw new QuereusError(
			`ingestExternalRowChanges: table '${schemaName}.${item.tableName}' not found`,
			StatusCode.NOTFOUND,
		);
	}
	memo.set(memoKey, tableSchema);
	return tableSchema;
}

/** Reject a missing or mis-sized row image — the rows must be FULL table rows
 *  in schema column order. Presence is part of the SHAPE contract (the trust
 *  boundary covers semantics, not malformed reports): without it a JS caller's
 *  missing image surfaces as a TypeError deep inside capture/maintenance. */
function assertRowShape(
	tableSchema: TableSchema,
	row: Row | undefined,
	which: 'oldRow' | 'newRow',
	op: string,
): void {
	if (row === undefined) {
		throw new QuereusError(
			`ingestExternalRowChanges: ${which} is required for op '${op}'`,
			StatusCode.MISUSE,
		);
	}
	if (row.length !== tableSchema.columns.length) {
		throw new QuereusError(
			`ingestExternalRowChanges: ${which} arity ${row.length} does not match `
				+ `'${tableSchema.schemaName}.${tableSchema.name}' column count ${tableSchema.columns.length}`,
			StatusCode.MISUSE,
		);
	}
}

/** Validate one reported change's shape: a recognized `op` carrying the images
 *  that op requires (insert: new, delete: old, update: both), each a full table
 *  row. The {@link BackingRowChange} union enforces this at compile time; this
 *  is the runtime mirror for JS callers. */
function assertChangeShape(tableSchema: TableSchema, change: BackingRowChange): void {
	switch (change.op) {
		case 'insert':
			assertRowShape(tableSchema, change.newRow, 'newRow', change.op);
			break;
		case 'delete':
			assertRowShape(tableSchema, change.oldRow, 'oldRow', change.op);
			break;
		case 'update':
			assertRowShape(tableSchema, change.oldRow, 'oldRow', change.op);
			assertRowShape(tableSchema, change.newRow, 'newRow', change.op);
			break;
		default:
			throw new QuereusError(
				`ingestExternalRowChanges: unknown op '${(change as { op: string }).op}'`,
				StatusCode.MISUSE,
			);
	}
}

/**
 * Run one ingestion batch. The caller (`Database.ingestExternalRowChanges`)
 * has already checked the database is open; everything else — exec-mutex
 * serialization, transaction/savepoint lifecycle, facet dispatch, deferred
 * flush, implicit-transaction finalization — lives here.
 */
export async function ingestExternalRowChangeBatch(
	db: Database,
	changes: readonly ExternalRowChange[],
	options?: IngestExternalChangesOptions,
): Promise<void> {
	// Empty batch: a true no-op — no transaction begin, no savepoint.
	if (changes.length === 0) return;

	const captureChanges = options?.captureChanges ?? true;
	const maintainMaterializedViews = options?.maintainMaterializedViews ?? true;
	const applyForeignKeyActions = options?.applyForeignKeyActions ?? false;

	// Serialize against concurrent statements for the whole batch: FK-action
	// cascades re-enter the DML pipeline via _execWithinTransaction (the
	// already-holding-the-mutex variant), and the batch's savepoint scope must
	// not interleave with another statement's.
	const releaseMutex = await db._acquireExecMutex();
	try {
		// Run inside the caller's active transaction when one exists; otherwise
		// begin an implicit one this call finalizes itself. Holding the mutex
		// means no statement is mid-flight, so an implicit transaction observed
		// below was necessarily started here.
		await db._ensureTransaction();

		const savepointName = `__external_batch_${externalBatchCounter++}`;
		try {
			// Batch atomicity for the DERIVED effects (backing writes, cascade
			// DML, capture entries): all of the batch's pipeline effects apply
			// or none. The externally-applied storage rows are the caller's.
			await db._createSavepointBroadcast(savepointName);

			// Per-batch amortization, exactly as one DML statement amortizes
			// per-row maintenance: one backing-connection resolution per backing,
			// one rebuild per full-rebuild MV per batch.
			const cache: BackingConnectionCache = new Map();
			const deferred = new Set<string>();
			const tableMemo = new Map<string, TableSchema>();

			for (const item of changes) {
				const tableSchema = resolveTableSchema(db, tableMemo, item);
				const { change } = item;
				assertChangeShape(tableSchema, change);

				// Derived from the RESOLVED schema — byte-identical to the DML
				// executor's key, so capture/watch matching gets executor parity.
				const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`;
				const pkIndices = tableSchema.primaryKeyDefinition.map(d => d.index);

				// Facets in DML-executor order: capture, then MV maintenance,
				// then FK actions.
				if (captureChanges) {
					switch (change.op) {
						case 'insert': db._recordInsert(tableKey, change.newRow, pkIndices); break;
						case 'delete': db._recordDelete(tableKey, change.oldRow, pkIndices); break;
						case 'update': db._recordUpdate(tableKey, change.oldRow, change.newRow, pkIndices); break;
					}
				}

				if (maintainMaterializedViews && db._hasRowTimeCoveringStructures(tableKey)) {
					await db._maintainRowTimeCoveringStructures(tableKey, change, cache, deferred);
				}

				// Parent-side FK actions: update/delete only (inserts have no
				// parent-side actions; child-side existence is deliberately NOT
				// checked — trust boundary). Both calls run with
				// lensRouted = false: an external change is a physical basis
				// write. The RESTRICT walk runs POST-application — like the DML
				// executor's REPLACE-eviction handling, the storage change
				// already happened (there is no pre-mutation point) and the
				// child rows it keys off still exist because the cascade has
				// not run yet.
				if (applyForeignKeyActions && change.op !== 'insert') {
					await assertTransitiveRestrictsForParentMutation(
						db, tableSchema, change.op, change.oldRow, change.newRow);
					await executeForeignKeyActionsAndLens(
						db, tableSchema, change.op, change.oldRow, change.newRow);
				}
			}

			// Batch boundary: drain the deferred full-rebuild set AFTER every
			// change has been applied (each rebuild reads the whole batch) and
			// BEFORE the savepoint release (a failed rebuild unwinds the batch).
			if (deferred.size > 0) {
				await db._flushDeferredRebuilds(deferred, cache);
			}
			await db._releaseSavepointBroadcast(savepointName);
		} catch (e) {
			log('batch %s failed, unwinding derived effects: %O', savepointName, e);
			await db._rollbackAndReleaseSavepointBroadcast(savepointName);
			if (db._isImplicitTransaction()) {
				await db._rollbackTransaction();
			}
			throw e;
		}

		// The batch is its own autocommit boundary, like one exec statement;
		// watch dispatch fires here. Inside an explicit caller transaction this
		// is a no-op — dispatch waits for the caller's commit.
		if (db._isImplicitTransaction()) {
			await db._commitTransaction();
		}
	} finally {
		releaseMutex();
	}
}
