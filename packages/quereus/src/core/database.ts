import { createLogger } from '../common/logger.js';
import { MisuseError, QuereusError } from '../common/errors.js';
import { StatusCode, type SqlParameters, type SqlValue, type Row, type OutputValue } from '../common/types.js';
import type { ScalarType } from '../common/datatype.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';
import { Statement } from './statement.js';
import { SchemaManager } from '../schema/manager.js';
import type { TableSchema } from '../schema/table.js';
import type { FunctionSchema } from '../schema/function.js';
import { BUILTIN_FUNCTIONS } from '../func/builtins/index.js';
import { createScalarFunction, createAggregateFunction } from '../func/registration.js';
import { FunctionFlags } from '../common/constants.js';
import { MemoryTableModule } from '../vtab/memory/module.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import { BINARY_COLLATION, NOCASE_COLLATION, RTRIM_COLLATION, type CollationFunction } from '../util/comparison.js';
import { BUILTIN_NORMALIZERS } from '../util/key-serializer.js';
import { Parser } from '../parser/parser.js';
import * as AST from '../parser/ast.js';
import { buildBlock } from '../planner/building/block.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { RuntimeContext } from '../runtime/types.js';
import { RowContextMap } from '../runtime/context-helpers.js';
import type { RowDescriptor } from '../planner/nodes/plan-node.js';
import { BlockNode } from '../planner/nodes/block.js';
import type { PlanningContext } from '../planner/planning-context.js';
import { BuildTimeDependencyTracker } from '../planner/planning-context.js';
import { ParameterScope } from '../planner/scopes/param.js';
import { GlobalScope } from '../planner/scopes/global.js';
import { PlanNode } from '../planner/nodes/plan-node.js';
import { registerEmitters } from '../runtime/register.js';
import { serializePlanTree, formatPlanTree } from '../planner/debug.js';
import type { DebugOptions } from '../planner/planning-context.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { Optimizer, DEFAULT_TUNING } from '../planner/optimizer.js';
import type { OptimizerTuning } from '../planner/optimizer-tuning.js';
import { registerBuiltinWindowFunctions } from '../func/builtins/builtin-window-functions.js';
import { DatabaseOptionsManager } from './database-options.js';
import type { InstructionTracer } from '../runtime/types.js';
import { DeclaredSchemaManager } from '../schema/declared-schema-manager.js';
import { DeferredConstraintQueue } from '../runtime/deferred-constraint-queue.js';
import { type LogicalType } from '../types/logical-type.js';
import { registerType as registerTypeInRegistry } from '../types/registry.js';
import { getParameterTypes } from './param.js';
import { rowToObject } from './utils.js';
import { wrapAsyncIterator } from '../util/async-iterator.js';
import {
	DatabaseEventEmitter,
	type DatabaseDataChangeEvent,
	type DatabaseSchemaChangeEvent,
	type DataChangeSubscriptionOptions,
	type SchemaChangeSubscriptionOptions,
} from './database-events.js';
import { TransactionManager, type TransactionManagerContext } from './database-transaction.js';
import { AssertionEvaluator, type AssertionEvaluatorContext } from './database-assertions.js';
import type { VTableEventEmitter } from '../vtab/events.js';

const log = createLogger('core:database');
const errorLog = log.extend('error');

/** Result from _buildPlan containing both the plan tree and its schema dependencies. */
export interface BuildPlanResult {
	plan: BlockNode;
	schemaDependencies: BuildTimeDependencyTracker;
}

/** Parse a comma-separated schema path string into an array of trimmed, non-empty names. */
function parseSchemaPath(pathString: string): string[] | undefined {
	if (!pathString) return undefined;
	const parts = pathString.split(',').map(s => s.trim()).filter(s => s.length > 0);
	return parts.length > 0 ? parts : undefined;
}

/** Extract a VTableEventEmitter from a module if it supports one. */
function tryGetEventEmitter(module: AnyVirtualTableModule): VTableEventEmitter | undefined {
	const asSource = module as { getEventEmitter?: () => unknown };
	if (typeof asSource.getEventEmitter !== 'function') return undefined;
	const emitter = asSource.getEventEmitter();
	if (!emitter || typeof emitter !== 'object') return undefined;
	const typed = emitter as { onDataChange?: unknown; onSchemaChange?: unknown };
	if (typeof typed.onDataChange !== 'function' && typeof typed.onSchemaChange !== 'function') return undefined;
	return emitter as VTableEventEmitter;
}

/**
 * Represents a connection to an Quereus database (in-memory in this port).
 * Manages schema, prepared statements, virtual tables, and functions.
 */
export class Database implements TransactionManagerContext, AssertionEvaluatorContext {
	public readonly schemaManager: SchemaManager;
	public readonly declaredSchemaManager: DeclaredSchemaManager;
	private isOpen = true;
	private statements = new Set<Statement>();
	private activeConnections = new Map<string, VirtualTableConnection>();
	public readonly optimizer: Optimizer;
	public readonly options: DatabaseOptionsManager;
	private instructionTracer: InstructionTracer | undefined;
	/** Deferred constraint evaluation queue */
	private readonly deferredConstraints = new DeferredConstraintQueue(this);
	/**
	 * Mutex for serializing statement execution.
	 * This prevents concurrent statements from interfering with each other's
	 * transaction state, matching SQLite's behavior of serializing writes.
	 */
	private execMutex: Promise<void> = Promise.resolve();
	/** Database-level event emitter for unified reactivity */
	private readonly eventEmitter = new DatabaseEventEmitter();
	/** Transaction management */
	private readonly transactionManager: TransactionManager;
	/** Assertion evaluation */
	private readonly assertionEvaluator: AssertionEvaluator;
	/** Per-database collation registry — comparator + optional key normalizer.
	 *  The normalizer is required for index participation; comparator-only
	 *  collations may still be used in ORDER BY but cannot back a compound index. */
	private readonly collations = new Map<string, { comparator: CollationFunction; normalizer?: (s: string) => string }>();

	constructor() {
		this.schemaManager = new SchemaManager(this);
		this.declaredSchemaManager = new DeclaredSchemaManager();
		this.options = new DatabaseOptionsManager();
		log("Database instance created.");

		// Register built-in functions
		this.registerBuiltinFunctions();

		this.schemaManager.registerModule('memory', new MemoryTableModule());

		// Register built-in collations
		this.registerDefaultCollations();

		// Register built-in window functions
		registerBuiltinWindowFunctions();

		registerEmitters();

		// Initialize optimizer with default tuning
		this.optimizer = new Optimizer(DEFAULT_TUNING);

		// Initialize transaction manager and assertion evaluator
		this.transactionManager = new TransactionManager(this);
		this.assertionEvaluator = new AssertionEvaluator(this);

		// Set up option change listeners
		this.setupOptionListeners();
	}

