import type { Database } from '../core/database.js'; // Assuming Database class exists
import type { VirtualTable } from './table.js';

import type { ColumnDef, Expression, TableConstraint } from '../parser/ast.js'; // <-- Add parser AST import
import type { TableSchema, IndexSchema } from '../schema/table.js'; // Add import for TableSchema and IndexSchema
import type { BestAccessPlanRequest, BestAccessPlanResult } from './best-access-plan.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import type { ModuleCapabilities } from './capabilities.js';

/**
 * Base interface for module-specific configuration passed to create/connect.
 * Modules should define their own interface extending this if they need options.
 */
export interface BaseModuleConfig {
	/** When true, the module should provide read-only access to the committed (pre-transaction) state */
	_readCommitted?: boolean;
}

/**
 * Declares whether a virtual table module tolerates concurrent calls on a
 * single connection. Consulted by parallel runtime consumers (e.g. fan-out
 * lookup joins) to decide whether sibling branches may share a connection
 * or must serialize.
 *
 * - `'serial'` — runtime must serialize vtab calls per connection. Safe
 *   default for any module that has not been audited; defeats parallelism
 *   for that module.
 * - `'reentrant-reads'` — concurrent `query()` calls on a single
 *   connection are safe; writes (`update()`, savepoint ops, etc.) still
 *   serialize.
 * - `'fully-reentrant'` — no constraint; any operation is safe to
 *   interleave with any other on the same connection.
 */
export type VtabConcurrencyMode = 'serial' | 'reentrant-reads' | 'fully-reentrant';

/**
 * Assessment result from a module's supports() method indicating
 * whether it can execute a plan subtree and at what cost.
 */
export interface SupportAssessment {
	/** Estimated cost comparable to local evaluation cost */
	cost: number;
	/** Optional context data persisted for the emitter */
	ctx?: unknown;
}

/**
 * Interface defining the methods for a virtual table module implementation.
 * The module primarily acts as a factory for connection-specific VirtualTable instances.
 *
 * @template TTable The specific type of VirtualTable managed by this module.
 * @template TConfig The type defining module-specific configuration options.
 */
export interface VirtualTableModule<
	TTable extends VirtualTable,
	TConfig extends BaseModuleConfig = BaseModuleConfig
