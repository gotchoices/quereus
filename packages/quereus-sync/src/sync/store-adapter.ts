/**
 * Store adapter for applying remote sync changes.
 *
 * This module provides adapters that implement the ApplyToStoreCallback
 * interface for LevelDB and IndexedDB stores, enabling the SyncManager
 * to apply remote changes to the actual data store.
 */

import type { Database, SqlValue, Row, TableSchema } from '@quereus/quereus';
import type { KVStore, StoreEventEmitter } from '@quereus/store';
import { buildDataKey, resolvePkKeyCollations, serializeRow, deserializeRow } from '@quereus/store';
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
  /** The Quereus database for executing DDL statements. */
  db: Database;
  /**
   * Function to get the KV store for a specific table.
   * Each table may have its own IndexedDB database, so we need to look up
   * the correct store for each table when applying remote changes.
   */
  getKVStore: (schemaName: string, tableName: string) => Promise<KVStore>;
  /** The event emitter for data change events. */
  events: StoreEventEmitter;
  /** Function to get table schema by name. */
  getTableSchema: (schemaName: string, tableName: string) => TableSchema | undefined;
  /**
   * Table-level key collation K — must match the store module's configured
   * collation (default 'NOCASE'). A text PK column's own declared collation
   * overrides K for that column (via `resolvePkKeyCollations`), mirroring how
   * `StoreTable` keys its rows.
   */
  collation?: 'BINARY' | 'NOCASE';
}

/**
 * Creates an ApplyToStoreCallback for applying remote sync changes.
 *
 * This adapter handles:
 * - UPSERT semantics for column changes (insert if row doesn't exist, update if it does)
 * - Row deletions by primary key
 * - DDL execution for schema changes
 *
 * All data change events are emitted with `remote: true` to prevent
 * the SyncManager from re-recording CRDT metadata.
 */
export function createStoreAdapter(options: SyncStoreAdapterOptions): ApplyToStoreCallback {
  const { db, getKVStore, events, getTableSchema, collation = 'NOCASE' } = options;

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

    // Group data changes by table for efficient batch operations
    // Each table may have its own KV store (especially in IndexedDB)
    const changesByTable = groupChangesByTable(dataChanges);

    // Apply data changes per table
    for (const [tableKey, tableChanges] of changesByTable) {
      const [schemaName, tableName] = tableKey.split('.');
      try {
        // Get the correct KV store for this table
        const kv = await getKVStore(schemaName, tableName);

        // Group by row within the table
        const changesByRow = groupChangesByRow(tableChanges);

        for (const [rowKey, rowChanges] of changesByRow) {
          await applyRowChanges(kv, events, getTableSchema, collation, rowKey, rowChanges, applyOptions);
          result.dataChangesApplied += rowChanges.length;
        }
      } catch (error) {
        for (const change of tableChanges) {
          result.errors.push({
            change,
            error: toError(error),
          });
        }
      }
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
  // When IndexedDBModule.create() emits the event, it will be automatically
  // marked as remote, so SyncManager won't re-record it.
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
 * Apply data changes for a single row.
 */
async function applyRowChanges(
  kv: KVStore,
  events: StoreEventEmitter,
  getTableSchema: (schemaName: string, tableName: string) => TableSchema | undefined,
  collation: 'BINARY' | 'NOCASE',
  _rowKey: string,
  changes: DataChangeToApply[],
  _options: ApplyToStoreOptions
): Promise<void> {
  // All changes in the group should be for the same row
  const firstChange = changes[0];
  const { schema, table, pk } = firstChange;

  const tableSchema = getTableSchema(schema, table);
  if (!tableSchema) {
    throw new Error(`Table schema not found: ${schema}.${table}`);
  }

  const encodeOptions = { collation };
  const pkDirections = tableSchema.primaryKeyDefinition.map(p => !!p.desc);
  const pkCollations = resolvePkKeyCollations(tableSchema.primaryKeyDefinition, tableSchema.columns, collation);
  const dataKey = buildDataKey(pk, encodeOptions, pkDirections, pkCollations);

  // Check for delete operations first
  const deleteChange = changes.find(c => c.type === 'delete');
  if (deleteChange) {
    await applyDelete(kv, events, tableSchema, dataKey, pk);
    return;
  }

  // Apply column updates (UPSERT semantics)
  await applyColumnUpdates(kv, events, tableSchema, dataKey, pk, changes, { serializeRow, deserializeRow });
}

/**
 * Apply a delete operation for a row.
 */
async function applyDelete(
  kv: KVStore,
  events: StoreEventEmitter,
  tableSchema: TableSchema,
  dataKey: Uint8Array,
  pk: SqlValue[]
): Promise<void> {
  await kv.delete(dataKey);

  // Emit data change event with remote flag
  events.emitDataChange({
    type: 'delete',
    schemaName: tableSchema.schemaName,
    tableName: tableSchema.name,
    key: pk,
    remote: true,
  });
}

/**
 * Apply column updates with UPSERT semantics.
 */
async function applyColumnUpdates(
  kv: KVStore,
  events: StoreEventEmitter,
  tableSchema: TableSchema,
  dataKey: Uint8Array,
  pk: SqlValue[],
  changes: DataChangeToApply[],
  serialization: {
    serializeRow: (row: Row) => Uint8Array;
    deserializeRow: (data: Uint8Array) => Row;
  }
): Promise<void> {
  const { serializeRow, deserializeRow } = serialization;

  // Read existing row if any
  const existingData = await kv.get(dataKey);
  let row: Row;
  let isInsert = false;

  if (existingData) {
    row = deserializeRow(existingData);
  } else {
    // Create new row with nulls
    row = new Array(tableSchema.columns.length).fill(null);
    // Set PK values
    for (let i = 0; i < tableSchema.primaryKeyDefinition.length; i++) {
      const pkDef = tableSchema.primaryKeyDefinition[i];
      row[pkDef.index] = pk[i];
    }
    isInsert = true;
  }

  // Apply column changes from all changes
  const changedColumns: string[] = [];
  for (const change of changes) {
    if (change.columns) {
      for (const [colName, value] of Object.entries(change.columns)) {
        const colIndex = tableSchema.columnIndexMap.get(colName.toLowerCase());
        if (colIndex !== undefined) {
          row[colIndex] = value;
          changedColumns.push(colName);
        } else {
          // Column name not found in schema - this could be a sync bug
          console.warn(
            `[Sync] Column '${colName}' not found in ${tableSchema.schemaName}.${tableSchema.name}. ` +
            `Available columns: ${[...tableSchema.columnIndexMap.keys()].join(', ')}`
          );
        }
      }
    }
  }

  // Check if any columns were actually applied
  if (changedColumns.length === 0 && !isInsert) {
    console.warn(
      `[Sync] No columns were applied for ${tableSchema.schemaName}.${tableSchema.name} pk=${JSON.stringify(pk)}. ` +
      `This may indicate a column name mismatch between source and destination.`
    );
  }

  // Write updated row
  await kv.put(dataKey, serializeRow(row));

  // Emit data change event with remote flag
  events.emitDataChange({
    type: isInsert ? 'insert' : 'update',
    schemaName: tableSchema.schemaName,
    tableName: tableSchema.name,
    key: pk,
    newRow: row,
    changedColumns: isInsert ? undefined : changedColumns,
    remote: true,
  });
}