	// ============================================================================
	// TransactionManagerContext Implementation
	// ============================================================================

	/** @internal */
	getEventEmitter(): DatabaseEventEmitter {
		return this.eventEmitter;
	}

	/** @internal */
	getDeferredConstraints(): DeferredConstraintQueue {
		return this.deferredConstraints;
	}

	// ============================================================================
	// AssertionEvaluatorContext Implementation
	// ============================================================================

	/** Get the set of changed base tables */
	getChangedBaseTables(): Set<string> {
		return this.transactionManager.getChangedBaseTables();
	}

	/** Get changed PK tuples for a specific base table */
	getChangedKeyTuples(base: string): SqlValue[][] {
		return this.transactionManager.getChangedKeyTuples(base);
	}

	/** @internal Set up listeners for option changes */
	private setupOptionListeners(): void {
		// Register core database options with their change handlers
		this.options.registerOption('runtime_stats', {
			type: 'boolean',
			defaultValue: false,
			aliases: ['runtime_metrics'],
			description: 'Enable runtime execution statistics collection'
			// No onChange needed - consumed directly when creating RuntimeContext
		});

		this.options.registerOption('validate_plan', {
			type: 'boolean',
			defaultValue: false,
			aliases: ['plan_validation'],
			description: 'Enable plan validation before execution',
			onChange: (event) => {
				const newTuning = {
					...this.optimizer.tuning,
					debug: {
						...this.optimizer.tuning.debug,
						validatePlan: event.newValue as boolean
					}
				};
				this.updateOptimizerTuning(newTuning as OptimizerTuning);
				log('Optimizer tuning updated with validate_plan = %s', event.newValue);
			}
		});

		this.options.registerOption('default_vtab_module', {
			type: 'string',
			defaultValue: 'memory',
			description: 'Default virtual table module name',
			onChange: (event) => {
				this.schemaManager.setDefaultVTabModuleName(event.newValue as string);
			}
		});

		this.options.registerOption('default_vtab_args', {
			type: 'object',
			defaultValue: {},
			description: 'Default virtual table module arguments',
			onChange: (event) => {
				this.schemaManager.setDefaultVTabArgs(event.newValue as Record<string, SqlValue>);
			}
		});

		this.options.registerOption('default_column_nullability', {
			type: 'string',
			defaultValue: 'not_null',
			aliases: ['column_nullability_default', 'nullable_default'],
			description: 'Default nullability for columns: "nullable" (SQL standard) or "not_null" (Third Manifesto)',
			onChange: (event) => {
				const value = event.newValue as string;
				if (value !== 'nullable' && value !== 'not_null') {
					throw new QuereusError(`Invalid default_column_nullability value: ${value}. Must be "nullable" or "not_null"`, StatusCode.ERROR);
				}
				log('Default column nullability changed to: %s', value);
			}
		});

		this.options.registerOption('schema_path', {
			type: 'string',
			defaultValue: 'main',
			aliases: ['search_path'],
			description: 'Comma-separated list of schemas to search for unqualified table names',
			onChange: (event) => {
				const value = event.newValue as string;
				log('Schema search path changed to: %s', value);
			}
		});

		this.options.registerOption('trace_plan_stack', {
			type: 'boolean',
			defaultValue: false,
			description: 'Enable plan stack tracing',
		});

		this.options.registerOption('foreign_keys', {
			type: 'boolean',
			defaultValue: true,
			aliases: ['fk_enforcement'],
			description: 'Enable foreign key constraint enforcement. FKs default to ON DELETE IGNORE ON UPDATE IGNORE, so explicit action clauses are required for enforcement.',
		});
	}

	/** @internal Registers default built-in SQL functions */
	private registerBuiltinFunctions(): void {
		const mainSchema = this.schemaManager.getMainSchema();
		BUILTIN_FUNCTIONS.forEach(funcDef => {
			try {
				mainSchema.addFunction(funcDef);
			} catch (e) {
				errorLog(`Failed to register built-in function ${funcDef.name}/${funcDef.numArgs}: %O`, e);
			}
		});
		log(`Registered ${BUILTIN_FUNCTIONS.length} built-in functions.`);
	}

	/** @internal Registers default collation sequences */
	private registerDefaultCollations(): void {
		// Register the built-in collations into per-instance registry, paired
		// with their key normalizers so they can back compound indexes.
		this.collations.set('BINARY', { comparator: BINARY_COLLATION, normalizer: BUILTIN_NORMALIZERS.BINARY });
		this.collations.set('NOCASE', { comparator: NOCASE_COLLATION, normalizer: BUILTIN_NORMALIZERS.NOCASE });
		this.collations.set('RTRIM',  { comparator: RTRIM_COLLATION,  normalizer: BUILTIN_NORMALIZERS.RTRIM  });
		log("Default collations registered (BINARY, NOCASE, RTRIM)");
	}

	/**
	 * Prepares an SQL statement for execution.
	 *
	 * @param sql The SQL string to prepare.
	 * @param paramsOrTypes Optional parameter values (to infer types) or explicit type map.
	 *   - If SqlParameters: Parameter types are inferred from the values
	 *   - If Map<string|number, ScalarType>: Explicit type hints for parameters
	 *   - If undefined: Parameters default to TEXT type
	 * @returns A Statement object.
	 * @throws QuereusError on failure (e.g., syntax error).
	 *
	 * @example
	 * // Infer types from initial values
	 * const stmt = db.prepare('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice']);
	 *
	 * @example
	 * // Explicit param types
	 * const types = new Map([
	 *   [1, { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false }],
	 *   [2, { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false }]
	 * ]);
	 * const stmt = db.prepare('INSERT INTO users (id, name) VALUES (?, ?)', types);
	 */
	prepare(sql: string, paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>): Statement {
		this.checkOpen();
		log('Preparing SQL (new runtime): %s', sql);

		// Statement constructor defers planning/compilation until first step or explicit compile()
		const stmt = new Statement(this, sql, 0, paramsOrTypes);

		this.statements.add(stmt);
		return stmt;
	}

