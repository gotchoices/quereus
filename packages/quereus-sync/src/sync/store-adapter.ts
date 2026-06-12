/**
 * Store adapter for applying remote sync changes.
 *
 * Implements the ApplyToStoreCallback interface over the store module's
 * external row-write entry point (`StoreTable.applyExternalRowChanges` —
 * table-owned key encoding, secondary-index and stats maintenance) plus the
 * engine's batch ingestion seam (`Database.ingestExternalRowChanges` — change
 * capture for `Database.watch` + global assertions, materialized-view
 * maintenance, opt-in parent-side FK actions).
 *
 * Per `applyToStore(dataChanges, schemaChanges, options)` invocation:
 *   1. Schema changes execute first via `db.exec` (DDL before DML), with the
 *      resulting module schema events pre-marked remote.
 *   2. Data changes are grouped per table, then per row; each row group
 *      collapses to ONE `ExternalRowOp` (a delete in the group wins over
 *      column updates; column updates merge onto the pre-read existing row,
 *      or onto a PK+nulls partial row when absent — UPSERT semantics).
 *   3. `StoreTable.applyExternalRowChanges(ops)` applies the table's ops to
 *      committed storage and returns the EFFECTIVE changes (no-ops — absent
 *      delete, value-identical upsert — are suppressed: no storage write, no
 *      module event, no seam report).
 *   4. Module data events are emitted from the effective changes with
 *      `remote: true` (so the SyncManager never re-records inbound changes),
 *      carrying accurate `oldRow` before-images and derived `changedColumns`.
 *   5. After all tables' storage writes, ONE seam call reports the
 *      accumulated effective changes: `db.ingestExternalRowChanges(batch,
 *      { applyForeignKeyActions })` — capture + MV facets default on.
 *      Changes recorded in `result.errors` are excluded from the batch.
 *
 * A seam throw (e.g. a commit-time global-assertion failure over the inbound
 * batch) PROPAGATES out of the callback: the seam's batch savepoint has
 * unwound the derived effects (MV backing deltas, capture entries), the
 * storage rows stay applied, and the sync layer leaves CRDT metadata
 * uncommitted — the same changes re-resolve on the next sync attempt.
 * Re-application is idempotent (value-identical upserts suppress), then the
 * seam retries. A batch that keeps failing an assertion retries forever
 * (poison batch); detection/recovery policy is the host's.
 *
 * Constraints (see docs/materialized-views.md § External row-change
 * ingestion): the callback is host-driven — never invoke it from within
 * statement execution or vtab callbacks (exec-mutex deadlock), and hosts
 * should not drive it while holding an open explicit transaction on `db`
 * (the seam would join that transaction, so a later rollback diverges
 * MV/capture state from the already-committed storage rows; recoverable via
 * MV refresh).
 */

import type { BackingRowChange, Database, ExternalRowChange, Row, SqlValue, TableSchema } from '@quereus/quereus';
import { compareSqlValues } from '@quereus/quereus';
import type { ExternalRowOp, StoreEventEmitter, StoreModule, StoreTable } from '@quereus/store';
import type {
  ApplyToStoreCallback,
  ApplyToStoreOptions,
  ApplyToStoreResult,
  DataChangeToApply,
  SchemaChangeToApply,
} from './protocol.js';
import { toError } from './sync-context.js';

/**
 * Options for creating a SyncStoreAdapter.
 */
export interface SyncStoreAdapterOptions {
  /** The Quereus database: DDL execution + `ingestExternalRowChanges` reporting. */
  db: Database;
  /**
   * The store module owning the synced tables. Each table is resolved per
   * apply via `getTableForExternalWrite`, which owns key encoding (incl.
   * per-PK-column collations), secondary-index maintenance, and per-table
   * store resolution (e.g. IndexedDB's one-database-per-table layout).
   */
  storeModule: StoreModule;
  /** The event emitter for data change events (the adapter emits `remote: true`). */
  events: StoreEventEmitter;
  /**
   * Parent-side FK actions on inbound update/delete (seam facet). Default
   * false — a replication stream usually carries the origin's cascade
   * effects; opt in only when the deployment's stream does not. When on, an
   * inbound parent delete cascades to local children through the full DML
   * pipeline; those cascaded child writes emit module events WITHOUT
   * `remote`, so they are recorded as local changes and propagate outward —
   * correct for the opt-in posture.
   */
  applyForeignKeyActions?: boolean;
}

