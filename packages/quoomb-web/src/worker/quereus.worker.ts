import * as Comlink from 'comlink';
import { Database, generateTableDDL, type SqlValue, type DatabaseDataChangeEvent, type DatabaseSchemaChangeEvent } from '@quereus/quereus';
import { expressionToString } from '@quereus/quereus/emit';
import type { Expression } from '@quereus/quereus/parser';
import { StoreEventEmitter, StoreModule, type KVStore } from '@quereus/store';
import {
	createStoreAdapter,
	createSyncModule,
	type ConflictEvent,
	type LocalChangeEvent,
	type RemoteChangeEvent,
	type SyncEventEmitter as SyncEventEmitterType,
	type SyncManager,
	type SyncState,
} from '@quereus/sync';
import { SyncClient, type SyncEvent as SyncClientEvent, type SyncStatus as SyncClientStatus } from '@quereus/sync-client';
import * as Comlink from 'comlink';
import Papa from 'papaparse';
import type {
	ColumnInfo,
	CsvPreview,
	DataChangeCallback,
	PlanGraph,
	PlanGraphNode,
	PluginManifest,
	QuereusWorkerAPI,
	SchemaChangeCallback,
	StorageModuleType,
	SyncEvent,
	SyncStatus,
	TableInfo,
} from './types.js';

// Maximum number of sync events to keep in history
const MAX_SYNC_EVENTS = 100;

class QuereusWorker implements QuereusWorkerAPI {
  private db: Database | null = null;

  // Storage module state
  private currentStorageModule: StorageModuleType = 'memory';
  private storeEvents: StoreEventEmitter | null = null;
  private kvStore: KVStore | null = null;
  private storeModule: StoreModule | null = null;
  private indexedDBProvider: IndexedDBProvider | null = null;

  // Sync module state
  private syncManager: SyncManager | null = null;
  private syncEvents: SyncEventEmitterType | null = null;
  private syncClient: SyncClient | null = null;
  private syncStatus: SyncStatus = { status: 'disconnected' };
  private syncEventHistory: SyncEvent[] = [];
  private syncEventSubscribers = new Map<string, (event: SyncEvent) => void>();

  // Database-level event subscribers (forwarded to UI via Comlink)
  private dataChangeSubscribers = new Map<string, DataChangeCallback>();
  private schemaChangeSubscribers = new Map<string, SchemaChangeCallback>();
  private dbDataChangeUnsub: (() => void) | null = null;
  private dbSchemaChangeUnsub: (() => void) | null = null;

  // Initialization promises to prevent race conditions
  private storeModuleInitPromise: Promise<void> | null = null;