	/**
	 * Executes a query and returns the first result row as an object.
	 * The execution is serialized through the mutex and wrapped in an implicit
	 * transaction when in autocommit mode.
	 *
	 * @param sql The SQL query string to execute.
	 * @param params Optional parameters to bind.
	 * @returns A Promise resolving to the first result row as an object, or undefined if no rows.
	 * @throws QuereusError on failure.
	 */
	async get(sql: string, params?: SqlParameters | SqlValue[]): Promise<Record<string, SqlValue> | undefined> {
		this.checkOpen();
		const stmt = this.prepare(sql, params);
		try {
			return await stmt.get(params);
		} finally {
			await stmt.finalize();
		}
	}

	// ============================================================================
	// Statement Execution - Core Infrastructure
	// ============================================================================

	/**
	 * Acquires the execution mutex and returns a release function.
	 * All statement execution is serialized through this mutex to prevent
	 * concurrent transactions from interfering with each other.
	 * This matches SQLite's behavior of serializing database access.
	 * @internal
	 */
	async _acquireExecMutex(): Promise<() => void> {
		const previousMutex = this.execMutex;
		let releaseMutex: () => void;
		this.execMutex = new Promise<void>(resolve => {
			releaseMutex = resolve;
		});
		await previousMutex;
		return releaseMutex!;
	}

	/**
	 * Executes a function with the execution mutex held.
	 * The mutex serializes all database access to prevent concurrent interference.
	 * @internal
	 */
	private async _withMutex<T>(executor: () => Promise<T>): Promise<T> {
		const releaseMutex = await this._acquireExecMutex();
		try {
			return await executor();
		} finally {
			releaseMutex();
		}
	}

	// ============================================================================
	// Transaction Control - Delegated to TransactionManager
	// ============================================================================

	/**
	 * Begins a transaction on all active connections.
	 * @internal
	 */
	async _beginTransaction(source: 'explicit' | 'implicit'): Promise<void> {
		await this.transactionManager.beginTransaction(source);
	}

	/**
	 * Commits the current transaction on all connections.
	 * @internal
	 */
	async _commitTransaction(): Promise<void> {
		await this.transactionManager.commitTransaction();
	}

	/**
	 * Rolls back the current transaction on all connections.
	 * @internal
	 */
	async _rollbackTransaction(): Promise<void> {
		await this.transactionManager.rollbackTransaction();
	}

	/**
	 * Ensures we're in a transaction. If in autocommit mode, starts an implicit transaction.
	 * @internal
	 */
	async _ensureTransaction(): Promise<void> {
		await this.transactionManager.ensureTransaction();
	}

	/**
	 * Commits if we're in an implicit transaction.
	 * @internal
	 */
	async _autocommitIfNeeded(): Promise<void> {
		await this.transactionManager.autocommitIfNeeded();
	}

	/**
	 * Rolls back if we're in an implicit transaction (on error).
	 * @internal
	 */
	async _autorollbackIfNeeded(): Promise<void> {
		await this.transactionManager.autorollbackIfNeeded();
	}

	/**
	 * Checks if we're currently in an implicit transaction.
	 * @internal
	 */
	_isImplicitTransaction(): boolean {
		return this.transactionManager.isImplicitTransaction();
	}

	/**
	 * Commits or rolls back an implicit transaction based on success.
	 * No-op if no implicit transaction is active.
	 * @internal
	 */
	async _finalizeImplicitTransaction(success: boolean): Promise<void> {
		if (this.transactionManager.isImplicitTransaction()) {
			if (success) {
				await this._commitTransaction();
			} else {
				await this._rollbackTransaction();
			}
		}
	}

	/**
	 * Upgrades an implicit transaction to explicit.
	 * @internal
	 */
	_upgradeToExplicitTransaction(): void {
		this.transactionManager.upgradeToExplicitTransaction();
	}

	/**
	 * @internal
	 * Executes a single AST statement. Does not manage mutex or transactions.
	 * Used as the innermost execution primitive.
	 */
	private async _executeSingleStatement(statementAst: AST.Statement, params?: SqlParameters | SqlValue[]): Promise<void> {
		const { plan } = this._buildPlan([statementAst], params);

		if (plan.statements.length === 0) return; // No-op for this AST

		const optimizedPlan = this.optimizer.optimize(plan, this) as BlockNode;
		const emissionContext = new EmissionContext(this);
		const rootInstruction = emitPlanNode(optimizedPlan, emissionContext);
		const scheduler = new Scheduler(rootInstruction);

		// Normalize array params to a record keyed by 1-based index, matching Statement.bindAll
		let boundArgs: Record<number | string, SqlValue> = {};
		if (Array.isArray(params)) {
			params.forEach((value, index) => { boundArgs[index + 1] = value; });
		} else if (params) {
			boundArgs = { ...params };
		}

		const runtimeCtx: RuntimeContext = {
			db: this,
			stmt: undefined,
			params: boundArgs,
			context: new RowContextMap(),
			tableContexts: new Map(),
			tracer: this.instructionTracer,
			enableMetrics: this.options.getBooleanOption('runtime_stats'),
		};

		await scheduler.run(runtimeCtx);
	}

	/**
	 * @internal
	 * Executes a batch of AST statements sequentially.
	 * Does not manage mutex or transactions - caller must handle that.
	 */
	private async _executeStatementBatch(batch: AST.Statement[], params?: SqlParameters | SqlValue[]): Promise<void> {
		for (const statementAst of batch) {
			await this._executeSingleStatement(statementAst, params);
		}
	}

	/**
	 * Parses SQL into a statement batch.
	 */
	private _parseSql(sql: string): AST.Statement[] {
		return new Parser().parseAll(sql);
	}

	// ============================================================================
	// Statement Execution - Public API
	// ============================================================================

	/**
	 * Executes one or more SQL statements directly.
	 * Statements are serialized through the execution mutex. Transactions are started
	 * lazily (just-in-time) when the first DML or DDL operation occurs. If an implicit
	 * transaction was started during execution, it is committed on success or rolled
	 * back on error.
	 *
	 * @param sql The SQL string(s) to execute.
	 * @param params Optional parameters to bind.
	 * @returns A Promise resolving when execution completes.
	 * @throws QuereusError on failure.
	 */
	async exec(sql: string, params?: SqlParameters): Promise<void> {
		this.checkOpen();
		log('Executing SQL block: %s', sql);

		const batch = this._parseSql(sql);
		if (batch.length === 0) return;

		await this._withMutex(async () => {
			try {
				// Execute statements - transactions are started JIT by runtime when needed
				await this._executeStatementBatch(batch, params);

				// Commit if an implicit transaction was started during execution
				if (this.transactionManager.isImplicitTransaction()) {
					await this._commitTransaction();
				}
			} catch (err) {
				// Rollback if an implicit transaction was started during execution
				if (this.transactionManager.isImplicitTransaction()) {
					await this._rollbackTransaction();
				}
				throw err;
			}
		});
	}