/**
 * Creates an ApplyToStoreCallback for applying remote sync changes.
 *
 * This adapter handles:
 * - UPSERT semantics for column changes (insert if row doesn't exist, update if it does)
 * - Row deletions by primary key
 * - DDL execution for schema changes
 * - Post-apply reporting through the engine's ingestion seam (MV maintenance,
 *   `Database.watch` capture, opt-in FK actions)
 *
 * All data change events are emitted with `remote: true` to prevent
 * the SyncManager from re-recording CRDT metadata.
 */
export function createStoreAdapter(options: SyncStoreAdapterOptions): ApplyToStoreCallback {
  const { db, storeModule, events, applyForeignKeyActions = false } = options;

  return async (
    dataChanges: DataChangeToApply[],
    schemaChanges: SchemaChangeToApply[],
    applyOptions: ApplyToStoreOptions
  ): Promise<ApplyToStoreResult> => {
    const result: ApplyToStoreResult = {
      dataChangesApplied: 0,
      schemaChangesApplied: 0,
      errors: [],
    };

    // Apply schema changes first (DDL before DML)
    for (const schemaChange of schemaChanges) {
      try {
        await applySchemaChange(db, events, schemaChange, applyOptions);
        result.schemaChangesApplied++;
      } catch (error) {
        result.errors.push({
          change: schemaChange,
          error: toError(error),
        });
      }
    }

    // Effective changes accumulated across all tables, in apply order,
    // for the single end-of-invocation seam call.
    const seamBatch: ExternalRowChange[] = [];

    // Apply data changes per table; the resolved StoreTable owns key
    // encoding, store resolution, and secondary-index maintenance.
    const changesByTable = groupChangesByTable(dataChanges);
    for (const [tableKey, tableChanges] of changesByTable) {
      const [schemaName, tableName] = tableKey.split('.');
      try {
        const table = storeModule.getTableForExternalWrite(db, schemaName, tableName);
        if (!table) {
          throw new Error(`Table not found for external write: ${schemaName}.${tableName}`);
        }

        // One ExternalRowOp per row group: multiple same-row changes collapse
        // to a single effective op, so the seam's same-row before-image
        // chaining rule is satisfied trivially (oldRow = true pre-batch image).
        const ops: ExternalRowOp[] = [];
        for (const rowChanges of groupChangesByRow(tableChanges).values()) {
          ops.push(await buildRowOp(table, rowChanges));
        }

        const effective = await table.applyExternalRowChanges(ops);
        emitEffectiveChanges(events, table.getSchema(), effective);
        for (const change of effective) {
          seamBatch.push({ schemaName, tableName, change });
        }
        result.dataChangesApplied += tableChanges.length;
      } catch (error) {
        // Errored changes are excluded from the seam batch; earlier tables'
        // applied changes still report below.
        for (const change of tableChanges) {
          result.errors.push({
            change,
            error: toError(error),
          });
        }
      }
    }

    // One seam call per invocation, after all storage writes. A throw
    // propagates: derived effects are unwound by the seam's batch savepoint,
    // storage rows stay applied, the sync layer leaves CRDT metadata
    // uncommitted and the same changes re-resolve on the next attempt.
    if (seamBatch.length > 0) {
      await db.ingestExternalRowChanges(seamBatch, { applyForeignKeyActions });
    }

    return result;
  };
}

/**
 * Group data changes by table (schema.table).
 */
function groupChangesByTable(
  changes: DataChangeToApply[]
): Map<string, DataChangeToApply[]> {
  const grouped = new Map<string, DataChangeToApply[]>();

  for (const change of changes) {
    const tableKey = `${change.schema}.${change.table}`;
    const existing = grouped.get(tableKey);
    if (existing) {
      existing.push(change);
    } else {
      grouped.set(tableKey, [change]);
    }
  }

  return grouped;
}

/**
 * Group data changes by row (schema.table:pk).
 */
function groupChangesByRow(
  changes: DataChangeToApply[]
): Map<string, DataChangeToApply[]> {
  const grouped = new Map<string, DataChangeToApply[]>();

  for (const change of changes) {
    const rowKey = `${change.schema}.${change.table}:${JSON.stringify(change.pk)}`;
    const existing = grouped.get(rowKey);
    if (existing) {
      existing.push(change);
    } else {
      grouped.set(rowKey, [change]);
    }
  }

  return grouped;
}

/**
 * Apply schema changes (DDL) to the database.
 */