> {

	/**
	 * Declares whether the runtime may issue concurrent calls (query, update,
	 * connect, …) against tables owned by this module while another call is
	 * already in flight on the same connection. Read by `ParallelDriver`
	 * consumers (e.g. FanOutLookupJoin) to decide whether sibling branches
	 * may share a connection or must serialize.
	 *
	 * - `'serial'` (default) — runtime serializes vtab calls per connection.
	 *   Safe for any module that has not been audited; defeats parallelism
	 *   for that module.
	 * - `'reentrant-reads'` — concurrent `query()` calls on a single
	 *   connection are safe; writes (`update()`, savepoint ops, etc.)
	 *   continue to serialize.
	 * - `'fully-reentrant'` — no constraint; any operation is safe to
	 *   interleave with any other on the same connection.
	 *
	 * Omit to inherit `'serial'`.
	 */
	readonly concurrencyMode?: VtabConcurrencyMode;

	/**
	 * Optional hint: expected first-row latency in milliseconds for an iterator
	 * opened against tables of this module. Local in-process modules omit this
	 * (treated as 0). Remote / network-backed modules should declare a non-zero
	 * value so the parallel fan-out rule can amortize per-branch latency across
	 * concurrent branches.
	 *
	 * Read by `TableReferenceNode.computePhysical` and propagated through the
	 * subtree via the standard `expectedLatencyMs` max-merge. Consumers must
	 * treat the value as a heuristic; correctness must never depend on it.
	 */
	readonly expectedLatencyMs?: number;

	/**
	 * Creates the persistent definition of a virtual table.
	 * Called by CREATE VIRTUAL TABLE to define schema and initialize storage.
	 *
	 * This method is async to allow modules to perform storage initialization
	 * (e.g., creating IndexedDB object stores) before returning. This ensures
	 * the table's storage is ready before any schema change events are processed.
	 *
	 * @param db The database connection
	 * @param tableSchema The schema definition for the table being created
	 * @returns Promise resolving to the new VirtualTable instance
	 * @throws QuereusError on failure
	 */
	create(
		db: Database,
		tableSchema: TableSchema,
	): Promise<TTable>;

	/**
	 * Connects to an existing virtual table definition.
	 * Called when the schema is loaded or a connection needs to interact with the table.
	 *
	 * This method is async to allow modules to perform async initialization when connecting
	 * to existing tables (e.g., opening IndexedDB transactions, loading metadata).
	 *
	 * @param db The database connection
	 * @param pAux Client data passed during module registration
	 * @param moduleName The name the module was registered with
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table to connect to
	 * @param options Module-specific configuration options from the original CREATE VIRTUAL TABLE
	 * @param tableSchema Optional table schema when connecting during import (columns, PK, etc.)
	 * @returns Promise resolving to the connection-specific VirtualTable instance
	 * @throws QuereusError on failure
	 */
	connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: TConfig,
		tableSchema?: TableSchema
	): Promise<TTable>;

	/**
	 * Determines if this module can execute a plan subtree starting at the given node.
	 * Used for query push-down to virtual table modules that support arbitrary queries.
	 *
	 * @param node The root node of the subtree to evaluate
	 * @returns Assessment with cost and optional context, or undefined if not supported
	 */
	supports?(
		node: PlanNode
	): SupportAssessment | undefined;

	/**
	 * Modern, type-safe access planning interface.
	 * Preferred over xBestIndex for new implementations.
	 *
	 * @param db The database connection
	 * @param tableInfo The schema information for the table being planned
	 * @param request Planning request with constraints and requirements
	 * @returns Access plan result describing the chosen strategy
	 */
	getBestAccessPlan?(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult;

	/**
	 * Destroys the underlying persistent representation of the virtual table.
	 * Called by DROP TABLE.
	 *
	 * @param db The database connection
	 * @param pAux Client data passed during module registration
	 * @param moduleName The name the module was registered with
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table being destroyed
	 * @throws QuereusError on failure
	 */
	destroy(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void>;

	/**
	 * Creates an index on a virtual table.
	 * Called by CREATE INDEX.
	 *
	 * @param db The database connection
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table
	 * @param indexSchema The schema definition for the index being created
	 * @throws QuereusError on failure
	 */
	createIndex?(
		db: Database,
		schemaName: string,
		tableName: string,
		indexSchema: IndexSchema
	): Promise<void>;

	/**
	 * Drops an index from a virtual table.
	 * Called by DROP INDEX.
	 *
	 * @param db The database connection
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table that owns the index
	 * @param indexName The name of the index to drop
	 * @throws QuereusError on failure
	 */
	dropIndex?(
		db: Database,
		schemaName: string,
		tableName: string,
		indexName: string
	): Promise<void>;

	/**
	 * Checks for shadow table name conflicts
	 * @param name The name to check
	 * @returns true if the name would conflict
	 */
	shadowName?(name: string): boolean;

	/**
	 * Returns capability flags for this module.
	 * Used for runtime capability discovery.
	 */
	getCapabilities?(): ModuleCapabilities;

	/**
	 * Alter an existing table's structure. Called by ALTER TABLE for
	 * data-affecting changes (ADD COLUMN, DROP COLUMN, RENAME COLUMN).
	 * RENAME TABLE is schema-only and does not call this method.
	 *
	 * Returns the updated TableSchema after the operation. The engine
	 * registers this in the schema catalog.
	 *
	 * If not implemented, the engine rejects data-affecting ALTER operations.
	 */
	alterTable?(
		db: Database,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
	): Promise<TableSchema>;

	/**
	 * Rename a table. Called by ALTER TABLE ... RENAME TO before the engine
	 * updates the in-memory schema catalog.
	 *
	 * The module is responsible for re-keying any internal handles, moving
	 * physical storage, and updating any persistent catalog entries it owns.
	 * The engine updates the `SchemaManager` after this call returns.
	 *
	 * If not implemented, RENAME TO is treated as a schema-only rename; modules
	 * that persist data keyed by the table name must implement this hook.
	 */
	renameTable?(
		db: Database,
		schemaName: string,
		oldName: string,
		newName: string,
	): Promise<void>;

	/**
	 * Optional. Called once by APPLY SCHEMA before the migration-DDL loop runs,
	 * iff there are migration statements to execute. The module may use this to
	 * open an in-memory overlay/batch that subsequent create/destroy/alter
	 * callbacks (during the loop) join, so the whole APPLY SCHEMA produces a
	 * single substrate commit.
	 *
	 * The hook runs inside the engine's exec() mutex hold, so the batch lives
	 * entirely within one engine-level execution scope.
	 *
	 * Modules that own no tables in `schemaName` should no-op.
	 */
	beginSchemaBatch?(db: Database, schemaName: string): Promise<void>;

	/**
	 * Optional. Called exactly once per successful `beginSchemaBatch`, on both
	 * success (`error` undefined) and failure (`error` is the failure that
	 * aborted the migration loop). On error, the module should discard the
	 * in-flight overlay; on success, it commits.
	 *
	 * Errors thrown from `endSchemaBatch` itself are logged and rethrown only
	 * if no prior loop error exists — if a loop error is being propagated, the
	 * end-batch failure is logged and swallowed so the original cause survives.
	 */
	endSchemaBatch?(db: Database, schemaName: string, error?: unknown): Promise<void>;
}

/**
 * Defines the structure for schema change information passed to xAlterSchema
 */
export type SchemaChangeInfo =
	| { type: 'addColumn'; columnDef: ColumnDef }
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string; newColumnDefAst?: ColumnDef }
	| { type: 'alterPrimaryKey'; newPkColumns: ReadonlyArray<{ index: number; desc: boolean }> }
	| { type: 'addConstraint'; constraint: TableConstraint }
	| {
		/**
		 * ALTER COLUMN with exactly one attribute change.
		 *
		 * Module contract:
		 *   - setNotNull=true with rows containing NULL → throw CONSTRAINT.
		 *     If a DEFAULT is currently set on the column, the module should
		 *     first backfill NULL values with the default and then tighten.
		 *   - setDataType: schema-only if physical type unchanged; otherwise the
		 *     module must convert each row and throw MISMATCH on loss (narrowing,
		 *     NaN, overflow).
		 *   - setDefault / drop default: schema-only. New inserts pick up the
		 *     new default; existing rows are untouched.
		 */
		type: 'alterColumn';
		columnName: string;
		setNotNull?: boolean;
		setDataType?: string;
		setDefault?: Expression | null;
	};

/**
 * Type alias for the common usage pattern where specific table and config types are not known.
 * Use this for storage scenarios like the SchemaManager where modules of different types are stored together.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyVirtualTableModule = VirtualTableModule<any, any>;