	/**
	 * Execute SQL without acquiring the mutex.
	 * Used by runtime code (e.g., APPLY SCHEMA) that needs to execute
	 * nested SQL statements while already holding the mutex.
	 * @internal
	 */
	async _execWithinTransaction(sql: string, params?: SqlParameters): Promise<void> {
		log('Executing nested SQL: %s', sql);

		const batch = this._parseSql(sql);
		if (batch.length === 0) return;

		// No mutex, no implicit transaction management - we're already inside a transaction
		await this._executeStatementBatch(batch, params);
	}

	/**
	 * Execute a function with mutex held.
	 * Transaction management is handled by the executor if needed.
	 * @internal
	 */
	async _runWithMutex<T>(executor: () => Promise<T>): Promise<T> {
		return this._withMutex(executor);
	}

	/**
	 * Registers a virtual table module.
	 * @param name The name of the module.
	 * @param module The module implementation.
	 * @param auxData Optional client data passed to create/connect.
	 */
	registerModule(name: string, module: AnyVirtualTableModule, auxData?: unknown): void {
		this.checkOpen();
		if (typeof name !== 'string' || !name) {
			throw new MisuseError('registerModule: name must be a non-empty string');
		}
		if (!module || typeof module !== 'object') {
			throw new MisuseError('registerModule: module must be an object');
		}
		if (typeof module.create !== 'function') {
			throw new MisuseError('registerModule: module.create must be a function');
		}
		if (typeof module.connect !== 'function') {
			throw new MisuseError('registerModule: module.connect must be a function');
		}
		if (typeof module.destroy !== 'function') {
			throw new MisuseError('registerModule: module.destroy must be a function');
		}
		this.schemaManager.registerModule(name, module, auxData);

		// Check if the module has a getEventEmitter method and hook it up
		this.hookModuleEvents(name, module);
	}

	/**
	 * Hook a module's event emitter to forward events to the database level.
	 * @internal
	 */
	private hookModuleEvents(name: string, module: AnyVirtualTableModule): void {
		const emitter = tryGetEventEmitter(module);
		if (emitter) {
			this.eventEmitter.hookModuleEmitter(name, emitter);
			log('Hooked event emitter for module: %s', name);
		}
	}

	// ============================================================================
	// Database-Level Events
	// ============================================================================

	/**
	 * Subscribe to data change events from all modules.
	 *
	 * Events are emitted after successful transaction commit. During a transaction,
	 * events are batched and only delivered once the transaction commits successfully.
	 * On rollback, batched events are discarded.
	 *
	 * @param listener Callback invoked for each data change event
	 * @param options Optional subscription options (reserved for future filtering)
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = db.onDataChange((event) => {
	 *   console.log(`${event.type} on ${event.tableName} (module: ${event.moduleName})`);
	 *   if (event.remote) {
	 *     console.log('Change came from remote source');
	 *   }
	 * });
	 *
	 * // Later, when no longer needed:
	 * unsubscribe();
	 * ```
	 */
	onDataChange(
		listener: (event: DatabaseDataChangeEvent) => void,
		options?: DataChangeSubscriptionOptions
	): () => void {
		this.checkOpen();
		return this.eventEmitter.onDataChange(listener, options);
	}

	/**
	 * Subscribe to schema change events from all modules.
	 *
	 * Schema events are emitted when tables, indexes, or columns are created,
	 * altered, or dropped. Events are delivered after the DDL operation completes.
	 *
	 * @param listener Callback invoked for each schema change event
	 * @param options Optional subscription options (reserved for future filtering)
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = db.onSchemaChange((event) => {
	 *   console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
	 *   if (event.ddl) {
	 *     console.log('DDL:', event.ddl);
	 *   }
	 * });
	 * ```
	 */
	onSchemaChange(
		listener: (event: DatabaseSchemaChangeEvent) => void,
		options?: SchemaChangeSubscriptionOptions
	): () => void {
		this.checkOpen();
		return this.eventEmitter.onSchemaChange(listener, options);
	}

	/**
	 * Check if there are any data change listeners registered.
	 */
	hasDataListeners(): boolean {
		return this.eventEmitter.hasDataListeners();
	}

	/**
	 * Check if there are any schema change listeners registered.
	 */
	hasSchemaListeners(): boolean {
		return this.eventEmitter.hasSchemaListeners();
	}

	/**
	 * Get the internal event emitter for advanced use cases.
	 * @internal
	 */
	_getEventEmitter(): DatabaseEventEmitter {
		return this.eventEmitter;
	}

	/**
	 * Begins a transaction.
	 */
	async beginTransaction(): Promise<void> {
		this.checkOpen();

		if (this.transactionManager.isInTransaction()) {
			throw new QuereusError("Transaction already active", StatusCode.ERROR);
		}

		await this.exec("BEGIN TRANSACTION");
	}

	/**
	 * Commits the current transaction.
	 */
	async commit(): Promise<void> {
		this.checkOpen();

		if (!this.transactionManager.isInTransaction()) {
			throw new QuereusError("No transaction active", StatusCode.ERROR);
		}

		await this.exec("COMMIT");
	}

	/**
	 * Rolls back the current transaction.
	 */
	async rollback(): Promise<void> {
		this.checkOpen();

		if (!this.transactionManager.isInTransaction()) {
			throw new QuereusError("No transaction active", StatusCode.ERROR);
		}

		await this.exec("ROLLBACK");
	}

	/**
	 * Closes the database connection and releases resources.
	 * @returns A promise resolving on completion.
	 */
	async close(): Promise<void> {
		if (!this.isOpen) {
			return;
		}

		log("Closing database...");
		this.isOpen = false;

		// Disconnect all active connections first
		await this.disconnectAllConnections();

		// Finalize all prepared statements
		const finalizePromises = Array.from(this.statements).map(stmt => stmt.finalize());
		await Promise.allSettled(finalizePromises); // Wait even if some fail
		this.statements.clear();

		// Clean up assertion evaluator (unsubscribe schema change listener, clear plan cache)
		this.assertionEvaluator.dispose();

		// Clear schemas, ensuring VTabs are potentially disconnected
		// This will also call destroy on VTabs via SchemaManager.clearAll -> schema.clearTables -> schemaManager.dropTable
		this.schemaManager.clearAll();

		// Clean up event emitter
		this.eventEmitter.removeAllListeners();

		log("Database closed.");
	}