  private requireDb(): Database {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  private async collectRows(iter: AsyncIterable<Record<string, SqlValue>>): Promise<Record<string, SqlValue>[]> {
    const results: Record<string, SqlValue>[] = [];
    for await (const row of iter) {
      results.push(row);
    }
    return results;
  }

  async initialize(): Promise<void> {
    try {
      this.db = new Database();
      // Set up database-level event listeners if there are pending subscribers
      this.setupDatabaseEventListeners();
    } catch (error) {
      throw new Error(`Failed to initialize Quereus database: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Set up database-level event listeners for any pending subscribers.
   * Called after database is initialized or when storage module changes.
   */
  private setupDatabaseEventListeners(): void {
    if (!this.db) return;

    // Clean up any existing subscriptions
    if (this.dbDataChangeUnsub) {
      this.dbDataChangeUnsub();
      this.dbDataChangeUnsub = null;
    }
    if (this.dbSchemaChangeUnsub) {
      this.dbSchemaChangeUnsub();
      this.dbSchemaChangeUnsub = null;
    }

    // Re-subscribe if there are active subscribers
    if (this.dataChangeSubscribers.size > 0) {
      this.dbDataChangeUnsub = this.db.onDataChange((event) => {
        for (const cb of this.dataChangeSubscribers.values()) {
          try {
            cb(event);
          } catch (error) {
            console.warn('Error in data change subscriber:', error);
          }
        }
      });
    }

    if (this.schemaChangeSubscribers.size > 0) {
      this.dbSchemaChangeUnsub = this.db.onSchemaChange((event) => {
        for (const cb of this.schemaChangeSubscribers.values()) {
          try {
            cb(event);
          } catch (error) {
            console.warn('Error in schema change subscriber:', error);
          }
        }
      });
    }
  }

  async executeQuery(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<Record<string, SqlValue>[]> {
    const db = this.requireDb();

    try {
      return await this.collectRows(db.eval(sql, params));
    } catch (error) {
      throw new Error(`Query execution failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async executeStatement(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<void> {
    const db = this.requireDb();

    try {
      // Use db.exec() instead of stmt.run() to get automatic transaction wrapping
      // Quereus requires mutations to be wrapped in transactions, and db.exec()
      // automatically creates an implicit transaction for single statements
      await db.exec(sql, params);
    } catch (error) {
      throw new Error(`Statement execution failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async explainQuery(sql: string): Promise<Record<string, SqlValue>[]> {
    const db = this.requireDb();

    try {
      // Use Quereus's query_plan() function with parameterized query to avoid escaping issues
      // Try using parameterized query instead of string interpolation
      return await this.collectRows(db.eval('SELECT * FROM query_plan(?)', [sql]));
    } catch (error) {
      throw new Error(`Query explanation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async explainProgram(sql: string): Promise<Record<string, SqlValue>[]> {
    const db = this.requireDb();

    try {
      // Use Quereus's scheduler_program() function
      return await this.collectRows(db.eval('SELECT * FROM scheduler_program(?)', [sql]));
    } catch (error) {
      throw new Error(`Program explanation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async executionTrace(sql: string): Promise<Record<string, SqlValue>[]> {
    const db = this.requireDb();

    try {
      // Use Quereus's execution_trace() function to get detailed instruction-level trace
      return await this.collectRows(db.eval('SELECT * FROM execution_trace(?)', [sql]));
    } catch (error) {
      throw new Error(`Execution trace failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async rowTrace(sql: string): Promise<Record<string, SqlValue>[]> {
    const db = this.requireDb();

    try {
      // Use Quereus's row_trace() function to get detailed row-level trace
      return await this.collectRows(db.eval('SELECT * FROM row_trace(?)', [sql]));
    } catch (error) {
      throw new Error(`Row trace failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async explainPlanGraph(sql: string, options?: { withActual?: boolean }): Promise<PlanGraph> {
    const db = this.requireDb();

    try {
      // Get the base query plan
      const planResults = await this.collectRows(db.eval('SELECT * FROM query_plan(?)', [sql]));

      // Get actual execution data if requested
      let traceResults: Record<string, SqlValue>[] = [];
      if (options?.withActual) {
        try {
          // First execute the query to get actual timing data
          await this.collectRows(db.eval(sql));

          // Then get execution trace
          traceResults = await this.collectRows(db.eval('SELECT * FROM execution_trace(?)', [sql]));
        } catch (error) {
          console.warn('Could not get actual execution data:', error);
          // Continue with estimated data only
        }
      }

      // Convert to graph structure
      return this.buildPlanGraph(planResults, traceResults, sql);
    } catch (error) {
      throw new Error(`Plan graph failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private buildPlanGraph(planRows: Record<string, SqlValue>[], traceRows: Record<string, SqlValue>[], _originalSql: string): PlanGraph {
    // Build a simple linear plan structure from the plan data
    // This is a simplified version - real implementation would need to parse the actual plan structure
    const nodes: PlanGraphNode[] = [];
    let totalEstCost = 0;
    let totalEstRows = 0;
    let totalActTime = 0;

    const traceByStep = new Map<number, Record<string, SqlValue>>();
    for (const traceRow of traceRows) {
      const stepId = traceRow.step_id;
      if (typeof stepId === 'number') traceByStep.set(stepId, traceRow);
    }

    // Create nodes from plan data
    planRows.forEach((row, index) => {
      const estCost = (row.est_cost as number) || 0;
      const estRows = (row.est_rows as number) || 0;

      totalEstCost += estCost;
      totalEstRows += estRows;

      // Use the proper fields from query_plan schema
      const op = (row.op as string) || 'UNKNOWN';
      const detail = (row.detail as string) || '';
      const objectName = (row.object_name as string) || null;
      const alias = (row.alias as string) || null;
      const nodeType = (row.node_type as string) || '';
      const subqueryLevel = (row.subquery_level as number) || 0;

      // Find corresponding trace data
      const traceRow = traceByStep.get(index + 1);

      const actTimeMs = traceRow ? (traceRow.duration_ms as number) : undefined;
      const actRows = traceRow ? (traceRow.rows_processed as number) : undefined;

      if (actTimeMs) totalActTime += actTimeMs;

      nodes.push({
        id: `node-${index}`,
        opcode: op, // Use the proper 'op' field
        estCost,
        estRows,
        actTimeMs,
        actRows,
        sqlSpan: undefined, // TODO: Extract from plan if available
        extra: {
          detail,
          objectName: objectName || undefined,
          alias: alias || undefined,
          nodeType,
          subqueryLevel,
          selectid: row.selectid,
          order: row.order
        },
        children: []
      });
    });

    // For now, create a simple linear tree (each node's child is the next node)
    // Real implementation would parse the actual tree structure from selectid/order
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i].children = [nodes[i + 1]];
    }

    const root = nodes[0] || {
      id: 'root',
      opcode: 'EMPTY',
      estCost: 0,
      estRows: 0,
      children: []
    };

    return {
      root,
      totals: {
        estCost: totalEstCost,
        estRows: totalEstRows,
        actTimeMs: totalActTime > 0 ? totalActTime : undefined
      }
    };
  }

  async listTables(): Promise<Array<{ name: string; type: string }>> {
    const db = this.requireDb();

    try {
      const results: Array<{ name: string; type: string }> = [];

      // Pull directly from schemaManager instead of sqlite_schema compatibility view
      const mainSchema = db.schemaManager.getMainSchema();

      for (const table of mainSchema.getAllTables()) {
        results.push({
          name: table.name,
          type: table.isView ? 'view' : 'table',
        });
      }

      for (const view of mainSchema.getAllViews()) {
        results.push({
          name: view.name,
          type: 'view',
        });
      }

      // Sort by name for consistent ordering
      results.sort((a, b) => a.name.localeCompare(b.name));

      return results;
    } catch (error) {
      throw new Error(`Failed to list tables: ${error instanceof Error ? error.message : error}`);
    }
  }

  async getTableSchema(tableName: string): Promise<TableInfo> {
    const db = this.requireDb();

    try {
      const mainSchema = db.schemaManager.getMainSchema();

      // Check for a table first
      const tableSchema = mainSchema.getTable(tableName);
      if (tableSchema) {
        const columns: ColumnInfo[] = tableSchema.columns.map((col, index) => {
          const isPrimaryKey = tableSchema.primaryKeyDefinition.some(pk => pk.index === index);
          return {
            name: col.name,
            type: col.logicalType.name,
            nullable: !col.notNull,
            defaultSql: this.defaultExpressionToSql(col.defaultValue),
            primaryKey: isPrimaryKey,
          };
        });

        return {
          name: tableSchema.name,
          type: tableSchema.isView ? 'view' : 'table',
          sql: generateTableDDL(tableSchema, db),
          columns,
        };
      }

      // Check for a view
      const viewSchema = mainSchema.getView(tableName);
      if (viewSchema) {
        // ViewSchema.columns is just an array of column names (strings), not full column objects.
        // For views, we return minimal column info (names only).
        const columns: ColumnInfo[] = (viewSchema.columns ?? []).map(colName => ({
          name: colName,
          type: 'ANY',
          nullable: true,
          primaryKey: false,
        }));

        return {
          name: viewSchema.name,
          type: 'view',
          sql: viewSchema.sql,
          columns,
        };
      }

      throw new Error(`Table or view '${tableName}' not found`);
    } catch (error) {
      throw new Error(`Failed to get table schema: ${error instanceof Error ? error.message : error}`);
    }
  }

  async previewCsv(csvData: string): Promise<CsvPreview> {
    try {
      const parseResult = this.parseCsv(csvData);
      const actualErrors = this.filterCsvErrors(parseResult.errors);

      if (parseResult.data.length === 0) {
        return {
          columns: [],
          sampleRows: [],
          totalRows: 0,
          errors: actualErrors.map(e => e.message),
          inferredTypes: {}
        };
      }

      const firstRow = parseResult.data[0] as Record<string, unknown>;
      const originalColumns = Object.keys(firstRow);

      // Sanitize column names (same logic as import)
      const sanitizedColumns = originalColumns.map((col, index) => this.sanitizeColumnName(col, index));

      // Infer column types from data (same logic as import)
      const inferredTypes: Record<string, string> = {};
      sanitizedColumns.forEach((sanitizedCol, index) => {
        const originalCol = originalColumns[index];
        const sampleValues = parseResult.data.slice(0, 10).map(row => (row as Record<string, unknown>)[originalCol]);
        inferredTypes[sanitizedCol] = this.inferSqlType(sampleValues);
      });

      // Create sample rows with sanitized column names
      const sampleRows = parseResult.data.slice(0, 5).map(row => {
        const sanitizedRow: Record<string, unknown> = {};
        originalColumns.forEach((originalCol, index) => {
          const sanitizedCol = sanitizedColumns[index];
          sanitizedRow[sanitizedCol] = (row as Record<string, unknown>)[originalCol];
        });
        return sanitizedRow;
      });

      return {
        columns: sanitizedColumns, // Return sanitized column names
        sampleRows,
        totalRows: parseResult.data.length,
        errors: actualErrors.map(e => e.message), // Only show actual errors
        inferredTypes
      };
    } catch (error) {
      throw new Error(`CSV preview failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async importCsv(csvData: string, tableName: string): Promise<{ rowsImported: number }> {
    const db = this.requireDb();

    try {
      const parseResult = this.parseCsv(csvData);
      const actualErrors = this.filterCsvErrors(parseResult.errors);

      if (actualErrors.length > 0) {
        throw new Error(`CSV parsing errors: ${actualErrors.map(e => e.message).join(', ')}`);
      }

      if (parseResult.data.length === 0) {
        return { rowsImported: 0 };
      }

      const sanitizedTableName = this.sanitizeTableName(tableName);

      // Infer column types from data
      const firstRow = parseResult.data[0] as Record<string, unknown>;
      const columnNames = Object.keys(firstRow);

      if (columnNames.length === 0) {
        throw new Error('No columns found in CSV data');
      }

      const sanitizedColumnNames = columnNames.map((col, index) => this.sanitizeColumnName(col, index));
      const columnDefs = columnNames.map((col, index) => {
        const sanitizedCol = sanitizedColumnNames[index];
        const sampleValues = parseResult.data.slice(0, 10).map(row => (row as Record<string, unknown>)[col]);
        const type = this.inferSqlType(sampleValues);
        return `${sanitizedCol} ${type}`;
      });

      // Create table with proper SQL syntax - no quotes around column names in definition
      const createSql = `CREATE TABLE ${sanitizedTableName} (${columnDefs.join(', ')})`;

      try {
        await db.exec(createSql);
      } catch (createError) {
        throw new Error(`Failed to create table: ${createError instanceof Error ? createError.message : createError}`);
      }

      // Insert data with proper column mapping
      const placeholders = sanitizedColumnNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO ${sanitizedTableName} (${sanitizedColumnNames.join(', ')}) VALUES (${placeholders})`;

      const stmt = db.prepare(insertSql);
      let insertCount = 0;

      try {
        await db.beginTransaction();
        try {
          for (const row of parseResult.data) {
            const values = columnNames.map(col => (row as Record<string, unknown>)[col] as SqlValue);
            await stmt.run(values);
            insertCount++;
          }
          await db.commit();
        } catch (e) {
          await db.rollback();
          throw e;
        }
      } finally {
        await stmt.finalize();
      }

      return { rowsImported: insertCount };
    } catch (error) {
      throw new Error(`CSV import failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async loadModule(url: string, config?: Record<string, SqlValue>): Promise<PluginManifest | undefined> {
    const db = this.requireDb();

    try {
      return await dynamicLoadModule(url, db, config ?? {});
    } catch (error) {
      console.error('Failed to load module:', error);
      throw error;
    }
  }

  // ============================================================================
  // Storage Module Management
  // ============================================================================

  getStorageModule(): StorageModuleType {
    return this.currentStorageModule;
  }

  async setStorageModule(module: StorageModuleType): Promise<void> {
    const db = this.requireDb();

    if (module === this.currentStorageModule) {
      return; // Already set
    }

    // Clean up previous module state if switching away from store/sync
    if (this.currentStorageModule === 'sync' && this.syncClient) {
      await this.disconnectSync();
    }

    switch (module) {
      case 'memory':
        // Set memory as the default module
        db.setDefaultVtabName('memory');
        this.currentStorageModule = 'memory';
        break;

      case 'store':
        // Initialize IndexedDB store and set as default
        // Set default module BEFORE restore so imported DDL uses correct module
        await this.initializeStoreModule();
        this.currentStorageModule = 'store';
        break;

      case 'sync':
        // Initialize store first, then sync on top
        await this.initializeStoreModule();
        await this.initializeSyncModule();
        this.currentStorageModule = 'sync';
        break;

      default:
        throw new Error(`Unknown storage module: ${module}`);
    }
  }

  getAvailableModules(): StorageModuleType[] {
    return ['memory', 'store', 'sync'];
  }
  private async initializeStoreModule(): Promise<void> {
    this.requireDb();

    // Only initialize once - use promise to prevent race conditions
    if (this.storeModuleInitPromise) {
      return this.storeModuleInitPromise;
    }

    this.storeModuleInitPromise = this.doInitializeStoreModule();
    return this.storeModuleInitPromise;
  }

  private async doInitializeStoreModule(): Promise<void> {
    const db = this.requireDb();

    // Create store event emitter
    this.storeEvents = new StoreEventEmitter();

    // Create IndexedDB provider and store module
    this.indexedDBProvider = new IndexedDBProvider({ databaseName: 'quoomb' });
    this.storeModule = new StoreModule(this.indexedDBProvider, this.storeEvents);
    db.registerModule('store', this.storeModule);

    // Set default module BEFORE restore so imported DDL (which may lack USING clause) uses store
    db.setDefaultVtabName('store');

    // Open a default KV store for sync metadata
    this.kvStore = await IndexedDBStore.openForTable('quoomb', 'sync_meta');

    // Rehydrate persisted catalog from IndexedDB
    const rehydration = await this.storeModule.rehydrateCatalog(db);
    if (rehydration.errors.length > 0) {
      console.warn(
        `[quoomb-web] ${rehydration.errors.length} catalog entries failed to rehydrate`
      );
    }
  }

  private async initializeSyncModule(): Promise<void> {
    if (!this.db || !this.storeEvents || !this.kvStore || !this.storeModule) {
      throw new Error('Store module must be initialized first');
    }

    // Only initialize once
    if (this.syncManager) {
      return;
    }

    // Create store adapter for applying remote changes
    // This executes DDL/DML on the local database when remote changes arrive
    const db = this.db;
    const storeModule = this.storeModule;
    const getTableSchema = (schemaName: string, tableName: string) => {
      return db.schemaManager.getTable(schemaName, tableName);
    };

    // Get the correct KV store for each table
    const getKVStore = async (schemaName: string, tableName: string) => {
      const tableKey = `${schemaName}.${tableName}`.toLowerCase();
      const config = { collation: 'NOCASE' as const };
      return storeModule.getStore(tableKey, config);
    };

    const applyToStore = createStoreAdapter({
      db: this.db,
      getKVStore,
      events: this.storeEvents,
      getTableSchema,
      collation: 'NOCASE',
    });

    // Create sync module with the store adapter and schema lookup
    // getTableSchema is needed for proper column name mapping in sync
    const { syncManager, syncEvents } = await createSyncModule(
      this.kvStore,
      this.storeEvents,
      { applyToStore, getTableSchema }
    );

    this.syncManager = syncManager;
    this.syncEvents = syncEvents;

    // Subscribe to sync events and forward to UI
    this.setupSyncEventListeners();
  }

  private setupSyncEventListeners(): void {
    if (!this.syncEvents) return;

    // Remote changes from sync module (not from SyncClient - these are internal)
    this.syncEvents.onRemoteChange((event: RemoteChangeEvent) => {
      this.addSyncEvent({
        type: 'remote-change',
        timestamp: Date.now(),
        message: `Received ${event.changes.length} changes from peer`,
        details: {
          changeCount: event.changes.length,
        },
      });
    });

    // Local changes - just log for UI, SyncClient handles debouncing and sending
    this.syncEvents.onLocalChange((event: LocalChangeEvent) => {
      this.addSyncEvent({
        type: 'local-change',
        timestamp: Date.now(),
        message: `Made ${event.changes.length} local changes`,
        details: {
          changeCount: event.changes.length,
        },
      });
    });

    // Conflicts
    this.syncEvents.onConflictResolved((event: ConflictEvent) => {
      this.addSyncEvent({
        type: 'conflict',
        timestamp: Date.now(),
        message: `Conflict resolved in ${event.table}.${event.column} (${event.winner} won)`,
        details: {
          table: event.table,
          conflictColumn: event.column,
          winner: event.winner,
        },
      });
    });

    // State changes from sync module
    this.syncEvents.onSyncStateChange((state: SyncState) => {
      this.syncStatus = this.convertSyncState(state);
      this.addSyncEvent({
        type: 'state-change',
        timestamp: Date.now(),
        message: `Sync state: ${state.status}`,
      });
    });
  }

  private convertSyncState(state: SyncState): SyncStatus {
    switch (state.status) {
      case 'disconnected':
        return { status: 'disconnected' };
      case 'connecting':
        return { status: 'connecting' };
      case 'syncing':
        return { status: 'syncing', progress: state.progress ?? 0 };
      case 'synced':
        return { status: 'synced', lastSyncTime: Date.now() };
      case 'error':
        return { status: 'error', message: state.error?.message ?? 'Unknown error' };
      default:
        return { status: 'disconnected' };
    }
  }

  private addSyncEvent(event: SyncEvent): void {
    this.syncEventHistory.unshift(event);

    // Trim history
    if (this.syncEventHistory.length > MAX_SYNC_EVENTS) {
      this.syncEventHistory = this.syncEventHistory.slice(0, MAX_SYNC_EVENTS);
    }

    // Notify subscribers
    for (const callback of this.syncEventSubscribers.values()) {
      try {
        callback(event);
      } catch (error) {
        console.warn('Error in sync event subscriber:', error);
      }
    }
  }

  // ============================================================================
  // Sync Operations
  // ============================================================================

  getSyncStatus(): SyncStatus {
    return this.syncStatus;
  }

  async connectSync(url: string, databaseId: string, token?: string): Promise<void> {
    if (!this.syncManager || !this.syncEvents) {
      throw new Error('Sync module not initialized. Call setStorageModule("sync") first.');
    }

    // Disconnect existing client if any
    if (this.syncClient) {
      await this.syncClient.disconnect();
    }

    // Create new SyncClient with callbacks that forward to our event system
    this.syncClient = new SyncClient({
      syncManager: this.syncManager,
      syncEvents: this.syncEvents,
      autoReconnect: true,
      onStatusChange: (status: SyncClientStatus) => {
        // Convert SyncClient status to our SyncStatus type
        this.syncStatus = status as SyncStatus;
      },
      onSyncEvent: (event: SyncClientEvent) => {
        // Forward SyncClient events to our event history
        this.addSyncEvent(event as SyncEvent);
      },
      onError: (error: Error) => {
        this.addSyncEvent({
          type: 'error',
          timestamp: Date.now(),
          message: error.message,
        });
      },
    });

    // Connect to the server
    await this.syncClient.connect(url, databaseId, token);
  }

  /**
   * Disconnect from sync server and stop reconnection attempts.
   */
  async disconnectSync(): Promise<void> {
    if (this.syncClient) {
      await this.syncClient.disconnect();
      this.syncClient = null;
    }
    this.syncStatus = { status: 'disconnected' };
  }



  getSyncEvents(limit?: number): SyncEvent[] {
    if (limit) {
      return this.syncEventHistory.slice(0, limit);
    }
    return [...this.syncEventHistory];
  }

  onSyncEvent(callback: (event: SyncEvent) => void): string {
    const id = crypto.randomUUID();
    this.syncEventSubscribers.set(id, callback);
    return id;
  }

  offSyncEvent(subscriptionId: string): void {
    this.syncEventSubscribers.delete(subscriptionId);
  }

  // ============================================================================
  // Database-Level Event Subscriptions
  // ============================================================================

  /**
   * Subscribe to data change events from all modules.
   * Events are emitted after successful commit and include module name and remote flag.
   */
  onDataChange(callback: DataChangeCallback): string {
    const id = crypto.randomUUID();
    const wasEmpty = this.dataChangeSubscribers.size === 0;
    this.dataChangeSubscribers.set(id, callback);

    // Subscribe to database events on first subscriber
    if (wasEmpty) {
      this.setupDatabaseEventListeners();
    }

    return id;
  }

  /**
   * Unsubscribe from data change events.
   */
  offDataChange(subscriptionId: string): void {
    this.dataChangeSubscribers.delete(subscriptionId);

    // Unsubscribe from database events if no more subscribers
    if (this.dataChangeSubscribers.size === 0 && this.dbDataChangeUnsub) {
      this.dbDataChangeUnsub();
      this.dbDataChangeUnsub = null;
    }
  }

  /**
   * Subscribe to schema change events from all modules.
   * Events are emitted for CREATE/ALTER/DROP operations.
   */
  onSchemaChange(callback: SchemaChangeCallback): string {
    const id = crypto.randomUUID();
    const wasEmpty = this.schemaChangeSubscribers.size === 0;
    this.schemaChangeSubscribers.set(id, callback);

    // Subscribe to database events on first subscriber
    if (wasEmpty) {
      this.setupDatabaseEventListeners();
    }

    return id;
  }

  /**
   * Unsubscribe from schema change events.
   */
  offSchemaChange(subscriptionId: string): void {
    this.schemaChangeSubscribers.delete(subscriptionId);

    // Unsubscribe from database events if no more subscribers
    if (this.schemaChangeSubscribers.size === 0 && this.dbSchemaChangeUnsub) {
      this.dbSchemaChangeUnsub();
      this.dbSchemaChangeUnsub = null;
    }
  }

  async close(): Promise<void> {
    // Clean up sync connection
    if (this.syncClient) {
      await this.syncClient.disconnect();
      this.syncClient = null;
    }

    // Clean up KV store
    if (this.kvStore) {
      await this.kvStore.close();
      this.kvStore = null;
    }

    // Clean up database event subscriptions
    if (this.dbDataChangeUnsub) {
      this.dbDataChangeUnsub();
      this.dbDataChangeUnsub = null;
    }
    if (this.dbSchemaChangeUnsub) {
      this.dbSchemaChangeUnsub();
      this.dbSchemaChangeUnsub = null;
    }
    this.dataChangeSubscribers.clear();
    this.schemaChangeSubscribers.clear();

    // Reset state
    this.syncManager = null;
    this.syncEvents = null;
    this.storeEvents = null;
    this.syncEventSubscribers.clear();
    this.syncEventHistory = [];
    this.currentStorageModule = 'memory';

    if (this.db) {
      try {
        await this.db.close();
      } catch (error) {
        console.warn('Error closing database:', error);
      }
      this.db = null;
    }
  }

  private defaultExpressionToSql(expr: Expression | null): string | undefined {
    if (!expr) return undefined;
    if (expr.type === 'literal' && expr.value instanceof Uint8Array) {
      return this.uint8ArrayToHexLiteral(expr.value);
    }
    return expressionToString(expr);
  }

  private uint8ArrayToHexLiteral(v: Uint8Array): string {
    const hex = Array.from(v, byte => byte.toString(16).padStart(2, '0')).join('');
    return `x'${hex}'`;
  }

  private parseCsv(csvData: string): Papa.ParseResult<Record<string, unknown>> {
    return Papa.parse<Record<string, unknown>>(csvData, {
      header: true,
      skipEmptyLines: true,
      transform: (value, _field) => {
        if (value === '') return null;
        const num = Number(value);
        if (!Number.isNaN(num) && value === num.toString()) {
          return num;
        }
        return value;
      }
    });
  }

  private filterCsvErrors(errors: Papa.ParseError[]): Papa.ParseError[] {
    return errors.filter(error => {
      if (error.message && error.message.includes('Unable to auto-detect delimiting character')) {
        return false;
      }
      if (error.type === 'Quotes' || error.type === 'Delimiter') {
        return false;
      }
      return true;
    });
  }

  private sanitizeTableName(name: string): string {
    let sanitized = name.trim();
    if (!sanitized) sanitized = 'imported_table';
    sanitized = sanitized.replace(/[^a-zA-Z0-9_]/g, '_');
    if (/^[0-9]/.test(sanitized)) sanitized = 'table_' + sanitized;
    if (!sanitized || sanitized === '_'.repeat(sanitized.length)) sanitized = 'imported_table';
    return sanitized;
  }

  private sanitizeColumnName(name: string, index: number): string {
    let sanitized = name.trim();
    if (!sanitized) sanitized = `column_${index + 1}`;
    sanitized = sanitized.replace(/[^a-zA-Z0-9_]/g, '_');
    if (/^[0-9]/.test(sanitized)) sanitized = 'col_' + sanitized;
    if (!sanitized || sanitized === '_'.repeat(sanitized.length)) sanitized = `column_${index + 1}`;
    return sanitized;
  }

  private inferSqlType(sampleValues: unknown[]): 'TEXT' | 'REAL' {
    const hasNumbers = sampleValues.some(val => typeof val === 'number');
    const hasStrings = sampleValues.some(val => typeof val === 'string' && val !== '');
    if (hasNumbers && !hasStrings) return 'REAL';
    return 'TEXT';
  }
}

// Expose the worker API via Comlink
const worker = new QuereusWorker();
Comlink.expose(worker);