async function applySchemaChange(
  db: Database,
  events: StoreEventEmitter,
  change: SchemaChangeToApply,
  _options: ApplyToStoreOptions
): Promise<void> {
  // Determine the event signature
  const eventType = change.type.startsWith('drop') ? 'drop' : change.type.startsWith('create') ? 'create' : 'alter';
  const objectType = change.type.includes('table') ? 'table' : 'index';

  // Register this as an expected remote event BEFORE executing DDL.
  // When the module emits the event, it will be automatically marked as
  // remote, so SyncManager won't re-record it.
  // This approach avoids race conditions with concurrent local DDL.
  events.expectRemoteSchemaEvent({
    type: eventType,
    objectType,
    schemaName: change.schema,
    objectName: change.table,
  });

  try {
    // Execute the DDL statement
    // The module will emit a schema event, which will be marked as remote
    await db.exec(change.ddl);
  } catch (e) {
    // Clear the expectation if DDL failed
    events.clearExpectedRemoteSchemaEvent({
      type: eventType,
      objectType,
      schemaName: change.schema,
      objectName: change.table,
    });
    throw e;
  }
  // Note: We don't emit a separate event here anymore.
  // The module's event is automatically marked as remote.
}

/**
 * Collapse one row group's changes into a single ExternalRowOp.
 * A delete in the group wins over column updates.
 */
async function buildRowOp(
  table: StoreTable,
  changes: DataChangeToApply[]
): Promise<ExternalRowOp> {
  const { pk } = changes[0];

  if (changes.some(c => c.type === 'delete')) {
    return { op: 'delete', pk };
  }

  return { op: 'upsert', row: await mergeColumnUpdates(table, pk, changes) };
}

/**
 * Merge column updates onto the row's current image (UPSERT semantics):
 * pre-read the existing row by PK, or build a PK+nulls partial row when
 * absent (column changes may arrive before the rest of the row).
 */
async function mergeColumnUpdates(
  table: StoreTable,
  pk: SqlValue[],
  changes: DataChangeToApply[]
): Promise<Row> {
  const tableSchema = table.getSchema();
  const existing = await table.readRowByPk(pk);

  let row: Row;
  if (existing) {
    row = [...existing];
  } else {
    row = new Array<SqlValue>(tableSchema.columns.length).fill(null);
    for (let i = 0; i < tableSchema.primaryKeyDefinition.length; i++) {
      row[tableSchema.primaryKeyDefinition[i].index] = pk[i];
    }
  }

  let columnsApplied = 0;
  for (const change of changes) {
    if (!change.columns) continue;
    for (const [colName, value] of Object.entries(change.columns)) {
      const colIndex = tableSchema.columnIndexMap.get(colName.toLowerCase());
      if (colIndex !== undefined) {
        row[colIndex] = value;
        columnsApplied++;
      } else {
        // Column name not found in schema - this could be a sync bug
        console.warn(
          `[Sync] Column '${colName}' not found in ${tableSchema.schemaName}.${tableSchema.name}. ` +
          `Available columns: ${[...tableSchema.columnIndexMap.keys()].join(', ')}`
        );
      }
    }
  }

  if (columnsApplied === 0 && existing) {
    console.warn(
      `[Sync] No columns were applied for ${tableSchema.schemaName}.${tableSchema.name} pk=${JSON.stringify(pk)}. ` +
      `This may indicate a column name mismatch between source and destination.`
    );
  }

  return row;
}

/**
 * Emit module data change events for the effective changes, with
 * `remote: true` so the SyncManager never re-records them. Suppressed no-ops
 * (absent delete, value-identical upsert) were never reported by the store,
 * so they emit nothing — deliberate.
 */
function emitEffectiveChanges(
  events: StoreEventEmitter,
  tableSchema: TableSchema,
  effective: readonly BackingRowChange[]
): void {
  for (const change of effective) {
    const row = change.newRow ?? change.oldRow;
    const pk = tableSchema.primaryKeyDefinition.map(p => row[p.index]);
    events.emitDataChange({
      type: change.op,
      schemaName: tableSchema.schemaName,
      tableName: tableSchema.name,
      key: pk,
      oldRow: change.oldRow,
      newRow: change.newRow,
      changedColumns: change.op === 'update'
        ? diffChangedColumns(tableSchema, change.oldRow, change.newRow)
        : undefined,
      remote: true,
    });
  }
}

/** Column names whose values differ between the effective before/after images. */
function diffChangedColumns(tableSchema: TableSchema, oldRow: Row, newRow: Row): string[] {
  const changed: string[] = [];
  for (let i = 0; i < tableSchema.columns.length; i++) {
    if (compareSqlValues(oldRow[i], newRow[i]) !== 0) {
      changed.push(tableSchema.columns[i].name);
    }
  }
  return changed;
}