	/** @internal Called by Statement when it's finalized */
	_statementFinalized(stmt: Statement): void {
		this.statements.delete(stmt);
	}

	/**
	 * Checks if the database connection is in autocommit mode.
	 */
	getAutocommit(): boolean {
		this.checkOpen();
		return this.transactionManager.getAutocommit();
	}

	/**
	 * Programmatically defines or replaces a table in the 'main' schema.
	 * This is an alternative/supplement to using `CREATE TABLE`.
	 * @param definition The schema definition for the table.
	 */
	defineTable(definition: TableSchema): void {
		this.checkOpen();
		if (definition.schemaName !== 'main') {
			throw new MisuseError("Programmatic definition only supported for 'main' schema currently");
		}

		this.schemaManager.getMainSchema().addTable(definition);
	}

	/** Wraps function registration with consistent error logging and re-throw. */
	private registerFunctionWithErrorHandling(
		funcType: string,
		funcName: string,
		numArgs: number,
		register: () => void
	): void {
		try {
			register();
		} catch (e) {
			errorLog(`Failed to register ${funcType} function ${funcName}/${numArgs}: %O`, e);
			if (e instanceof QuereusError) throw e;
			throw new QuereusError(
				`Failed to register ${funcType} function ${funcName}/${numArgs}: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.ERROR,
				e instanceof Error ? e : undefined
			);
		}
	}

	/**
	 * Registers a user-defined scalar function.
	 *
	 * @param name The name of the SQL function.
	 * @param options Configuration: { numArgs: number, deterministic?: boolean, flags?: number }.
	 * @param func The JavaScript function implementation.
	 */
	createScalarFunction(
		name: string,
		options: {
			numArgs: number;
			deterministic?: boolean;
			flags?: number;
		},
		func: (...args: SqlValue[]) => SqlValue
	): void {
		this.checkOpen();

		const baseFlags = (options.deterministic ? FunctionFlags.DETERMINISTIC : 0) | FunctionFlags.UTF8;
		const flags = options.flags ?? baseFlags;

		const schema = createScalarFunction(
			{ name, numArgs: options.numArgs, flags },
			func
		);

		this.registerFunctionWithErrorHandling('scalar', name, options.numArgs, () => {
			this.schemaManager.getMainSchema().addFunction(schema);
		});
	}

	/**
	 * Registers a user-defined aggregate function.
	 *
	 * @param name The name of the SQL function.
	 * @param options Configuration: { numArgs: number, flags?: number, initialState?: unknown }.
	 * @param stepFunc The function called for each row (accumulator, ...args) => newAccumulator.
	 * @param finalFunc The function called at the end (accumulator) => finalResult.
	 */
	createAggregateFunction(
		name: string,
		options: {
			numArgs: number;
			flags?: number;
			initialState?: unknown;
		},
		stepFunc: (acc: unknown, ...args: SqlValue[]) => unknown,
		finalFunc: (acc: unknown) => SqlValue
	): void {
		this.checkOpen();

		const flags = options.flags ?? FunctionFlags.UTF8;

		const schema = createAggregateFunction(
			{ name, numArgs: options.numArgs, flags, initialValue: options.initialState },
			stepFunc,
			finalFunc
		);

		this.registerFunctionWithErrorHandling('aggregate', name, options.numArgs, () => {
			this.schemaManager.getMainSchema().addFunction(schema);
		});
	}

	/**
	 * Registers a function using a pre-defined FunctionSchema.
	 * This is the lower-level registration method.
	 *
	 * @param schema The FunctionSchema object describing the function.
	 */
	registerFunction(schema: FunctionSchema): void {
		this.checkOpen();
		if (!schema || typeof schema !== 'object') {
			throw new MisuseError('registerFunction: schema must be an object');
		}
		if (typeof schema.name !== 'string' || !schema.name) {
			throw new MisuseError('registerFunction: schema.name must be a non-empty string');
		}
		if (!Number.isInteger(schema.numArgs) || schema.numArgs < -1) {
			throw new MisuseError('registerFunction: schema.numArgs must be an integer >= -1');
		}
		// Validate that appropriate implementation functions exist
		if ('stepFunction' in schema) {
			if (typeof schema.stepFunction !== 'function') {
				throw new MisuseError('registerFunction: aggregate schema.stepFunction must be a function');
			}
			if (typeof (schema as any).finalizeFunction !== 'function') {
				throw new MisuseError('registerFunction: aggregate schema.finalizeFunction must be a function');
			}
		} else if ('implementation' in schema) {
			if (typeof schema.implementation !== 'function') {
				throw new MisuseError('registerFunction: schema.implementation must be a function');
			}
		} else {
			throw new MisuseError('registerFunction: schema must have implementation (scalar/TVF) or stepFunction+finalizeFunction (aggregate)');
		}
		this.registerFunctionWithErrorHandling('user', schema.name, schema.numArgs, () => {
			this.schemaManager.getMainSchema().addFunction(schema);
		});
	}

	/** Sets only the name of the default module. */
	setDefaultVtabName(name: string): void {
		this.checkOpen();
		this.schemaManager.setDefaultVTabModuleName(name);
	}

	/** Sets the default args directly. */
	setDefaultVtabArgs(args: Record<string, SqlValue>): void {
		this.checkOpen();
		this.schemaManager.setDefaultVTabArgs(args);
	}

	/** @internal Sets the default args by parsing a JSON string. Should be managed by SchemaManager now. */
	setDefaultVtabArgsFromJson(argsJsonString: string): void {
		this.checkOpen();
		this.schemaManager.setDefaultVTabArgsFromJson(argsJsonString);
	}

	/**
	 * Gets the default virtual table module name and arguments.
	 * @returns An object containing the module name and arguments.
	 */
	getDefaultVtabModule(): { name: string; args: Record<string, SqlValue> } {
		this.checkOpen();
		return this.schemaManager.getDefaultVTabModule();
	}

	/**
	 * Sets the default schema search path for resolving unqualified table names.
	 * This is a convenience method equivalent to setting the 'schema_path' option.
	 *
	 * @param paths Array of schema names to search in order
	 *
	 * @example
	 * ```typescript
	 * db.setSchemaPath(['main', 'extensions', 'plugins']);
	 * // Now unqualified tables search: main → extensions → plugins
	 * ```
	 */
	setSchemaPath(paths: string[]): void {
		this.checkOpen();
		const pathString = paths.join(',');
		this.options.setOption('schema_path', pathString);
	}

	/**
	 * Gets the current schema search path.
	 *
	 * @returns Array of schema names in search order
	 *
	 * @example
	 * ```typescript
	 * const path = db.getSchemaPath();
	 * console.log(path); // ['main', 'extensions', 'plugins']
	 * ```
	 */
	getSchemaPath(): string[] {
		this.checkOpen();
		return parseSchemaPath(this.options.getStringOption('schema_path')) ?? [];
	}

	/**
	 * Set database configuration options
	 * @param option The option name
	 * @param value The option value
	 */
	setOption(option: string, value: unknown): void {
		this.checkOpen();
		this.options.setOption(option, value);
	}

	/**
	 * Get database configuration option value
	 * @param option The option name
	 * @returns The option value
	 */
	getOption(option: string): unknown {
		this.checkOpen();
		return this.options.getOption(option);
	}

	/** Update optimizer tuning in place */
	private updateOptimizerTuning(tuning: OptimizerTuning): void {
		this.optimizer.updateTuning(tuning);
	}

	/**
	 * Registers a user-defined collation sequence.
	 * @param name The name of the collation sequence (case-insensitive).
	 * @param func The comparison function (a, b) => number (-1, 0, 1).
	 * @param normalizer Optional key normalizer — a function whose output equality
	 *   partitions strings into the same equivalence classes as `func` (modulo
	 *   total ordering). Required to make this collation usable as the key for a
	 *   compound index; ORDER BY / standalone comparisons work without it.
	 * @example
	 * // Example: Create a custom collation for phone numbers
	 * db.registerCollation('PHONENUMBER', (a, b) => {
	 *   const normalize = (phone) => phone.replace(/\D/g, '');
	 *   const numA = normalize(a);
	 *   const numB = normalize(b);
	 *   return numA < numB ? -1 : numA > numB ? 1 : 0;
	 * }, (s) => s.replace(/\D/g, ''));
	 *
	 * // Then use it in SQL:
	 * // SELECT * FROM contacts ORDER BY phone COLLATE PHONENUMBER;
	 * // CREATE INDEX phone_idx ON contacts(phone COLLATE PHONENUMBER);
	 */
	registerCollation(name: string, func: CollationFunction, normalizer?: (s: string) => string): void {
		this.checkOpen();
		if (typeof name !== 'string' || !name) {
			throw new MisuseError('registerCollation: name must be a non-empty string');
		}
		if (typeof func !== 'function') {
			throw new MisuseError('registerCollation: func must be a function');
		}
		if (normalizer !== undefined && typeof normalizer !== 'function') {
			throw new MisuseError('registerCollation: normalizer must be a function when supplied');
		}
		const upperName = name.toUpperCase();
		if (this.collations.has(upperName)) {
			log('Overwriting existing collation: %s', upperName);
		}
		this.collations.set(upperName, normalizer !== undefined
			? { comparator: func, normalizer }
			: { comparator: func });
		log('Registered collation: %s%s', upperName, normalizer !== undefined ? ' (with normalizer)' : '');
	}

	/**
	 * Registers a custom logical type.
	 * @param name The name of the type (case-insensitive).
	 * @param definition The LogicalType implementation.
	 * @example
	 * // Example: Create a custom UUID type
	 * db.registerType('UUID', {
	 *   name: 'UUID',
	 *   physicalType: PhysicalType.TEXT,
	 *   validate: (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
	 *   parse: (v) => typeof v === 'string' ? v.toLowerCase() : v,
	 * });
	 *
	 * // Then use it in SQL:
	 * // CREATE TABLE users (id UUID PRIMARY KEY, name TEXT);
	 */
	registerType(name: string, definition: LogicalType): void {
		this.checkOpen();
		if (typeof name !== 'string' || !name) {
			throw new MisuseError('registerType: name must be a non-empty string');
		}
		if (!definition || typeof definition !== 'object') {
			throw new MisuseError('registerType: definition must be an object');
		}
		if (typeof definition.name !== 'string' || !definition.name) {
			throw new MisuseError('registerType: definition.name must be a non-empty string');
		}
		// Validate physicalType is a valid enum value (0-5)
		if (typeof definition.physicalType !== 'number' || !Number.isInteger(definition.physicalType) || definition.physicalType < 0 || definition.physicalType > 5) {
			throw new MisuseError('registerType: definition.physicalType must be a valid PhysicalType enum value (0-5)');
		}
		if (definition.name.toLowerCase() !== name.toLowerCase()) {
			throw new QuereusError(
				`Type name mismatch: registerType('${name}', ...) does not match definition.name '${definition.name}'`,
				StatusCode.ERROR
			);
		}
		try {
			registerTypeInRegistry(definition);
		} catch (e) {
			errorLog('Failed to register type %s: %O', name, e);
			if (e instanceof QuereusError) throw e;
			throw new QuereusError(
				`Failed to register type '${name}': ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.ERROR,
				e instanceof Error ? e : undefined
			);
		}
		log('Registered type: %s', name);
	}

