import type { Database } from '../core/database.js'; // Assuming Database class exists
import type { VirtualTable } from './table.js';

import type { ColumnDef, Expression, TableConstraint } from '../parser/ast.js'; // <-- Add parser AST import
import type { TableSchema, IndexSchema } from '../schema/table.js'; // Add import for TableSchema and IndexSchema
import type { BestAccessPlanRequest, BestAccessPlanResult } from './best-access-plan.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import type { ModuleCapabilities } from './capabilities.js';
import type { MappingAdvertisement } from './mapping-advertisement.js';
import type { BackingHost } from './backing-host.js';
import type { Schema } from '../schema/schema.js';
import type { LensDeploymentSnapshot } from '../schema/lens.js';
import type { Row, SqlValue } from '../common/types.js';

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
	 * Optional. Creates a materialized-view BACKING table, preferred by
	 * {@link SchemaManager.createBackingTable} over {@link create} when present
	 * (`createBacking?.() ?? create()`). Presence is the capability (mirrors
	 * {@link getBackingHost?}): a durable-backing module routes the backing into
	 * its durable store here instead of building an ordinary relational table, so
	 * the subsequent {@link getBackingHost} resolves a real host. Same
	 * signature/contract as {@link create}; omit ⇒ backings go through
	 * {@link create} (today's behavior).
	 */
	createBacking?(
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
	 * Checks for shadow table name conflicts.
	 *
	 * UNWIRED / DEAD: this hook is declared but is never called anywhere in the
	 * engine. Treat it as deprecated — do not build a contract around it expecting
	 * the engine to consult it. See docs/module-authoring.md § "Capability
	 * negotiation surface".
	 *
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
	 * Optional. Returns the logical→basis decompositions this module recognizes
	 * over the given basis schema (see {@link MappingAdvertisement}). A dedicated
	 * module (columnar/EAV/nd-tree) synthesizes them from its own knowledge; a
	 * generic module (memory/store) delegates to the shared tag builder
	 * (`buildAdvertisementsFromTags`) over its tables' reserved
	 * `quereus.lens.decomp.*` tags. Consulted by the lens compiler's resolver
	 * (`schema/lens-compiler.ts`). Omit ⇒ name-match only (today's behavior).
	 *
	 * The method is **module-level given the basis schema** (not per-table): a
	 * module spans many tables and a decomposition spans many relations, so it
	 * returns every decomposition it recognizes and the resolver indexes them.
	 * Presence of the method is the capability — no `ModuleCapabilities` flag.
	 */
	getMappingAdvertisements?(
		db: Database,
		basisSchema: Schema,
	): readonly MappingAdvertisement[];

	/**
	 * Optional. Returns the privileged backing-host surface for a table this
	 * module owns, or undefined when the table is unknown to it. Presence of
	 * the method is the capability (mirrors getMappingAdvertisements): a module
	 * implementing it may host materialized-view backing tables. See
	 * vtab/backing-host.ts for the semantic and cost contract.
	 */
	getBackingHost?(db: Database, schemaName: string, tableName: string): BackingHost | undefined;

	/**
	 * Optional. Materialize a durable backing for an ALREADY-EXISTING ordinary
	 * table that is being attached as maintained (`alter table … set maintained
	 * as <body>` / `create table … maintained`), BEFORE the attach reconcile
	 * resolves the table's backing host via {@link getBackingHost}. A module whose
	 * `getBackingHost` resolves over a SEPARATE durable store (not the live table's
	 * own storage) needs this seam because the engine's attach core only RESOLVES
	 * (never creates) the host on the non-reshape path, so the store must exist by
	 * the time `resolveBackingHost` runs.
	 *
	 * `backingSchema` is the (possibly reshaped) live schema the store must be
	 * sized to — call it AFTER the reshape `preReconcileOps` and `schema.addTable`.
	 * Idempotent: a re-attach over an already-maintained table reuses the existing
	 * store. No-op for modules whose `getBackingHost` already resolves over the
	 * live table (e.g. memory) — they omit the method entirely, so the optional
	 * call is a pure no-op. Omit ⇒ the engine resolves the host as-is (today's
	 * behavior).
	 */
	ensureBackingForAttach?(
		db: Database,
		schemaName: string,
		tableName: string,
		backingSchema: TableSchema,
	): Promise<void>;

	/**
	 * Optional. Retire the durable backing when a maintained table is detached
	 * (`alter table … drop maintained`), leaving the table ORDINARY and
	 * user-writable with its current (maintained) rows intact. The counterpart to
	 * {@link ensureBackingForAttach}: a module that migrated the table into a
	 * separate durable store on attach migrates the rows back into ordinary
	 * storage here and drops the store, so subsequent reads/writes route through
	 * the ordinary table surface.
	 *
	 * `plainSchema` is the detached (derivation-less) schema. No-op for modules
	 * with a single physical storage (e.g. memory) — they omit the method. Omit ⇒
	 * detach is catalog-only (today's behavior).
	 */
	retireBackingForAttach?(
		db: Database,
		schemaName: string,
		tableName: string,
		plainSchema: TableSchema,
	): Promise<void>;

	/**
	 * Alter an existing table's structure. Called by ALTER TABLE for
	 * data-affecting changes — every `SchemaChangeInfo` arm: ADD / DROP /
	 * RENAME COLUMN, ADD / DROP / RENAME CONSTRAINT, ALTER COLUMN, ALTER
	 * PRIMARY KEY. RENAME TABLE is schema-only and routes through `renameTable`,
	 * not this method. See docs/module-authoring.md § "Schema Changes
	 * (`SchemaChangeInfo`)" for the per-arm mandate each arm carries.
	 *
	 * Returns the updated TableSchema after the operation. The engine
	 * registers this in the schema catalog.
	 *
	 * If not implemented, the engine rejects data-affecting ALTER operations
	 * (`renameColumn` degrades to an engine-side schema-only rename instead).
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

	/**
	 * Optional. Fired exactly once per successful `apply schema X` of a
	 * **logical** schema, after the lens layer is fully deployed — every lens
	 * view + slot is registered and the deployment snapshot has been rotated into
	 * the `DeclaredSchemaManager`. Hands every registered module the
	 * {@link LensDeploymentSnapshot} that `deployLogicalSchema` just built for
	 * `logicalSchemaName` (read back from the manager's rotated `current`, never
	 * re-derived), so a module backing the basis can realise / reconcile its
	 * backing relations against the freshly deployed lens (e.g. the Lamina adapter's
	 * deploy → basis-reconcile path; see `docs/lens.md` § Module deployment
	 * notification).
	 *
	 * Firing contract:
	 * - **Once per successful apply.** Fires only when `deployLogicalSchema`
	 *   completed without throwing — the deploy is atomic, so a blocked deploy
	 *   (prover error, etc.) never reaches here. A **physical** `apply schema`
	 *   deploys no lens and never fires it.
	 * - **After deploy, not inside a migration batch.** The logical-apply path runs
	 *   no `beginSchemaBatch`/`endSchemaBatch` migration-DDL loop (that is the
	 *   basis / physical path); the notification fires once the lens catalog
	 *   mutation + snapshot rotation are complete — the logical-apply analogue of
	 *   "after `endSchemaBatch`".
	 * - **Snapshot scoped to the affected schema.** `snapshot` is the deployment of
	 *   `logicalSchemaName` only (its just-rotated `current`). An empty deploy —
	 *   every logical table removed from the declaration — still fires, carrying an
	 *   empty-`tables` snapshot, so a consumer can observe the detach.
	 * - **Every registered module is notified, in registration order.** A module
	 *   that backs none of the basis relations should no-op (mirrors the
	 *   `beginSchemaBatch` "owns no tables ⇒ no-op" contract).
	 * - **Errors propagate.** The lens is already deployed when this fires; a
	 *   notification that throws aborts `apply schema X` with that error so the
	 *   caller learns the module's reconcile failed. The deployed lens is **not**
	 *   rolled back — a subsequent re-apply re-fires the notification.
	 *
	 * May be sync or async; the engine awaits the result. Omit ⇒ the module is
	 * never consulted on deploy (today's behavior).
	 */
	notifyLensDeployment?(
		db: Database,
		logicalSchemaName: string,
		snapshot: LensDeploymentSnapshot,
	): void | Promise<void>;
}

/**
 * Defines the structure for schema change information passed to xAlterSchema
 */
export type SchemaChangeInfo =
	| {
		type: 'addColumn';
		columnDef: ColumnDef;
		/**
		 * Per-row backfill for a non-foldable DEFAULT (e.g. `new.<col>`): given an
		 * existing row, returns that row's value for the new column. Absent for a
		 * literal / NULL default (the module bulk-writes the folded value). The engine
		 * builds this from the column's DEFAULT evaluated against the existing row, so a
		 * module that appends the new column should call it per existing row instead of
		 * writing a single default value.
		 */
		backfillEvaluator?: (row: Row) => SqlValue | Promise<SqlValue>;
	}
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string; newColumnDefAst?: ColumnDef }
	| { type: 'alterPrimaryKey'; newPkColumns: ReadonlyArray<{ index: number; desc: boolean }> }
	| { type: 'addConstraint'; constraint: TableConstraint }
	| {
		/**
		 * DROP CONSTRAINT — remove a named table-level constraint by name. The module
		 * resolves the class (CHECK / UNIQUE / FOREIGN KEY), rewrites its schema, and
		 * returns the updated TableSchema. No row migration is needed (constraints
		 * don't change row shape), though dropping a UNIQUE may also tear down the
		 * secondary index backing it.
		 */
		type: 'dropConstraint';
		constraintName: string;
	}
	| {
		/**
		 * RENAME CONSTRAINT — change a named table-level constraint's name. The module
		 * resolves the class and rewrites its schema (and, for a UNIQUE backed by an
		 * implicit covering index named after the constraint, renames that index too).
		 */
		type: 'renameConstraint';
		oldName: string;
		newName: string;
	}
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
		 *   - setCollation: change the column's collation. A module that re-keys its
		 *     own structures (memory AND the store) must re-key / re-sort any PK / UNIQUE /
		 *     index that orders by the column and re-validate uniqueness under the new
		 *     collation (a set unique under BINARY may collide under NOCASE → throw
		 *     CONSTRAINT). The store keys each PK column under its own collation
		 *     (`StoreTable.pkKeyCollations`) and so physically re-keys the data store +
		 *     rebuilds dependent secondary indexes on a PK-column change, throwing
		 *     CONSTRAINT all-or-nothing on a collision. A module that *cannot* re-key
		 *     (e.g. it enforces the PK physically under a single fixed key collation it
		 *     can't change) may instead negotiate accept-when-consistent /
		 *     reject-when-divergent: apply schema-only when the target equals that fixed
		 *     collation, and throw UNSUPPORTED (sited) when it diverges — never silently
		 *     no-op. Unlike tags, collation is real schema.
		 */
		type: 'alterColumn';
		columnName: string;
		setNotNull?: boolean;
		setDataType?: string;
		setDefault?: Expression | null;
		setCollation?: string;
	};

/**
 * Type alias for the common usage pattern where specific table and config types are not known.
 * Use this for storage scenarios like the SchemaManager where modules of different types are stored together.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyVirtualTableModule = VirtualTableModule<any, any>;