	/**
	 * Sets the instruction tracer for this database.
	 * The tracer will be used for all statement executions.
	 * @param tracer The instruction tracer to use, or null to disable tracing.
	 */
	setInstructionTracer(tracer: InstructionTracer | undefined): void {
		this.instructionTracer = tracer;
		log('Instruction tracer %s', tracer ? 'enabled' : 'disabled');
	}

	/**
	 * Gets the current instruction tracer for this database.
	 * @returns The instruction tracer, or undefined if none is set.
	 */
	getInstructionTracer(): InstructionTracer | undefined {
		return this.instructionTracer;
	}

	/** @internal Gets a registered collation function */
	_getCollation(name: string): CollationFunction | undefined {
		return this.collations.get(name.toUpperCase())?.comparator;
	}

	/** @internal Gets the registered key normalizer for a collation, falling back
	 *  to the built-in normalizer for `BINARY` / `NOCASE` / `RTRIM` if the
	 *  collation has no explicit normalizer registered. Returns `undefined` for
	 *  comparator-only user-defined collations. */
	_getCollationNormalizer(name: string): ((s: string) => string) | undefined {
		const upper = name.toUpperCase();
		const entry = this.collations.get(upper);
		if (entry?.normalizer !== undefined) return entry.normalizer;
		// Built-in fallback: even an entry that lost its normalizer (shouldn't
		// happen for built-ins, but defends against external mutation) still
		// resolves to the canonical built-in normalizer.
		return BUILTIN_NORMALIZERS[upper];
	}

	public _queueDeferredConstraintRow(baseTable: string, constraintName: string, row: Row, descriptor: RowDescriptor, evaluator: (ctx: RuntimeContext) => OutputValue, connectionId?: string, contextRow?: Row, contextDescriptor?: RowDescriptor): void {
		this.deferredConstraints.enqueue(baseTable, constraintName, row, descriptor, evaluator, connectionId, contextRow, contextDescriptor);
	}

	public async runDeferredRowConstraints(): Promise<void> {
		await this.transactionManager.runDeferredRowConstraints();
	}

	/** @internal Check if we should skip auto-beginning transactions on newly registered connections */
	public _isEvaluatingDeferredConstraints(): boolean {
		return this.transactionManager.isEvaluatingDeferredConstraints();
	}

	/** @internal Check if we're in a coordinated commit (allows sibling layer validation) */
	public _inCoordinatedCommit(): boolean {
		return this.transactionManager.isInCoordinatedCommit();
	}

	/** Public API used by DML emitters to record changes */
	public _recordInsert(baseTable: string, newKey: SqlValue[]): void {
		this.transactionManager.recordInsert(baseTable, newKey);
	}

	public _recordDelete(baseTable: string, oldKey: SqlValue[]): void {
		this.transactionManager.recordDelete(baseTable, oldKey);
	}

	public _recordUpdate(baseTable: string, oldKey: SqlValue[], newKey: SqlValue[]): void {
		this.transactionManager.recordUpdate(baseTable, oldKey, newKey);
	}

	/** Create a named savepoint, returning its depth index */
	public _createSavepoint(name: string): number {
		return this.transactionManager.createSavepoint(name);
	}

	/** Release a named savepoint (merges layers down to target), returns target depth */
	public _releaseSavepoint(name: string): number {
		return this.transactionManager.releaseSavepoint(name);
	}

	/** Rollback to a named savepoint (discards layers down to target) */
	public _rollbackToSavepoint(name: string): number {
		return this.transactionManager.rollbackToSavepoint(name);
	}

	public _clearChangeLog(): void {
		this.transactionManager.clearChangeLog();
	}

	/**
	 * Prepares, binds parameters, executes, and yields result rows for a query.
	 * This is a high-level convenience method for iterating over query results.
	 * The underlying statement is automatically finalized when iteration completes
	 * or if an error occurs.
	 *
	 * Transactions are started lazily (just-in-time) when the first DML or DDL
	 * operation occurs. The mutex is held for the entire iteration.
	 *
	 * @param sql The SQL query string to execute.
	 * @param params Optional parameters to bind (array for positional, object for named).
	 * @yields Each result row as an object (`Record<string, SqlValue>`).
	 * @returns An `AsyncIterableIterator` yielding result rows.
	 * @throws MisuseError if the database is closed.
	 * @throws QuereusError on prepare/bind/execution errors.
	 *
	 * @example
	 * ```typescript
	 * try {
	 *   for await (const user of db.eval("SELECT * FROM users WHERE status = ?", ["active"])) {
	 *     console.log(`Active user: ${user.name}`);
	 *   }
	 * } catch (e) {
	 *   console.error("Query failed:", e);
	 * }
	 * ```
	 */
	eval(sql: string, params?: SqlParameters | SqlValue[]): AsyncIterableIterator<Record<string, SqlValue>> {
		return wrapAsyncIterator(this._evalGenerator(sql, params), (commit) =>
			this._finalizeImplicitTransaction(commit)
		);
	}

	/**
	 * Internal generator for eval() that yields result rows.
	 * Transaction finalization is handled by the wrapper returned by eval().
	 * @internal
	 */
	private async *_evalGenerator(sql: string, params?: SqlParameters | SqlValue[]): AsyncGenerator<Record<string, SqlValue>> {
		this.checkOpen();

		const releaseMutex = await this._acquireExecMutex();
		let stmt: Statement | null = null;

		try {
			stmt = this.prepare(sql);

			if (stmt.astBatch.length === 0) {
				return;
			}

			if (stmt.astBatch.length > 1) {
				// Multi-statement batch: execute all but the last statement,
				// then yield results from the last statement
				for (let i = 0; i < stmt.astBatch.length - 1; i++) {
					await this._executeSingleStatement(stmt.astBatch[i], params);
				}

				const lastStmt = new Statement(this, [stmt.astBatch[stmt.astBatch.length - 1]]);
				this.statements.add(lastStmt);
				try {
					const names = lastStmt.getColumnNames();
					for await (const row of lastStmt._iterateRowsRaw(params)) {
						yield rowToObject(row, names);
					}
				} finally {
					await lastStmt.finalize();
				}
			} else {
				const names = stmt.getColumnNames();
				for await (const row of stmt._iterateRowsRaw(params)) {
					yield rowToObject(row, names);
				}
			}
		} finally {
			if (stmt) { await stmt.finalize(); }
			releaseMutex();
		}
	}

	getPlan(sqlOrAst: string | AST.AstNode): PlanNode {
		this.checkOpen();

		let ast: AST.AstNode;
		let originalSqlString: string | undefined = undefined;

		if (typeof sqlOrAst === 'string') {
			originalSqlString = sqlOrAst;
			const parser = new Parser();
			try {
				ast = parser.parse(originalSqlString);
			} catch (err) {
				const error = err instanceof QuereusError ? err : new QuereusError(String(err), StatusCode.ERROR, err instanceof Error ? err : undefined);
				errorLog("Failed to parse SQL for query plan: %O", error);
				throw error;
			}
		} else {
			ast = sqlOrAst;
		}

		const { plan } = this._buildPlan([ast as AST.Statement]);

		if (plan.statements.length === 0) return plan; // No-op for this AST

		return this.optimizer.optimize(plan, this) as BlockNode;
	}

	/**
	 * Gets a detailed representation of the query plan for debugging.
	 * @param sql The SQL statement to plan.
	 * @param options Optional formatting options. If not provided, uses concise tree format.
	 * @returns String containing the formatted plan tree.
	 */
	getDebugPlan(sql: string, options?: { verbose?: boolean; expandNodes?: string[]; maxDepth?: number }): string {
		this.checkOpen();
		const plan = this.getPlan(sql);

		if (options?.verbose) {
			// Use the original detailed JSON format
			return serializePlanTree(plan);
		} else {
			// Use the new concise tree format
			return formatPlanTree(plan, {
				concise: true,
				expandNodes: options?.expandNodes || [],
				maxDepth: options?.maxDepth,
				showPhysical: true
			});
		}
	}

	/**
	 * Prepares a statement with debug options enabled.
	 * @param sql The SQL statement to prepare.
	 * @param debug Debug options to enable.
	 * @returns A Statement with debug capabilities.
	 */
	prepareDebug(sql: string, debug: DebugOptions): Statement {
		this.checkOpen();
		log('Preparing SQL with debug options: %s', sql);

		const stmt = new Statement(this, sql);
		stmt._debugOptions = debug;

		this.statements.add(stmt);
		return stmt;
	}

	/** @internal */
	_getVtabModule(name: string): { module: AnyVirtualTableModule, auxData?: unknown } | undefined {
		// Delegate to SchemaManager
		return this.schemaManager.getModule(name);
		// return this.registeredVTabs.get(name.toLowerCase()); // Old implementation
	}

	/** @internal */
	_findTable(tableName: string, dbName?: string): TableSchema | undefined {
		return this.schemaManager.findTable(tableName, dbName);
	}

	/** @internal */
	_findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
		return this.schemaManager.findFunction(funcName, nArg);
	}

	/** @internal */
	_buildPlan(statements: AST.Statement[], paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>): BuildPlanResult {
		const globalScope = new GlobalScope(this.schemaManager);

		// If we received parameter values, infer their types
		// If we received explicit parameter types, use them as-is
		const parameterTypes = paramsOrTypes instanceof Map
			? paramsOrTypes
			: getParameterTypes(paramsOrTypes);

		// This ParameterScope is for the entire batch. It has globalScope as its parent.
		const parameterScope = new ParameterScope(globalScope, parameterTypes);

		// Get default schema path from options
		const schemaPath = parseSchemaPath(this.options.getStringOption('schema_path'));

		const schemaDependencies = new BuildTimeDependencyTracker();
		const ctx: PlanningContext = {
			db: this,
			schemaManager: this.schemaManager,
			parameters: paramsOrTypes instanceof Map ? {} : (paramsOrTypes ?? {}),
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies,
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map(),
			schemaPath
		};

		const plan = buildBlock(ctx, statements);
		return { plan, schemaDependencies };
	}

	/**
	 * @internal Registers an active VirtualTable connection for transaction management.
	 * @param connection The connection to register
	 */
	async registerConnection(connection: VirtualTableConnection): Promise<void> {
		this.activeConnections.set(connection.connectionId, connection);
		log(`Registered connection ${connection.connectionId} for table ${connection.tableName}`);

		// If we're already in a transaction (implicit or explicit),
		// start a transaction on this new connection UNLESS we're evaluating deferred constraints
		// (during which subqueries should read committed state without creating new transaction layers)
		if (this.transactionManager.isInTransaction() && !this.transactionManager.isEvaluatingDeferredConstraints()) {
			try {
				await connection.begin();
				log(`Started transaction on newly registered connection ${connection.connectionId}`);
			} catch (error) {
				errorLog(`Error starting transaction on newly registered connection ${connection.connectionId}: %O`, error);
				// Don't throw here - just log the error to avoid breaking connection registration
			}
		} else if (this.transactionManager.isEvaluatingDeferredConstraints()) {
			log(`Skipped transaction begin on connection ${connection.connectionId} (evaluating deferred constraints)`);
		}
	}

	/**
	 * @internal Unregisters an active VirtualTable connection.
	 * @param connectionId The ID of the connection to unregister
	 */
	unregisterConnection(connectionId: string): void {
		const connection = this.activeConnections.get(connectionId);
		if (connection) {
			// Don't disconnect during implicit transactions - let the transaction coordinate
			if (this.transactionManager.isImplicitTransaction()) {
				log(`Deferring disconnect of connection ${connectionId} until implicit transaction completes`);
				return;
			}

			this.activeConnections.delete(connectionId);
			log(`Unregistered connection ${connectionId} for table ${connection.tableName}`);
		}
	}

	/**
	 * @internal Gets an active connection by ID.
	 * @param connectionId The connection ID to look up
	 * @returns The connection if found, undefined otherwise
	 */
	getConnection(connectionId: string): VirtualTableConnection | undefined {
		return this.activeConnections.get(connectionId);
	}

	/**
	 * @internal Removes all active connections for a specific table.
	 * Unlike unregisterConnection, this bypasses the implicit transaction deferral
	 * because the table is being dropped and its connections are definitively stale.
	 */
	removeConnectionsForTable(schemaName: string, tableName: string): void {
		const qualifiedName = `${schemaName}.${tableName}`.toLowerCase();
		for (const [id, conn] of this.activeConnections) {
			if (conn.tableName.toLowerCase() === qualifiedName) {
				this.activeConnections.delete(id);
				log(`Removed stale connection ${id} for dropped table ${qualifiedName}`);
			}
		}
	}

	/**
	 * @internal Gets all active connections for a specific table.
	 * @param tableName The name of the table
	 * @returns Array of connections for the table
	 */
	getConnectionsForTable(tableName: string): VirtualTableConnection[] {
		const normalized = tableName.toLowerCase();
		const simpleName = normalized.includes('.') ? normalized.substring(normalized.lastIndexOf('.') + 1) : normalized;
		return Array.from(this.activeConnections.values())
			.filter(conn => {
				const connName = conn.tableName.toLowerCase();
				return connName === normalized || connName === simpleName;
			});
	}

	/**
	 * @internal Gets all active connections.
	 * @returns Array of all active connections
	 */
	getAllConnections(): VirtualTableConnection[] {
		return Array.from(this.activeConnections.values());
	}

	/**
	 * Disconnects and removes all active connections.
	 * Called during database close.
	 */
	private async disconnectAllConnections(): Promise<void> {
		const connections = Array.from(this.activeConnections.values());
		log(`Disconnecting ${connections.length} active connections`);

		const disconnectPromises = connections.map(async (conn) => {
			try {
				await conn.disconnect();
			} catch (error) {
				errorLog(`Error disconnecting connection ${conn.connectionId}: %O`, error);
			}
		});

		await Promise.allSettled(disconnectPromises);
		this.activeConnections.clear();
	}

	private checkOpen(): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");
	}

	public async runGlobalAssertions(): Promise<void> {
		await this.assertionEvaluator.runGlobalAssertions();
	}

	/** @internal Invalidate cached assertion plan (called on DROP ASSERTION) */
	public invalidateAssertionCache(name: string): void {
		this.assertionEvaluator.invalidateAssertion(name);
	}
}

