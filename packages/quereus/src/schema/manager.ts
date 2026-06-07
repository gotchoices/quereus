import { Schema, type SchemaKind } from './schema.js';
import { normalizeCollationName } from '../util/comparison.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import type { Database } from '../core/database.js';
import type { TableSchema, RowConstraintSchema, IndexSchema, IndexColumnSchema, MutationContextDefinition, ForeignKeyConstraintSchema, UniqueConstraintSchema } from './table.js';
import type { FunctionSchema } from './function.js';
import { quereusError, QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import type { AnyVirtualTableModule, BaseModuleConfig } from '../vtab/module.js';
import type { VirtualTable } from '../vtab/table.js';
import type { ColumnSchema } from './column.js';
import { buildColumnIndexMap, columnDefToSchema, findPKDefinition, opsToMask, mutationContextVarToSchema, extractGeneratedColumnDependencies, topoSortGeneratedColumns, requireVtabModule, resolveNamedConstraintClass, appendIndexToTableSchema } from './table.js';
import { buildUniqueConstraintSchema, buildForeignKeyConstraintSchema } from './constraint-builder.js';
import type { ViewSchema, MaterializedViewSchema } from './view.js';
import { backingTableNameFor } from './view.js';
import { isHiddenImplicitIndex, findExposedImplicitConstraintIndex } from './catalog.js';
import { createLogger } from '../common/logger.js';
import type * as AST from '../parser/ast.js';
import { Parser } from '../parser/parser.js';
import { traverseAst } from '../parser/visitor.js';
import { FunctionFlags } from '../common/constants.js';
import { SchemaChangeNotifier } from './change-events.js';
import { checkDeterministic } from '../planner/validation/determinism-validator.js';
import { buildExpression } from '../planner/building/expression.js';
import type { PlanningContext } from '../planner/planning-context.js';
import { BuildTimeDependencyTracker } from '../planner/planning-context.js';
import { GlobalScope } from '../planner/scopes/global.js';
import { ParameterScope } from '../planner/scopes/param.js';
import type { ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { hasNativeEventSupport } from '../util/event-support.js';
import type { VTableSchemaChangeEvent } from '../vtab/events.js';
import { quoteIdentifier } from '../emit/ast-stringify.js';

const log = createLogger('schema:manager');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

/**
 * Generic options passed to VTab modules during CREATE TABLE.
 * Modules are responsible for interpreting these.
 */
export interface GenericModuleCallOptions extends BaseModuleConfig {
	moduleArgs?: readonly string[];
	statementColumns?: readonly AST.ColumnDef[];
	statementConstraints?: readonly AST.TableConstraint[];
}

/**
 * A per-key tag mutation descriptor consumed by {@link SchemaManager.mutateTagRecord}:
 * `merge` overlays keys onto the current set, `drop` removes listed keys (atomically).
 */
type TagMutation =
	| { op: 'merge'; tags: Record<string, SqlValue> }
	| { op: 'drop'; keys: readonly string[] };

/**
 * Computes the next (frozen) tag record from the current one. Used to share the
 * per-site read-modify-write across the replace / merge / drop tag setters.
 */
type TagCompute = (current: Readonly<Record<string, SqlValue>> | undefined) => Readonly<Record<string, SqlValue>> | undefined;

/**
 * Manages all schemas associated with a database connection (main, temp, attached).
 * Handles lookup resolution according to SQLite's rules.
 */
export class SchemaManager {
	private schemas: Map<string, Schema> = new Map();
	private currentSchemaName: string = 'main';
	private modules: Map<string, { module: AnyVirtualTableModule, auxData?: unknown }> = new Map();
	private defaultVTabModuleName: string = 'memory';
	private defaultVTabModuleArgs: Record<string, SqlValue> = {};
	private db: Database;
	private changeNotifier = new SchemaChangeNotifier();
	/**
	 * Re-entrancy guard: when truthy, optimizer-side assertion hoisting is
	 * suppressed. Set by `AssertionEvaluator` while compiling an assertion's
	 * own violation query — without this guard, the hoist would make the
	 * violation query plan to empty (the optimizer would trust the assertion
	 * to prove its own non-violation), defeating commit-time enforcement.
	 * See `assertion-hoist-cache.ts` and `core/database-assertions.ts`.
	 */
	private assertionHoistSuppressed: number = 0;
	/**
	 * Re-entrancy guard: when truthy, the read-side materialized-view query-rewrite
	 * rule (`rule-materialized-view-rewrite.ts`) is suppressed. Set while planning a
	 * materialized view's own body for the purpose of (re)computing or maintaining
	 * its backing table (create / refresh / row-time-maintenance compile). Without
	 * it, the rewrite rule would recognize the MV's body as "answered from" the MV
	 * itself and rewrite it to scan the backing table being populated — reading a
	 * stale/empty snapshot instead of recomputing from the source.
	 */
	private mvRewriteSuppressed: number = 0;

	/**
	 * Creates a new schema manager
	 *
	 * @param db Reference to the parent Database instance
	 */
	constructor(db: Database) {
		this.db = db;
		// Ensure 'main' and 'temp' schemas always exist
		this.schemas.set('main', new Schema('main'));
		this.schemas.set('temp', new Schema('temp'));
	}

	/**
	 * Sets the current default schema for unqualified names
	 *
	 * @param name Schema name to set as current
	 */
	setCurrentSchema(name: string): void {
		if (this.schemas.has(name.toLowerCase())) {
			this.currentSchemaName = name.toLowerCase();
		} else {
			warnLog(`Attempted to set current schema to non-existent schema: %s`, name);
		}
	}

	/**
	 * Gets the name of the current default schema
	 *
	 * @returns Current schema name
	 */
	getCurrentSchemaName(): string {
		return this.currentSchemaName;
	}

	/**
	 * Registers a virtual table module
	 *
	 * @param name Module name
	 * @param module Module implementation
	 * @param auxData Optional client data associated with the module registration
	 */
	registerModule(name: string, module: AnyVirtualTableModule, auxData?: unknown): void {
		const lowerName = name.toLowerCase();
		if (this.modules.has(lowerName)) {
			warnLog(`Replacing existing virtual table module: %s`, lowerName);
		}
		this.modules.set(lowerName, { module, auxData });
		log(`Registered VTab module: %s`, lowerName);
	}

	/**
	 * Retrieves a registered virtual table module by name
	 *
	 * @param name Module name to look up
	 * @returns The module and its auxData, or undefined if not found
	 */
	getModule(name: string): { module: AnyVirtualTableModule, auxData?: unknown } | undefined {
		return this.modules.get(name.toLowerCase());
	}

	/**
	 * Iterates registered virtual table modules in registration order.
	 * Each entry yields the registered (lowercased) name, the module, and
	 * any auxData supplied at registration time.
	 */
	*allModules(): IterableIterator<{ name: string; module: AnyVirtualTableModule; auxData?: unknown }> {
		for (const [name, reg] of this.modules) {
			yield { name, module: reg.module, auxData: reg.auxData };
		}
	}

	/**
	 * Sets the default virtual table module to use when USING is omitted
	 *
	 * @param name Module name. Must be a registered module.
	 * @throws QuereusError if the module name is not registered
	 */
	setDefaultVTabModuleName(name: string): void {
		const lowerName = name.toLowerCase();
		if (this.modules.has(lowerName)) {
			this.defaultVTabModuleName = lowerName;
			log(`Default VTab module name set to: %s`, lowerName);
		} else {
			warnLog(`Setting default VTab module to '${lowerName}', which is not currently registered in SchemaManager. Ensure it gets registered.`);
			this.defaultVTabModuleName = lowerName;
		}
	}

	/**
	 * Gets the currently configured default virtual table module name
	 *
	 * @returns The default module name
	 */
	getDefaultVTabModuleName(): string {
		return this.defaultVTabModuleName;
	}

	/** @internal Sets the default VTab args directly */
	setDefaultVTabArgs(args: Record<string, SqlValue>): void {
		this.defaultVTabModuleArgs = args;
		log('Default VTab module args set to: %o', args);
	}

	/** @internal Sets the default VTab args by parsing a JSON string */
	setDefaultVTabArgsFromJson(argsJsonString: string): void {
		try {
			const parsedArgs = JSON.parse(argsJsonString);
			if (typeof parsedArgs !== 'object') {
				quereusError("JSON value must be an object.", StatusCode.MISUSE);
			}
			this.setDefaultVTabArgs(parsedArgs);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			quereusError(`Invalid JSON for default_vtab_args: ${msg}`, StatusCode.ERROR);
		}
	}

	/**
	 * Gets the default virtual table module arguments.
	 * @returns A copy of the default arguments array.
	 */
	getDefaultVTabArgs(): Record<string, SqlValue> {
		return { ...this.defaultVTabModuleArgs };
	}

	/**
	 * Gets the default virtual table module name and arguments.
	 * @returns An object containing the module name and arguments.
	 */
	getDefaultVTabModule(): { name: string; args: Record<string, SqlValue> } {
		return {
			name: this.defaultVTabModuleName,
			args: this.defaultVTabModuleArgs,
		};
	}

	/**
	 * Gets a specific schema by name
	 *
	 * @param name Schema name to retrieve
	 * @returns The schema or undefined if not found
	 */
	getSchema(name: string): Schema | undefined {
		return this.schemas.get(name.toLowerCase());
	}

	/**
	 * Gets the 'main' schema
	 *
	 * @returns The main schema
	 */
	getMainSchema(): Schema {
		return this.schemas.get('main')!;
	}

	/**
	 * Gets the 'temp' schema
	 *
	 * @returns The temp schema
	 */
	getTempSchema(): Schema {
		return this.schemas.get('temp')!;
	}

	/**
	 * @internal Returns iterator over all managed schemas
	 */
	_getAllSchemas(): IterableIterator<Schema> {
		return this.schemas.values();
	}

	/**
	 * Returns all assertions across all schemas
	 */
	getAllAssertions(): IntegrityAssertionSchema[] {
		const result: IntegrityAssertionSchema[] = [];
		for (const schema of this._getAllSchemas()) {
			for (const a of schema.getAllAssertions()) {
				result.push(a);
			}
		}
		return result;
	}

	/**
	 * Adds (or replaces) an assertion in the named schema, firing
	 * `assertion_added` or `assertion_modified` events as appropriate.
	 * The Schema object itself does not hold a notifier; this wrapper exists
	 * so optimizer caches (e.g. assertion-hoist) can invalidate on change.
	 */
	addAssertion(schemaName: string, assertion: IntegrityAssertionSchema): void {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) {
			throw new QuereusError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}
		const existing = schema.getAssertion(assertion.name);
		schema.addAssertion(assertion);
		if (existing) {
			this.changeNotifier.notifyChange({
				type: 'assertion_modified',
				schemaName: schemaName,
				objectName: assertion.name,
				oldObject: existing,
				newObject: assertion,
			});
		} else {
			this.changeNotifier.notifyChange({
				type: 'assertion_added',
				schemaName: schemaName,
				objectName: assertion.name,
				newObject: assertion,
			});
		}
	}

	/**
	 * Removes an assertion from the named schema, firing `assertion_removed`
	 * on success. Returns true iff the assertion existed and was removed.
	 */
	removeAssertion(schemaName: string, name: string): boolean {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) return false;
		const existing = schema.getAssertion(name);
		if (!existing) return false;
		const removed = schema.removeAssertion(name);
		if (removed) {
			this.changeNotifier.notifyChange({
				type: 'assertion_removed',
				schemaName: schemaName,
				objectName: name,
				oldObject: existing,
			});
		}
		return removed;
	}

	/**
	 * Gets the schema change notifier for listening to schema changes
	 */
	getChangeNotifier(): SchemaChangeNotifier {
		return this.changeNotifier;
	}

	/**
	 * True when assertion-hoisting must be suppressed (the caller is currently
	 * planning an assertion's own violation query). Read by
	 * `getAssertionHoistedConstraints`.
	 */
	isAssertionHoistSuppressed(): boolean {
		return this.assertionHoistSuppressed > 0;
	}

	/**
	 * Run `fn` with assertion-hoisting suppressed. Re-entrant via a depth
	 * counter so nested suppressions compose. Always restores the previous
	 * state, even when `fn` throws.
	 */
	withSuppressedAssertionHoist<T>(fn: () => T): T {
		this.assertionHoistSuppressed++;
		try {
			return fn();
		} finally {
			this.assertionHoistSuppressed--;
		}
	}

	/**
	 * True when the read-side materialized-view query-rewrite rule must be
	 * suppressed (the caller is currently planning an MV's own body to recompute or
	 * maintain its backing). Read by `rule-materialized-view-rewrite.ts`.
	 */
	isMaterializedViewRewriteSuppressed(): boolean {
		return this.mvRewriteSuppressed > 0;
	}

	/**
	 * Run a synchronous `fn` with the materialized-view query-rewrite rule
	 * suppressed. Re-entrant via a depth counter; always restores state, even on
	 * throw. Wrap every place that plans an MV body to (re)compute its backing.
	 */
	withSuppressedMaterializedViewRewrite<T>(fn: () => T): T {
		this.mvRewriteSuppressed++;
		try {
			return fn();
		} finally {
			this.mvRewriteSuppressed--;
		}
	}

	/** Async counterpart of {@link withSuppressedMaterializedViewRewrite}. */
	async withSuppressedMaterializedViewRewriteAsync<T>(fn: () => Promise<T>): Promise<T> {
		this.mvRewriteSuppressed++;
		try {
			return await fn();
		} finally {
			this.mvRewriteSuppressed--;
		}
	}

	/**
	 * Adds a new schema (e.g., for ATTACH)
	 *
	 * @param name Name of the schema to add
	 * @param kind Whether the schema is module-backed (`physical`, default) or
	 *   design-only (`logical`). See `docs/lens.md` § Schema Kinds.
	 * @returns The newly created schema
	 * @throws QuereusError if the name conflicts with an existing schema
	 */
	addSchema(name: string, kind: SchemaKind = 'physical'): Schema {
		const lowerName = name.toLowerCase();
		if (this.schemas.has(lowerName)) {
			throw new QuereusError(`Schema '${name}' already exists`, StatusCode.ERROR);
		}
		const schema = new Schema(lowerName, kind);
		this.schemas.set(lowerName, schema);
		log(`Added schema '%s' (kind=%s)`, lowerName, kind);
		return schema;
	}

	/**
	 * Removes a schema (e.g., for DETACH)
	 *
	 * @param name Name of the schema to remove
	 * @returns true if found and removed, false otherwise
	 * @throws QuereusError if attempting to remove 'main' or 'temp'
	 */
	removeSchema(name: string): boolean {
		const lowerName = name.toLowerCase();
		if (lowerName === 'main' || lowerName === 'temp') {
			throw new QuereusError(`Cannot detach schema '${name}'`, StatusCode.ERROR);
		}
		const schema = this.schemas.get(lowerName);
		if (schema) {
			schema.clearFunctions();
			schema.clearTables();
			schema.clearViews();
			schema.clearMaterializedViews();
			schema.clearAssertions();
			schema.clearLensSlots();
			this.schemas.delete(lowerName);
			log(`Removed schema '%s'`, name);
			return true;
		}
		return false;
	}

	/**
	 * @internal Finds a table or virtual table by name across schemas
	 *
	 * @param tableName Name of the table to find
	 * @param dbName Optional specific schema name to search (overrides search path)
	 * @param schemaPath Optional ordered list of schemas to search (overrides default search order)
	 * @returns The TableSchema if found, undefined otherwise
	 */
	_findTable(tableName: string, dbName?: string, schemaPath?: string[]): TableSchema | undefined {
		const lowerTableName = tableName.toLowerCase();

		if (dbName) {
			// Search specific schema (qualified name)
			const schema = this.schemas.get(dbName.toLowerCase());
			return schema?.getTable(lowerTableName);
		} else if (schemaPath && schemaPath.length > 0) {
			// Search through provided schema path in order
			for (const schemaName of schemaPath) {
				const schema = this.schemas.get(schemaName.toLowerCase());
				const table = schema?.getTable(lowerTableName);
				if (table) return table;
			}
			return undefined;
		} else {
			// Default search order: main, then temp (and attached later)
			const mainSchema = this.schemas.get('main');
			let table = mainSchema?.getTable(lowerTableName);
			if (table) return table;

			const tempSchema = this.schemas.get('temp');
			table = tempSchema?.getTable(lowerTableName);
			return table;
		}
	}

	/**
	 * Finds a table by name, searching schemas according to SQLite rules
	 *
	 * @param tableName Name of the table
	 * @param dbName Optional specific schema name to search
	 * @param schemaPath Optional ordered list of schemas to search
	 * @returns The TableSchema or undefined if not found
	 */
	findTable(tableName: string, dbName?: string, schemaPath?: string[]): TableSchema | undefined {
		return this._findTable(tableName, dbName, schemaPath);
	}

	/**
	 * Finds all schemas that contain a table with the given name.
	 * Useful for generating helpful error messages.
	 *
	 * @param tableName Name of the table to search for
	 * @returns Array of schema names that contain the table
	 */
	findSchemasContainingTable(tableName: string): string[] {
		const lowerTableName = tableName.toLowerCase();
		const schemaNames: string[] = [];

		for (const [schemaName, schema] of this.schemas) {
			if (schema.getTable(lowerTableName)) {
				schemaNames.push(schemaName);
			}
		}

		return schemaNames;
	}

	/**
	 * Finds a function by name and arg count, searching schemas
	 *
	 * @param funcName Name of the function
	 * @param nArg Number of arguments
	 * @returns The FunctionSchema or undefined if not found
	 */
	findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
		return this.getMainSchema().getFunction(funcName, nArg);
	}

	/**
	 * Retrieves a view schema definition
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param viewName The name of the view
	 * @returns The ViewSchema or undefined if not found
	 */
	getView(schemaName: string | null, viewName: string): ViewSchema | undefined {
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getView(viewName);
	}

	/**
	 * Retrieves a materialized view schema definition.
	 *
	 * @param schemaName The schema name ('main', etc.). Defaults to current schema
	 * @param name The materialized view name
	 */
	getMaterializedView(schemaName: string | null, name: string): MaterializedViewSchema | undefined {
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getMaterializedView(name);
	}

	/**
	 * Reverse lookup: find the materialized view in `schemaName` whose backing
	 * table is `backingName`. Backing tables follow the reserved `_mv_<name>`
	 * convention (see {@link backingTableNameFor}), so the MV name is derived from
	 * the prefix and confirmed against the MV's own `backingTableName`.
	 *
	 * Used by change-scope analysis to project a materialized view's backing-table
	 * reference onto its sources. (It formerly also gated the row-time create path to
	 * reject MV-over-MV bodies; that rejection is lifted — such bodies are now
	 * maintained by the cascade in `database-materialized-views.ts`.) Returns undefined
	 * when `backingName` is not a backing-table name, or no MV in that schema is backed
	 * by it.
	 */
	getMaterializedViewByBackingTable(schemaName: string | null, backingName: string): MaterializedViewSchema | undefined {
		const lower = backingName.toLowerCase();
		const prefix = backingTableNameFor('');
		if (!lower.startsWith(prefix)) return undefined;
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
		const schema = this.schemas.get(targetSchemaName);
		if (!schema) return undefined;
		const mv = schema.getMaterializedView(lower.slice(prefix.length));
		if (mv && mv.backingTableName.toLowerCase() === lower) return mv;
		return undefined;
	}

	/**
	 * Returns all materialized views across all schemas.
	 */
	getAllMaterializedViews(): MaterializedViewSchema[] {
		const result: MaterializedViewSchema[] = [];
		for (const schema of this.schemas.values()) {
			for (const mv of schema.getAllMaterializedViews()) result.push(mv);
		}
		return result;
	}

	/**
	 * Registers a materialized view definition in the target schema.
	 */
	addMaterializedView(mv: MaterializedViewSchema): void {
		const schema = this.getSchemaOrFail(mv.schemaName);
		schema.addMaterializedView(mv);
	}

	/**
	 * Removes a materialized view definition from the catalog (does NOT drop its
	 * backing table — the caller drops that separately so `table_removed` fires).
	 *
	 * @returns true if found and removed, false otherwise
	 */
	removeMaterializedView(schemaName: string, name: string): boolean {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) return false;
		return schema.removeMaterializedView(name);
	}

	/**
	 * Retrieves any schema item (table or view) by name. Checks views first
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param itemName The name of the table or view
	 * @returns The TableSchema or ViewSchema, or undefined if not found
	 */
	getSchemaItem(schemaName: string | null, itemName: string): TableSchema | ViewSchema | undefined {
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
		const schema = this.schemas.get(targetSchemaName);
		if (!schema) return undefined;

		// Prioritize views over tables if names conflict
		const view = schema.getView(itemName);
		if (view) return view;
		return schema.getTable(itemName);
	}

	/**
	 * Gets metadata tags for a table.
	 *
	 * @param tableName The table name
	 * @param schemaName Optional schema name (defaults to current schema)
	 * @returns The tags record or undefined if no tags are set
	 */
	getTableTags(tableName: string, schemaName?: string): Readonly<Record<string, SqlValue>> | undefined {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const tableSchema = this.getTable(targetSchemaName, tableName);
		return tableSchema?.tags;
	}

	/**
	 * Freezes a whole-set tag replacement: an empty record stores `undefined`
	 * (so `tags IS NULL` and the differ's "no tags" both hold), a non-empty one a
	 * frozen copy. Shared by the three catalog-only tag setters.
	 */
	private freezeTags(tags: Record<string, SqlValue>): Readonly<Record<string, SqlValue>> | undefined {
		return Object.keys(tags).length > 0 ? Object.freeze({ ...tags }) : undefined;
	}

	/**
	 * Computes the next frozen tag record from the current one plus a per-key
	 * mutation, reusing {@link freezeTags} for the empty→`undefined` collapse.
	 *
	 *  - `merge`: shallow-overlay the new keys onto the current set (overwrite on
	 *    collision), keeping the rest. A merge of a non-empty payload can never empty
	 *    the set; an empty merge of an empty set collapses to `undefined`.
	 *  - `drop`: every listed key must currently be present (atomic). Any missing key
	 *    raises `NOTFOUND` naming the offenders and mutates nothing; otherwise the keys
	 *    are deleted and dropping the last key collapses to `undefined`. Key matching
	 *    is verbatim (case-sensitive), matching how `parseTags` stores keys.
	 */
	private mutateTagRecord(
		current: Readonly<Record<string, SqlValue>> | undefined,
		mutation: TagMutation,
	): Readonly<Record<string, SqlValue>> | undefined {
		if (mutation.op === 'merge') {
			return this.freezeTags({ ...(current ?? {}), ...mutation.tags });
		}
		const next: Record<string, SqlValue> = { ...(current ?? {}) };
		const missing = mutation.keys.filter(k => !(k in next));
		if (missing.length > 0) {
			throw new QuereusError(`Tag key(s) not found: ${missing.join(', ')}`, StatusCode.NOTFOUND);
		}
		for (const k of mutation.keys) delete next[k];
		return this.freezeTags(next);
	}

	/**
	 * Re-registers a tag-only schema swap and fires `table_modified` so optimizer
	 * caches invalidate. Tags are excluded from the schema hash, so a tag-only swap
	 * is a structural no-op except for the metadata itself.
	 */
	private commitTagUpdate(targetSchemaName: string, oldSchema: TableSchema, newSchema: TableSchema): void {
		const schema = this.getSchemaOrFail(targetSchemaName);
		schema.addTable(newSchema);
		this.changeNotifier.notifyChange({
			type: 'table_modified',
			schemaName: targetSchemaName,
			objectName: newSchema.name,
			oldObject: oldSchema,
			newObject: newSchema,
		});
	}

	/**
	 * Shared table-tag read-modify-write: fetches the live table (NOTFOUND if
	 * absent), computes the next tag record from its current `tags` via `compute`,
	 * and commits the swap (firing `table_modified`). `compute` decides
	 * replace / merge / drop; it may throw before any mutation (e.g. drop-of-absent
	 * NOTFOUND), leaving the catalog untouched. Reads the *live* schema each call so
	 * back-to-back ALTERs and prepared-statement reuse see the prior result.
	 */
	private updateTableTags(tableName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const tableSchema = this.getTable(targetSchemaName, tableName);
		if (!tableSchema) {
			throw new QuereusError(`Table '${tableName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const updatedSchema: TableSchema = {
			...tableSchema,
			tags: compute(tableSchema.tags),
		};
		this.commitTagUpdate(targetSchemaName, tableSchema, updatedSchema);
	}

	/**
	 * Sets metadata tags on an existing table, replacing any existing tags.
	 *
	 * @param tableName The table name
	 * @param tags The tags to set (pass empty object to clear)
	 * @param schemaName Optional schema name (defaults to current schema)
	 */
	setTableTags(tableName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateTableTags(tableName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into an existing table's tags — set/overwrite the listed keys,
	 * keep the rest (the `ALTER TABLE … ADD TAGS` primitive). An empty `tags` is a
	 * no-op (it does NOT clear). Reads the table's live tags at call time.
	 */
	mergeTableTags(tableName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateTableTags(tableName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from an existing table's tags (the `ALTER TABLE …
	 * DROP TAGS` primitive). Atomic: every key must be present, else `NOTFOUND`
	 * names the missing key(s) and nothing is dropped. Dropping the last key(s)
	 * leaves `tags` undefined. An empty `keys` is a no-op.
	 */
	dropTableTags(tableName: string, keys: readonly string[], schemaName?: string): void {
		this.updateTableTags(tableName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared column-tag read-modify-write: resolves the table and column (NOTFOUND
	 * on either miss), computes the column's next tag record from its current `tags`
	 * via `compute`, and commits the swap. Only the column's `tags` field changes;
	 * nullability / type / default / PK membership are untouched. `compute` may throw
	 * before any mutation (drop-of-absent NOTFOUND), leaving the catalog untouched.
	 */
	private updateColumnTags(tableName: string, columnName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const tableSchema = this.getTable(targetSchemaName, tableName);
		if (!tableSchema) {
			throw new QuereusError(`Table '${tableName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const colIndex = tableSchema.columnIndexMap.get(columnName.toLowerCase());
		if (colIndex === undefined) {
			throw new QuereusError(`Column '${columnName}' not found in table '${tableName}'`, StatusCode.NOTFOUND);
		}
		// Compute before building the new column array so a drop-of-absent NOTFOUND
		// aborts before any swap.
		const nextTags = compute(tableSchema.columns[colIndex].tags);
		const newColumns = tableSchema.columns.map((c, i) => (i === colIndex ? { ...c, tags: nextTags } : c));
		const updatedSchema: TableSchema = {
			...tableSchema,
			columns: Object.freeze(newColumns),
		};
		this.commitTagUpdate(targetSchemaName, tableSchema, updatedSchema);
	}

	/**
	 * Sets metadata tags on a column of an existing table, replacing any existing
	 * tags on that column (empty record clears). Catalog-only — only the column's
	 * `tags` field changes; nullability / type / default / PK membership are
	 * untouched.
	 *
	 * @throws QuereusError(NOTFOUND) if the table or column does not exist.
	 */
	setColumnTags(tableName: string, columnName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateColumnTags(tableName, columnName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into a column's existing tags — set/overwrite the listed keys,
	 * keep the rest (`ALTER TABLE … ALTER COLUMN … ADD TAGS`). Empty `tags` is a
	 * no-op (does NOT clear).
	 *
	 * @throws QuereusError(NOTFOUND) if the table or column does not exist.
	 */
	mergeColumnTags(tableName: string, columnName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateColumnTags(tableName, columnName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from a column's tags (`ALTER TABLE … ALTER COLUMN …
	 * DROP TAGS`). Atomic: every key must be present, else `NOTFOUND` names the
	 * missing key(s) and nothing is dropped. Empty `keys` is a no-op.
	 *
	 * @throws QuereusError(NOTFOUND) if the table or column does not exist, or any
	 *   listed key is absent.
	 */
	dropColumnTags(tableName: string, columnName: string, keys: readonly string[], schemaName?: string): void {
		this.updateColumnTags(tableName, columnName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared named-constraint-tag read-modify-write: resolves the table (NOTFOUND if
	 * absent) and the single matching constraint class (check → unique → fk;
	 * NOTFOUND / ambiguous via {@link resolveNamedConstraintClass}), computes the
	 * matching constraint's next tag record from its current `tags` via `compute`,
	 * and commits. `compute` may throw before any mutation (drop-of-absent NOTFOUND);
	 * since it runs inside the array rebuild prior to `commitTagUpdate`, a throw
	 * leaves the catalog untouched.
	 */
	private updateConstraintTags(tableName: string, constraintName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const tableSchema = this.getTable(targetSchemaName, tableName);
		if (!tableSchema) {
			throw new QuereusError(`Table '${tableName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const lower = constraintName.toLowerCase();
		// Resolve to exactly one class (check → unique → fk), or throw NOTFOUND/ambiguous.
		const constraintClass = resolveNamedConstraintClass(tableSchema, constraintName);
		const updatedSchema: TableSchema = { ...tableSchema };
		if (constraintClass === 'check') {
			updatedSchema.checkConstraints = Object.freeze(
				tableSchema.checkConstraints.map(c => (c.name?.toLowerCase() === lower ? { ...c, tags: compute(c.tags) } : c)),
			);
		} else if (constraintClass === 'unique') {
			updatedSchema.uniqueConstraints = Object.freeze(
				tableSchema.uniqueConstraints!.map(c => (c.name?.toLowerCase() === lower ? { ...c, tags: compute(c.tags) } : c)),
			);
		} else {
			updatedSchema.foreignKeys = Object.freeze(
				tableSchema.foreignKeys!.map(c => (c.name?.toLowerCase() === lower ? { ...c, tags: compute(c.tags) } : c)),
			);
		}
		this.commitTagUpdate(targetSchemaName, tableSchema, updatedSchema);
	}

	/**
	 * Sets metadata tags on a NAMED table-level constraint (CHECK / UNIQUE /
	 * FOREIGN KEY), replacing any existing tags (empty record clears). Lookup order
	 * is checks → unique → foreign keys; a name present in more than one class is
	 * rejected as ambiguous. Unnamed constraints are not addressable.
	 *
	 * @throws QuereusError(NOTFOUND) if no named constraint matches.
	 * @throws QuereusError(ERROR) if the name is ambiguous across constraint classes.
	 */
	setConstraintTags(tableName: string, constraintName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateConstraintTags(tableName, constraintName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into a named constraint's existing tags — set/overwrite the
	 * listed keys, keep the rest (`ALTER TABLE … ALTER CONSTRAINT … ADD TAGS`).
	 * Empty `tags` is a no-op (does NOT clear).
	 *
	 * @throws QuereusError(NOTFOUND) if no named constraint matches.
	 * @throws QuereusError(ERROR) if the name is ambiguous across constraint classes.
	 */
	mergeConstraintTags(tableName: string, constraintName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateConstraintTags(tableName, constraintName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from a named constraint's tags (`ALTER TABLE … ALTER
	 * CONSTRAINT … DROP TAGS`). Atomic: every key must be present, else `NOTFOUND`
	 * names the missing key(s) and nothing is dropped. Empty `keys` is a no-op.
	 *
	 * @throws QuereusError(NOTFOUND) if no named constraint matches, or any listed
	 *   key is absent.
	 * @throws QuereusError(ERROR) if the name is ambiguous across constraint classes.
	 */
	dropConstraintTags(tableName: string, constraintName: string, keys: readonly string[], schemaName?: string): void {
		this.updateConstraintTags(tableName, constraintName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared view-tag read-modify-write: fetches the live view (NOTFOUND if
	 * absent), computes its next tag record from its current `tags` via `compute`,
	 * re-registers the swapped {@link ViewSchema}, and fires `view_modified` so a
	 * cached write-through plan that recorded a `view` dependency (every
	 * view-/MV-mediated write does — see `buildViewMutation`) is invalidated when
	 * the view's behavioral `quereus.update.*` tags change. This event is distinct
	 * from the (non-existent) plain-view create event, so it triggers no maintenance
	 * re-registration. `compute` decides replace / merge / drop and may throw before
	 * any mutation (drop-of-absent NOTFOUND), leaving the catalog untouched.
	 */
	private updateViewTags(viewName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const schema = this.getSchemaOrFail(targetSchemaName);
		const view = schema.getView(viewName);
		if (!view) {
			throw new QuereusError(`View '${viewName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const updated: ViewSchema = { ...view, tags: compute(view.tags) };
		schema.addView(updated);
		this.changeNotifier.notifyChange({
			type: 'view_modified',
			schemaName: targetSchemaName,
			// Canonical stored name (not the raw `viewName` arg) so the event matches
			// the `view` plan dependency, which records `view.name` — mirrors
			// `commitTagUpdate`'s `newSchema.name`. A case-differing ALTER (e.g.
			// `alter view MYVIEW` on `create view MyView`) would otherwise miss.
			objectName: updated.name,
			oldObject: view,
			newObject: updated,
		});
	}

	/**
	 * Sets metadata tags on an existing view, replacing any existing tags (empty
	 * record clears).
	 *
	 * @throws QuereusError(NOTFOUND) if the view does not exist.
	 */
	setViewTags(viewName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateViewTags(viewName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into an existing view's tags — set/overwrite the listed keys,
	 * keep the rest (`ALTER VIEW … ADD TAGS`). Empty `tags` is a no-op (does NOT
	 * clear). Reads the view's live tags at call time.
	 *
	 * @throws QuereusError(NOTFOUND) if the view does not exist.
	 */
	mergeViewTags(viewName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateViewTags(viewName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from an existing view's tags (`ALTER VIEW … DROP TAGS`).
	 * Atomic: every key must be present, else `NOTFOUND` names the missing key(s)
	 * and nothing is dropped. Dropping the last key(s) leaves `tags` undefined. An
	 * empty `keys` is a no-op.
	 *
	 * @throws QuereusError(NOTFOUND) if the view does not exist, or any listed key
	 *   is absent.
	 */
	dropViewTags(viewName: string, keys: readonly string[], schemaName?: string): void {
		this.updateViewTags(viewName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared materialized-view-tag read-modify-write: fetches the live MV (NOTFOUND
	 * if absent), computes its next tag record via `compute`, re-registers the
	 * swapped {@link MaterializedViewSchema}, and fires `materialized_view_modified`.
	 * The backing table and the row-time maintenance plan are untouched (tags do not
	 * affect maintenance), so this never re-materializes — `_modified` is
	 * deliberately distinct from `materialized_view_added` (what create emits): the
	 * MV maintenance manager re-registers on `_added` but ignores `_modified`. The
	 * event invalidates a cached write-through plan that recorded a `view` dependency
	 * when the MV's behavioral `quereus.update.*` tags change. `compute` may throw
	 * before any mutation (drop-of-absent NOTFOUND), leaving the catalog untouched.
	 */
	private updateMaterializedViewTags(name: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const schema = this.getSchemaOrFail(targetSchemaName);
		const mv = schema.getMaterializedView(name);
		if (!mv) {
			throw new QuereusError(`Materialized view '${name}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const updated: MaterializedViewSchema = { ...mv, tags: compute(mv.tags) };
		schema.addMaterializedView(updated);
		this.changeNotifier.notifyChange({
			type: 'materialized_view_modified',
			schemaName: targetSchemaName,
			// Canonical stored name (not the raw `name` arg) so the event matches the
			// `view` plan dependency, which records `view.name` — see `updateViewTags`.
			objectName: updated.name,
			oldObject: mv,
			newObject: updated,
		});
	}

	/**
	 * Sets metadata tags on an existing materialized view, replacing any existing
	 * tags (empty record clears). Catalog-only — never re-materializes.
	 *
	 * @throws QuereusError(NOTFOUND) if the materialized view does not exist.
	 */
	setMaterializedViewTags(name: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateMaterializedViewTags(name, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into an existing materialized view's tags — set/overwrite the
	 * listed keys, keep the rest (`ALTER MATERIALIZED VIEW … ADD TAGS`). Empty
	 * `tags` is a no-op (does NOT clear). Catalog-only — never re-materializes.
	 *
	 * @throws QuereusError(NOTFOUND) if the materialized view does not exist.
	 */
	mergeMaterializedViewTags(name: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateMaterializedViewTags(name, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from an existing materialized view's tags (`ALTER
	 * MATERIALIZED VIEW … DROP TAGS`). Atomic: every key must be present, else
	 * `NOTFOUND` names the missing key(s) and nothing is dropped. Empty `keys` is a
	 * no-op. Catalog-only — never re-materializes.
	 *
	 * @throws QuereusError(NOTFOUND) if the materialized view does not exist, or any
	 *   listed key is absent.
	 */
	dropMaterializedViewTags(name: string, keys: readonly string[], schemaName?: string): void {
		this.updateMaterializedViewTags(name, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared index-tag read-modify-write. Indexes live on their owning
	 * {@link TableSchema}, so this resolves the owner by index name, computes the
	 * matching {@link IndexSchema}'s next tag record from its current `tags` via
	 * `compute`, swaps it, re-registers the table, and fires `table_modified`
	 * (mirroring create/drop index) so optimizer caches invalidate.
	 *
	 * Hidden implicit covering structures (the auto-built BTree backing a UNIQUE
	 * constraint, not opted into catalog visibility) are not user-addressable and
	 * surface as NOTFOUND — their tags live on the originating constraint. `compute`
	 * runs before the index array is rebuilt, so a drop-of-absent NOTFOUND aborts
	 * before any swap.
	 */
	private updateIndexTags(indexName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const schema = this.getSchemaOrFail(targetSchemaName);
		const lower = indexName.toLowerCase();

		// Primary path: a materialized IndexSchema — every real index, plus the
		// memory backend's materialized implicit covering index. Tags live on the
		// matched IndexSchema. A *hidden* implicit index is not user-addressable and
		// is skipped here; it then fails the exposed-constraint fallback below
		// (its name is materialized, so it is not "exposed and unmaterialized") and
		// surfaces as NOTFOUND — preserving Phase 22/37 behavior.
		for (const table of schema.getAllTables()) {
			const matched = table.indexes?.find(idx => idx.name.toLowerCase() === lower);
			if (!matched || isHiddenImplicitIndex(table, matched.name)) continue;
			// Compute before rebuilding the index array so a drop-of-absent NOTFOUND
			// aborts before any swap.
			const nextTags = compute(matched.tags);
			const updatedIndexes = table.indexes!.map(idx => (idx.name.toLowerCase() === lower ? { ...idx, tags: nextTags } : idx));
			this.commitTagUpdate(targetSchemaName, table, { ...table, indexes: Object.freeze(updatedIndexes) });
			return;
		}

		// Fallback (store mode): the exposed implicit covering index is not
		// materialized as an IndexSchema. Route its tags onto the originating UNIQUE
		// constraint's `exposedIndexTags` — kept separate from `uc.tags`, which holds
		// the exposure flag, so the flag never leaks into the surfaced index tags.
		// `findExposedImplicitConstraintIndex` returns -1 for hidden/materialized
		// implicit indexes, so they fall through to NOTFOUND.
		for (const table of schema.getAllTables()) {
			const ucIndex = findExposedImplicitConstraintIndex(table, indexName);
			if (ucIndex < 0) continue;
			const constraints = table.uniqueConstraints!;
			// Compute before swapping so a drop-of-absent NOTFOUND aborts untouched.
			const nextTags = compute(constraints[ucIndex].exposedIndexTags);
			const updatedConstraints = constraints.map((uc, i) => {
				if (i !== ucIndex) return uc;
				const next = { ...uc };
				if (nextTags) next.exposedIndexTags = nextTags;
				else delete next.exposedIndexTags;
				return next;
			});
			this.commitTagUpdate(targetSchemaName, table, { ...table, uniqueConstraints: Object.freeze(updatedConstraints) });
			return;
		}

		throw new QuereusError(`Index '${indexName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
	}

	/**
	 * Sets metadata tags on an existing index, replacing any existing tags (empty
	 * record clears).
	 *
	 * @throws QuereusError(NOTFOUND) if no user-visible index matches.
	 */
	setIndexTags(indexName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateIndexTags(indexName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into an existing index's tags — set/overwrite the listed keys,
	 * keep the rest (`ALTER INDEX … ADD TAGS`). Empty `tags` is a no-op (does NOT
	 * clear).
	 *
	 * @throws QuereusError(NOTFOUND) if no user-visible index matches.
	 */
	mergeIndexTags(indexName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateIndexTags(indexName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from an existing index's tags (`ALTER INDEX … DROP
	 * TAGS`). Atomic: every key must be present, else `NOTFOUND` names the missing
	 * key(s) and nothing is dropped. Empty `keys` is a no-op.
	 *
	 * @throws QuereusError(NOTFOUND) if no user-visible index matches, or any listed
	 *   key is absent.
	 */
	dropIndexTags(indexName: string, keys: readonly string[], schemaName?: string): void {
		this.updateIndexTags(indexName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Asserts that no other table has FK rows referencing the table being dropped.
	 * Self-referential FKs are skipped — those rows go away with the table.
	 * No-op when foreign_keys is off.
	 */
	private async assertNoReferencingChildrenForDrop(parentSchemaName: string, parentTableName: string): Promise<void> {
		if (!this.db.options.getBooleanOption('foreign_keys')) return;

		const parentSchemaLower = parentSchemaName.toLowerCase();
		const parentTableLower = parentTableName.toLowerCase();

		for (const schema of this._getAllSchemas()) {
			for (const childTable of schema.getAllTables()) {
				if (!childTable.foreignKeys) continue;
				// Skip the table being dropped itself — self-FK rows are going away with it.
				if (childTable.schemaName.toLowerCase() === parentSchemaLower &&
					childTable.name.toLowerCase() === parentTableLower) continue;

				for (const fk of childTable.foreignKeys) {
					if (fk.referencedTable.toLowerCase() !== parentTableLower) continue;
					const targetSchema = fk.referencedSchema ?? childTable.schemaName;
					if (targetSchema.toLowerCase() !== parentSchemaLower) continue;

					// MATCH SIMPLE: row is referencing iff every FK column is non-NULL.
					const childColNames = fk.columns.map(idx => quoteIdentifier(childTable.columns[idx].name));
					const whereClause = childColNames.map(c => `${c} IS NOT NULL`).join(' AND ');
					const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
						? `${quoteIdentifier(childTable.schemaName)}.`
						: '';
					const sql = `select 1 from ${schemaPrefix}${quoteIdentifier(childTable.name)} where ${whereClause} limit 1`;

					const stmt = this.db.prepare(sql);
					try {
						let referenced = false;
						for await (const _row of stmt._iterateRowsRaw()) {
							referenced = true;
							break;
						}
						if (referenced) {
							throw new QuereusError(
								`FOREIGN KEY constraint failed: cannot drop table '${parentTableName}' because table '${childTable.name}' still has rows referencing it`,
								StatusCode.CONSTRAINT,
							);
						}
					} finally {
						await stmt.finalize();
					}
				}
			}
		}
	}

	/**
	 * Drops a table from the specified schema
	 *
	 * @param schemaName The name of the schema
	 * @param tableName The name of the table to drop
	 * @param ifExists If true, do not throw an error if the table does not exist.
	 * @returns True if the table was found and dropped, false otherwise.
	 */
	async dropTable(schemaName: string, tableName: string, ifExists: boolean = false): Promise<boolean> {
		const schema = this.schemas.get(schemaName.toLowerCase()); // Ensure schemaName is lowercased for lookup
		if (!schema) {
			if (ifExists) return false; // Schema not found, but IF EXISTS specified
			throw new QuereusError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}

		const tableSchema = schema.getTable(tableName); // getTable should handle case-insensitivity

		if (!tableSchema) {
			if (ifExists) {
				log(`Table %s.%s not found, but IF EXISTS was specified.`, schemaName, tableName);
				return false; // Not found, but IF EXISTS means no error, not dropped.
			}
			throw new QuereusError(`Table ${tableName} not found in schema ${schemaName}`, StatusCode.NOTFOUND);
		}

		// FK guard: when foreign_keys is on, refuse to drop a parent that still has
		// non-NULL FK rows in any child table (excluding self-FK; those rows go away
		// with the table). MATCH SIMPLE: a row is "referencing" iff every FK column
		// is non-NULL.
		await this.assertNoReferencingChildrenForDrop(schemaName, tableName);

		// Call destroy on the module FIRST, awaiting it and PROPAGATING any rejection,
		// BEFORE any engine-side teardown. A module may veto the drop (e.g. a
		// schema-level inbound-FK guard that an emptied child cannot satisfy); by
		// awaiting destroy before mutating connection/schema state we make the veto
		// abort the statement atomically — on rejection the table stays in our schema
		// map AND in the module's own catalogue, since neither has been touched yet.
		// Awaiting here (rather than after removeTable, as before) also preserves the
		// original "subsequent DDL/DML sees a clean slate" intent: destroy still
		// completes before dropTable returns, just without swallowing its error.
		if (tableSchema.vtabModuleName) { // tableSchema is guaranteed to be defined here
			const moduleRegistration = this.getModule(tableSchema.vtabModuleName);
			if (moduleRegistration && moduleRegistration.module && moduleRegistration.module.destroy) {
				log(`Calling destroy for VTab %s.%s via module %s`, schemaName, tableName, tableSchema.vtabModuleName);
				await moduleRegistration.module.destroy(
					this.db,
					moduleRegistration.auxData,
					tableSchema.vtabModuleName,
					schemaName,
					tableName
				);
				log(`destroy completed for VTab %s.%s`, schemaName, tableName);
			} else {
				warnLog(`VTab module %s (for table %s.%s) or its destroy method not found during dropTable.`, tableSchema.vtabModuleName, schemaName, tableName);
			}
		}

		// destroy succeeded (or the module had none) — now tear down engine-side state.
		// Remove any active connections for this table before removing it from the
		// schema map. Connections become stale once the table is dropped and must not
		// be reused if the table is later recreated with the same name.
		this.db.removeConnectionsForTable(schemaName, tableName);

		// Remove from schema map
		const removed = schema.removeTable(tableName);
		if (!removed && !ifExists) {
			// This should ideally not be reached if tableSchema was found above.
			// But as a safeguard if removeTable could fail for other reasons.
			throw new QuereusError(`Failed to remove table ${tableName} from schema ${schemaName}, though it was initially found.`, StatusCode.INTERNAL);
		}

		// Notify schema change listeners if table was removed
		if (removed) {
			this.changeNotifier.notifyChange({
				type: 'table_removed',
				schemaName: schemaName,
				objectName: tableName,
				oldObject: tableSchema
			});

			// Emit auto schema event for modules without native event support
			const moduleReg = tableSchema.vtabModuleName ? this.getModule(tableSchema.vtabModuleName) : undefined;
			if (this.db.hasSchemaListeners() && !hasNativeEventSupport(moduleReg?.module)) {
				this.db._getEventEmitter().emitAutoSchemaEvent(tableSchema.vtabModuleName ?? 'memory', {
					type: 'drop',
					objectType: 'table',
					schemaName: schemaName,
					objectName: tableName,
				});
			}
		}

		return removed; // True if removed from schema, false if not found and ifExists was true.
	}

	/**
	 * Drops a view from the specified schema
	 *
	 * @param schemaName The name of the schema
	 * @param viewName The name of the view to drop
	 * @returns True if the view was found and dropped, false otherwise
	 */
	dropView(schemaName: string, viewName: string): boolean {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) return false;
		return schema.removeView(viewName);
	}

	/**
	 * Clears all schema items (tables, functions, views)
	 */
	clearAll(): void {
		this.schemas.forEach(schema => {
			schema.clearTables();
			schema.clearFunctions();
			schema.clearViews();
			schema.clearMaterializedViews();
			schema.clearAssertions();
			schema.clearLensSlots();
		});
		log("Cleared all schemas.");
	}

	/**
	 * Retrieves a schema object, throwing if it doesn't exist
	 *
	 * @param name Schema name ('main', 'temp', or custom). Case-insensitive
	 * @returns The Schema object
	 * @throws QuereusError if the schema does not exist
	 */
	getSchemaOrFail(name: string): Schema {
		const schema = this.schemas.get(name.toLowerCase());
		if (!schema) {
			throw new QuereusError(`Schema not found: ${name}`);
		}
		return schema;
	}

	/**
	 * Retrieves a table from the specified schema
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param tableName The name of the table
	 * @returns The TableSchema or undefined if not found
	 */
	getTable(schemaName: string | undefined, tableName: string): TableSchema | undefined {
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getTable(tableName);
	}

	/**
	 * Resolves the VTab module name and args from a CREATE TABLE statement,
	 * falling back to configured defaults when USING is omitted.
	 */
	private resolveModuleInfo(stmt: AST.CreateTableStmt): {
		moduleName: string;
		effectiveModuleArgs: Readonly<Record<string, SqlValue>>;
		moduleInfo: { module: AnyVirtualTableModule; auxData?: unknown };
	} {
		let moduleName: string;
		let effectiveModuleArgs: Readonly<Record<string, SqlValue>>;

		if (stmt.moduleName) {
			moduleName = stmt.moduleName;
			effectiveModuleArgs = Object.freeze(stmt.moduleArgs || {});
		} else {
			const defaultVtab = this.getDefaultVTabModule();
			moduleName = defaultVtab.name;
			effectiveModuleArgs = Object.freeze(defaultVtab.args || {});
		}

		const moduleInfo = this.getModule(moduleName);
		if (!moduleInfo || !moduleInfo.module) {
			throw new QuereusError(`No virtual table module named '${moduleName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		return { moduleName, effectiveModuleArgs, moduleInfo };
	}

	/**
	 * Builds column schemas from AST column/constraint definitions,
	 * resolving PK membership and nullability.
	 */
	private buildColumnSchemas(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined,
		defaultNotNull: boolean
	): {
		columns: ColumnSchema[];
		pkDefinition: ReadonlyArray<import('./table.js').PrimaryKeyColumnDefinition>;
		pkDefaultConflict: import('../common/constants.js').ConflictResolution | undefined;
	} {
		const preliminaryColumnSchemas: ColumnSchema[] = astColumns.map(colDef => columnDefToSchema(colDef, defaultNotNull));
		const { pkDef: pkDefinition, defaultConflict: pkDefaultConflict, synthesized } = findPKDefinition(preliminaryColumnSchemas, astConstraints);

		const columns = preliminaryColumnSchemas.map((col, idx) => {
			const isPkColumn = pkDefinition.some(pkCol => pkCol.index === idx);
			const pkOrder = isPkColumn
				? pkDefinition.findIndex(pkC => pkC.index === idx) + 1
				: 0;
			// Only an explicitly-declared PK forces NOT NULL. A synthesized
			// all-columns key (the no-PK fallback) leaves each column's declared
			// nullability intact — see findPKDefinition.
			return {
				...col,
				primaryKey: isPkColumn,
				pkOrder,
				notNull: (isPkColumn && !synthesized) ? true : col.notNull,
			};
		});

		return { columns, pkDefinition, pkDefaultConflict };
	}

	/**
	 * Extracts CHECK constraints from AST column and table constraint definitions.
	 */
	private extractCheckConstraints(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined
	): RowConstraintSchema[] {
		const result: RowConstraintSchema[] = [];

		for (const colDef of astColumns) {
			for (const con of colDef.constraints ?? []) {
				if (con.type === 'check' && con.expr) {
					result.push({
						name: con.name ?? `_check_${colDef.name}`,
						expr: con.expr,
						operations: opsToMask(con.operations),
						defaultConflict: con.onConflict,
						tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
					});
				}
			}
		}

		for (const con of astConstraints ?? []) {
			if (con.type === 'check' && con.expr) {
				result.push({
					name: con.name,
					expr: con.expr,
					operations: opsToMask(con.operations),
					defaultConflict: con.onConflict,
					tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
				});
			}
		}

		return result;
	}

	/**
	 * Extracts FOREIGN KEY constraints from AST column and table constraint definitions.
	 * Resolves column indices in the child table. Parent table resolution is deferred
	 * to enforcement time (the parent table may not exist yet during declarative schema setup).
	 */
	private extractForeignKeys(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined,
		columnIndexMap: ReadonlyMap<string, number>,
		tableName: string,
		schemaName: string,
	): ForeignKeyConstraintSchema[] {
		const result: ForeignKeyConstraintSchema[] = [];

		// Column-level foreign keys
		for (const colDef of astColumns) {
			for (const con of colDef.constraints ?? []) {
				if (con.type === 'foreignKey' && con.foreignKey) {
					const fk = con.foreignKey;
					const childColIndex = columnIndexMap.get(colDef.name.toLowerCase());
					if (childColIndex === undefined) {
						throw new QuereusError(`FK column '${colDef.name}' not found in table '${tableName}'`, StatusCode.ERROR);
					}

					// Parent column resolution is deferred — store names for now
					// We need the parent table schema to resolve indices, but it may not exist yet
					if (fk.columns && fk.columns.length !== 1) {
						throw new QuereusError(
							`FK constraint '${con.name ?? `_fk_${tableName}_${colDef.name}`}' on table '${tableName}': child column count (1) does not match parent column count (${fk.columns.length})`,
							StatusCode.ERROR,
						);
					}
					result.push({
						name: con.name ?? `_fk_${tableName}_${colDef.name}`,
						columns: Object.freeze([childColIndex]),
						referencedTable: fk.table,
						referencedSchema: schemaName,
						referencedColumns: Object.freeze([]), // resolved at enforcement time
						referencedColumnNames: fk.columns, // deferred resolution via resolveReferencedColumns
						onDelete: fk.onDelete ?? 'restrict',
						onUpdate: fk.onUpdate ?? 'restrict',
						deferred: fk.initiallyDeferred ?? false,
						tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
					});
				}
			}
		}

		// Table-level foreign keys — delegate to the shared builder so the module
		// `ADD CONSTRAINT` path and CREATE TABLE produce byte-identical schemas.
		for (const con of astConstraints ?? []) {
			if (con.type === 'foreignKey' && con.foreignKey && con.columns) {
				result.push(buildForeignKeyConstraintSchema(con, columnIndexMap, tableName, schemaName));
			}
		}

		return result;
	}

	/**
	 * Extracts UNIQUE constraints from AST column and table constraint definitions.
	 * Resolves column names to indices.
	 */
	private extractUniqueConstraints(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined,
		columnIndexMap: ReadonlyMap<string, number>,
	): UniqueConstraintSchema[] {
		const result: UniqueConstraintSchema[] = [];

		// Column-level unique constraints
		for (const colDef of astColumns) {
			for (const con of colDef.constraints ?? []) {
				if (con.type === 'unique') {
					const colIndex = columnIndexMap.get(colDef.name.toLowerCase());
					if (colIndex !== undefined) {
						result.push({
							name: con.name,
							columns: Object.freeze([colIndex]),
							defaultConflict: con.onConflict,
							tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
						});
					}
				}
			}
		}

		// Table-level unique constraints — delegate to the shared builder (DRY with
		// the module `ADD CONSTRAINT` path).
		for (const con of astConstraints ?? []) {
			if (con.type === 'unique' && con.columns && con.columns.length > 0) {
				result.push(buildUniqueConstraintSchema(con, columnIndexMap));
			}
		}

		return result;
	}

	/**
	 * Builds a base TableSchema from an AST CREATE TABLE statement.
	 * Shared by both createTable (new storage) and importTable (existing storage).
	 */
	private buildTableSchemaFromAST(
		stmt: AST.CreateTableStmt,
		moduleName: string,
		effectiveModuleArgs: Readonly<Record<string, SqlValue>>,
		moduleInfo: { module: AnyVirtualTableModule; auxData?: unknown }
	): TableSchema {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;

		const defaultNullability = this.db.options.getStringOption('default_column_nullability');
		const defaultNotNull = defaultNullability === 'not_null';

		const astColumns = stmt.columns || [];
		const { columns, pkDefinition, pkDefaultConflict } = this.buildColumnSchemas(astColumns, stmt.constraints, defaultNotNull);
		const checkConstraints = this.extractCheckConstraints(astColumns, stmt.constraints);
		const columnIndexMap = buildColumnIndexMap(columns);
		const foreignKeys = this.extractForeignKeys(astColumns, stmt.constraints, columnIndexMap, tableName, targetSchemaName);
		const uniqueConstraints = this.extractUniqueConstraints(astColumns, stmt.constraints, columnIndexMap);

		const mutationContextSchemas: MutationContextDefinition[] | undefined = stmt.contextDefinitions
			? stmt.contextDefinitions.map(varDef => mutationContextVarToSchema(varDef, defaultNotNull))
			: undefined;

		// Extract generated-column dependencies and validate that they form a DAG.
		// Cycle detection runs before module.create so an invalid schema never
		// reaches storage.
		const rawGenDeps = extractGeneratedColumnDependencies(columns, tableName);
		const genTopoOrder = rawGenDeps.size > 0
			? topoSortGeneratedColumns(columns, rawGenDeps)
			: undefined;
		const generatedColumnDependencies = rawGenDeps.size > 0
			? Object.freeze(new Map(
				Array.from(rawGenDeps.entries()).map(
					([k, v]) => [k, Object.freeze(v)] as const,
				),
			))
			: undefined;

		return {
			name: tableName,
			schemaName: targetSchemaName,
			columns: Object.freeze(columns),
			columnIndexMap,
			primaryKeyDefinition: pkDefinition,
			primaryKeyDefaultConflict: pkDefaultConflict,
			checkConstraints: Object.freeze(checkConstraints),
			foreignKeys: foreignKeys.length > 0 ? Object.freeze(foreignKeys) : undefined,
			uniqueConstraints: uniqueConstraints.length > 0 ? Object.freeze(uniqueConstraints) : undefined,
			isView: false,
			vtabModuleName: moduleName,
			vtabArgs: effectiveModuleArgs,
			vtabModule: moduleInfo.module,
			vtabAuxData: moduleInfo.auxData,
			estimatedRows: 0,
			mutationContext: mutationContextSchemas ? Object.freeze(mutationContextSchemas) : undefined,
			generatedColumnDependencies,
			generatedColumnTopoOrder: genTopoOrder ? Object.freeze(genTopoOrder) : undefined,
			tags: stmt.tags && Object.keys(stmt.tags).length > 0 ? Object.freeze({ ...stmt.tags }) : undefined,
		};
	}

	/**
	 * Builds a **logical** TableSchema spec from a declared CREATE TABLE AST,
	 * for use as the `logicalTable` of a lens slot (see `schema/lens.ts`).
	 *
	 * Reuses the same column / PK / constraint extraction as a physical table
	 * (so the spec is a faithful design), but carries **no** `vtabModule`
	 * (`vtabModuleName: ''`, `isLogical: true`) — a logical table is never
	 * registered or executed; its compiled effective body is registered as a
	 * `ViewSchema`. Module association / indexes / storage are rejected upstream
	 * by the lens compiler before this is called.
	 */
	buildLogicalTableSchema(stmt: AST.CreateTableStmt, schemaName: string): TableSchema {
		const tableName = stmt.table.name;
		const defaultNullability = this.db.options.getStringOption('default_column_nullability');
		const defaultNotNull = defaultNullability === 'not_null';

		const astColumns = stmt.columns || [];
		const { columns, pkDefinition, pkDefaultConflict } = this.buildColumnSchemas(astColumns, stmt.constraints, defaultNotNull);
		const checkConstraints = this.extractCheckConstraints(astColumns, stmt.constraints);
		const columnIndexMap = buildColumnIndexMap(columns);
		const foreignKeys = this.extractForeignKeys(astColumns, stmt.constraints, columnIndexMap, tableName, schemaName);
		const uniqueConstraints = this.extractUniqueConstraints(astColumns, stmt.constraints, columnIndexMap);

		return {
			name: tableName,
			schemaName,
			columns: Object.freeze(columns),
			columnIndexMap,
			primaryKeyDefinition: pkDefinition,
			primaryKeyDefaultConflict: pkDefaultConflict,
			checkConstraints: Object.freeze(checkConstraints),
			foreignKeys: foreignKeys.length > 0 ? Object.freeze(foreignKeys) : undefined,
			uniqueConstraints: uniqueConstraints.length > 0 ? Object.freeze(uniqueConstraints) : undefined,
			isView: false,
			isLogical: true,
			// Logical tables carry no module — they are a design, not storage.
			vtabModule: undefined,
			vtabModuleName: '',
			estimatedRows: 0,
			tags: stmt.tags && Object.keys(stmt.tags).length > 0 ? Object.freeze({ ...stmt.tags }) : undefined,
		};
	}

	/**
	 * Walks an expression AST and rejects bind-parameter and (optionally)
	 * column-reference nodes. Used by DDL-time DEFAULT/CHECK validators where
	 * such references are illegal even though they may otherwise build cleanly.
	 *
	 * Throws a QuereusError on the first offending node, with a message
	 * produced by the supplied formatters.
	 */
	private rejectIllegalReferences(
		expr: AST.AstNode,
		options: {
			rejectColumns: boolean;
			formatParamError: () => string;
			formatColumnError?: () => string;
		}
	): void {
		let offendingType: 'parameter' | 'column' | undefined;
		// A column reference nested inside a subquery is scoped to that subquery's own
		// FROM, not the row being inserted, so it is not an illegal sibling-row
		// reference — only top-level (depth-0) columns are. This is what lets a DEFAULT
		// author a self-referencing allocator like
		// `coalesce((select max(rid) from t), 0) + mutation_ordinal()` (the
		// shared-key-via-default surrogate recipe — docs/view-updateability.md
		// § Mutation Context). Parameters stay rejected at any depth.
		let subqueryDepth = 0;
		const isQueryBoundary = (node: AST.AstNode): boolean =>
			node.type === 'select' || node.type === 'subquery' || node.type === 'exists';
		traverseAst(expr, {
			enterNode: (node: AST.AstNode) => {
				if (offendingType) return false;
				if (node.type === 'parameter') {
					offendingType = 'parameter';
					return false;
				}
				if (options.rejectColumns && node.type === 'column' && subqueryDepth === 0) {
					// `new.<column>` is an explicit, legal read of a value the INSERT
					// supplies for a sibling column (resolved against the row scope at
					// INSERT time); only a bare (unqualified) column is the illegal
					// sibling reference rejected here.
					if ((node as AST.ColumnExpr).table?.toLowerCase() !== 'new') {
						offendingType = 'column';
						return false;
					}
				}
				if (isQueryBoundary(node)) subqueryDepth += 1;
			},
			exitNode: (node: AST.AstNode) => {
				if (isQueryBoundary(node)) subqueryDepth -= 1;
			},
		});
		if (offendingType === 'parameter') {
			throw new QuereusError(options.formatParamError(), StatusCode.ERROR);
		}
		if (offendingType === 'column') {
			throw new QuereusError(options.formatColumnError!(), StatusCode.ERROR);
		}
	}

	/**
	 * Validates that all DEFAULT expressions in the column schemas are
	 * deterministic and free of bind parameters or (when no mutation
	 * context is defined) column references. Bind parameters and column
	 * references are rejected up-front via an AST pre-walk so the error
	 * messages stay specific (rather than degrading into "column not
	 * found" during expression building).
	 *
	 * When `hasMutationContext` is true, column-style identifiers are
	 * preserved because they may resolve to mutation-context variables at
	 * INSERT time (the AST cannot distinguish a real column from a
	 * context variable, and the build attempt is permitted to fail —
	 * scope resolution is deferred to row-time).
	 */
	/** True when a DEFAULT expression embeds a subquery (scalar subquery / EXISTS / SELECT). */
	private defaultEmbedsSubquery(expr: AST.AstNode): boolean {
		let found = false;
		traverseAst(expr, {
			enterNode: (node: AST.AstNode) => {
				if (node.type === 'select' || node.type === 'subquery' || node.type === 'exists') {
					found = true;
					return false;
				}
			},
		});
		return found;
	}

	/** True when a DEFAULT expression reads the row being written via `new.<column>`. */
	private defaultReferencesNewRow(expr: AST.AstNode): boolean {
		let found = false;
		traverseAst(expr, {
			enterNode: (node: AST.AstNode) => {
				if (found) return false;
				if (node.type === 'column' && (node as AST.ColumnExpr).table?.toLowerCase() === 'new') {
					found = true;
					return false;
				}
			},
		});
		return found;
	}

	/**
	 * Build the throwaway planning context (global + parameter scope, no table/row
	 * scope) used to compile a DEFAULT expression for DDL-time validation. The table's
	 * columns are intentionally absent so a bare-column reference fails to build —
	 * which the bare-column pre-walk has already rejected for the strict case, and
	 * which the deferral path tolerates for `new.`/subquery/mutation-context defaults.
	 */
	private makeDdlValidationContext(): PlanningContext {
		const globalScope = new GlobalScope(this.db.schemaManager);
		const parameterScope = new ParameterScope(globalScope);
		return {
			db: this.db,
			schemaManager: this.db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map()
		};
	}

	/**
	 * Validate a single DEFAULT expression — the per-default core of
	 * {@link validateDefaultDeterminism}, factored out so the ALTER COLUMN SET DEFAULT
	 * path ({@link validateAlterColumnDefault}) routes through the identical checks:
	 * bind parameters and (absent a mutation context) bare columns rejected up front,
	 * non-determinism rejected unless `allowNonDeterministic`, and a `new.<column>` /
	 * subquery / mutation-context default deferred to INSERT time (it cannot build
	 * here without the row/table scope; determinism is re-checked when the row scope
	 * is established).
	 */
	private validateOneDefault(
		planningCtx: PlanningContext,
		defaultValue: AST.Expression,
		columnName: string,
		tableName: string,
		hasMutationContext: boolean,
		allowNonDeterministic: boolean,
		ddlPhase: string,
	): void {
		this.rejectIllegalReferences(defaultValue as AST.AstNode, {
			rejectColumns: !hasMutationContext,
			formatParamError: () =>
				`DEFAULT for column '${columnName}' in table '${tableName}' may not reference bind parameters.`,
			formatColumnError: () =>
				`DEFAULT for column '${columnName}' in table '${tableName}' may not reference a bare column; use 'new.<column>' to read a value supplied by the INSERT, or a generated column instead.`,
		});

		let defaultExpr: ScalarPlanNode | undefined;
		// A DEFAULT that embeds a subquery may forward-reference the table being
		// created (a self-referencing allocator — `select max(rid) from t` on `t`):
		// the table is not yet registered here, so the build legitimately fails.
		// A DEFAULT that reads `new.<column>` resolves only against the row scope
		// established at INSERT time, so it likewise cannot build here. Either way
		// determinism is re-checked at INSERT time (both the single-source insert
		// expansion and the shared-key envelope re-validate the compiled default),
		// so defer rather than reject. Other build failures (a typo'd function /
		// bare column) stay strict.
		const defaultEmbedsSubquery = this.defaultEmbedsSubquery(defaultValue as AST.AstNode);
		const defaultReferencesNewRow = this.defaultReferencesNewRow(defaultValue as AST.AstNode);
		try {
			defaultExpr = buildExpression(planningCtx, defaultValue) as ScalarPlanNode;
		} catch (e) {
			if (hasMutationContext || defaultEmbedsSubquery || defaultReferencesNewRow) {
				// Column-style identifiers in DEFAULT may resolve to mutation
				// context variables at INSERT time; a subquery may forward-reference
				// the table being created; `new.<column>` resolves against the INSERT
				// row scope. The row/table scope isn't available here, so a build
				// failure isn't necessarily a bug. Determinism is re-checked at
				// INSERT time.
				log('Skipping determinism validation for default on column %s.%s at %s time (deferred to INSERT%s): %s',
					tableName, columnName, ddlPhase,
					hasMutationContext ? ', mutation context present' : defaultEmbedsSubquery ? ', embeds subquery' : ', references new row',
					(e as Error).message);
			} else {
				const message = e instanceof Error ? e.message : String(e);
				const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
				throw new QuereusError(
					`DEFAULT for column '${columnName}' in table '${tableName}' is invalid: ${message}`,
					code,
					e instanceof Error ? e : undefined
				);
			}
		}

		if (!defaultExpr) return;

		if (allowNonDeterministic) return;

		const result = checkDeterministic(defaultExpr);
		if (!result.valid) {
			throw new QuereusError(
				`Non-deterministic expression not allowed in DEFAULT for column '${columnName}' in table '${tableName}'. ` +
				`Expression: ${result.expression}. ` +
				`Use mutation context to pass non-deterministic values (e.g., WITH CONTEXT (timestamp = datetime('now'))).`,
				StatusCode.ERROR
			);
		}
	}

	private validateDefaultDeterminism(
		columns: ReadonlyArray<ColumnSchema>,
		tableName: string,
		hasMutationContext: boolean,
		allowNonDeterministic: boolean = false
	): void {
		const planningCtx = this.makeDdlValidationContext();

		for (const col of columns) {
			if (!col.defaultValue || typeof col.defaultValue !== 'object' || col.defaultValue === null || !('type' in col.defaultValue)) {
				continue;
			}
			this.validateOneDefault(
				planningCtx,
				col.defaultValue as AST.Expression,
				col.name,
				tableName,
				hasMutationContext,
				allowNonDeterministic,
				'CREATE TABLE',
			);
		}
	}

	/**
	 * Validate a DEFAULT expression supplied by an `ALTER COLUMN … SET DEFAULT`,
	 * routing it through the same checks CREATE TABLE applies so the stored default is
	 * consistent with what INSERT will accept: bind parameters and (absent a mutation
	 * context) bare columns are rejected, non-determinism is rejected unless the
	 * `nondeterministic_schema` option is set, and a `new.<column>` default is accepted
	 * with the build/determinism check deferred to INSERT time. DROP DEFAULT (a null
	 * expression) never reaches here. Called from the ALTER TABLE runtime emitter.
	 */
	validateAlterColumnDefault(
		defaultExpr: AST.Expression,
		columnName: string,
		tableName: string,
		hasMutationContext: boolean,
	): void {
		this.validateDdlDefault(defaultExpr, columnName, tableName, hasMutationContext, 'ALTER COLUMN SET DEFAULT');
	}

	/**
	 * Validate a DEFAULT supplied by `ALTER TABLE ADD COLUMN`, routing it through the
	 * same checks CREATE TABLE / ALTER COLUMN apply so the stored default is consistent
	 * with what INSERT (and the per-row backfill) will accept: bind parameters and
	 * (absent a mutation context) bare columns are rejected, non-determinism is rejected
	 * unless `nondeterministic_schema` is set, and a `new.<column>` default is accepted
	 * with its build deferred — it reads the existing row's sibling during backfill and
	 * the INSERT-supplied sibling for future inserts. Called from the ALTER TABLE
	 * statement builder (`buildAlterTableStmt`) at plan-build time.
	 */
	validateAddColumnDefault(
		defaultExpr: AST.Expression,
		columnName: string,
		tableName: string,
		hasMutationContext: boolean,
	): void {
		this.validateDdlDefault(defaultExpr, columnName, tableName, hasMutationContext, 'ALTER TABLE ADD COLUMN');
	}

	/** Shared body for the ALTER-time DEFAULT validators (ALTER COLUMN SET DEFAULT / ADD COLUMN). */
	private validateDdlDefault(
		defaultExpr: AST.Expression,
		columnName: string,
		tableName: string,
		hasMutationContext: boolean,
		ddlPhase: string,
	): void {
		const allowNonDet = this.db.options.getBooleanOption('nondeterministic_schema');
		this.validateOneDefault(
			this.makeDdlValidationContext(),
			defaultExpr,
			columnName,
			tableName,
			hasMutationContext,
			allowNonDet,
			ddlPhase,
		);
	}

	/**
	 * Validates that CHECK constraint expressions don't call non-deterministic
	 * functions and don't reference bind parameters. Walks the AST and looks
	 * up each function call against the registry; raises if any function
	 * lacks the DETERMINISTIC flag. Avoids the full planning pipeline because
	 * CHECK expressions reference table columns whose scope is not yet
	 * established at CREATE TABLE time.
	 */
	private validateCheckConstraintDeterminism(
		checkConstraints: ReadonlyArray<RowConstraintSchema>,
		tableName: string,
		allowNonDeterministic: boolean = false
	): void {
		for (const cc of checkConstraints) {
			const constraintName = cc.name ?? `_check_${tableName}`;

			this.rejectIllegalReferences(cc.expr as AST.AstNode, {
				rejectColumns: false,
				formatParamError: () =>
					`CHECK constraint '${constraintName}' on table '${tableName}' may not reference bind parameters.`,
			});

			if (allowNonDeterministic) continue;

			let offendingExpr: AST.FunctionExpr | undefined;
			traverseAst(cc.expr as AST.AstNode, {
				enterNode: (node: AST.AstNode) => {
					if (offendingExpr) return false;
					if (node.type !== 'function') return;
					const fnNode = node as AST.FunctionExpr;
					const argCount = fnNode.args?.length ?? 0;
					const funcSchema = this.findFunction(fnNode.name, argCount)
						?? this.findFunction(fnNode.name, -1);
					if (funcSchema && (funcSchema.flags & FunctionFlags.DETERMINISTIC) === 0) {
						offendingExpr = fnNode;
						return false;
					}
				},
			});
			if (offendingExpr) {
				throw new QuereusError(
					`Non-deterministic expression not allowed in CHECK constraint '${constraintName}' on table '${tableName}'. ` +
					`Function '${offendingExpr.name}' is not deterministic. ` +
					`Use mutation context to pass non-deterministic values (e.g., WITH CONTEXT (timestamp = datetime('now'))).`,
					StatusCode.ERROR
				);
			}
		}
	}

	/**
	 * Registers a table schema after module.create() returns, correcting
	 * name/schema if the module returned different values.
	 */
	private finalizeCreatedTableSchema(
		tableInstance: VirtualTable,
		tableName: string,
		targetSchemaName: string,
		moduleName: string,
		effectiveModuleArgs: Readonly<Record<string, SqlValue>>,
		moduleInfo: { module: AnyVirtualTableModule; auxData?: unknown }
	): TableSchema {
		const finalRegisteredSchema = tableInstance.tableSchema;
		if (!finalRegisteredSchema) {
			throw new QuereusError(`Module '${moduleName}' create did not provide a tableSchema for '${tableName}'.`, StatusCode.INTERNAL);
		}

		let correctedSchema = finalRegisteredSchema;
		if (finalRegisteredSchema.name.toLowerCase() !== tableName.toLowerCase() ||
			finalRegisteredSchema.schemaName.toLowerCase() !== targetSchemaName.toLowerCase()) {
			warnLog(`Module ${moduleName} returned schema for ${finalRegisteredSchema.schemaName}.${finalRegisteredSchema.name} but expected ${targetSchemaName}.${tableName}. Correcting name/schemaName.`);
			correctedSchema = {
				...finalRegisteredSchema,
				name: tableName,
				schemaName: targetSchemaName,
			};
		}

		return {
			...correctedSchema,
			vtabModuleName: moduleName,
			vtabArgs: effectiveModuleArgs,
			vtabModule: moduleInfo.module,
			vtabAuxData: moduleInfo.auxData,
			estimatedRows: correctedSchema.estimatedRows ?? 0,
		};
	}

	/**
	 * Creates a new index on an existing table based on an AST.CreateIndexStmt.
	 *
	 * @param stmt The AST node for the CREATE INDEX statement.
	 * @throws QuereusError on errors (e.g., table not found, column not found, createIndex fails).
	 */
	async createIndex(stmt: AST.CreateIndexStmt): Promise<void> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;
		const indexName = stmt.index.name;

		const tableSchema = this.getTable(targetSchemaName, tableName);
		if (!tableSchema) {
			throw new QuereusError(`no such table: ${tableName}`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		const vtabModule = requireVtabModule(tableSchema);
		if (!vtabModule.createIndex) {
			throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' for table '${tableName}' does not support CREATE INDEX.`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		const existingIndex = tableSchema.indexes?.find(idx => idx.name.toLowerCase() === indexName.toLowerCase());
		if (existingIndex) {
			if (stmt.ifNotExists) {
				log(`Skipping CREATE INDEX: Index %s.%s already exists (IF NOT EXISTS).`, targetSchemaName, indexName);
				return;
			}
			throw new QuereusError(`Index ${indexName} already exists on table ${tableName}`, StatusCode.CONSTRAINT, undefined, stmt.index.loc?.start.line, stmt.index.loc?.start.column);
		}

		const indexSchema = this.buildIndexSchema(stmt, tableSchema, tableName, indexName);

		try {
			await vtabModule.createIndex(this.db, targetSchemaName, tableName, indexSchema);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
			throw new QuereusError(`createIndex failed for index '${indexName}' on table '${tableName}': ${message}`, code, e instanceof Error ? e : undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		const updatedTableSchema = appendIndexToTableSchema(tableSchema, indexSchema);
		const schema = this.getSchemaOrFail(targetSchemaName);
		schema.addTable(updatedTableSchema);

		this.changeNotifier.notifyChange({
			type: 'table_modified',
			schemaName: targetSchemaName,
			objectName: tableName,
			oldObject: tableSchema,
			newObject: updatedTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(tableSchema.vtabModuleName, {
			type: 'create',
			objectType: 'index',
			schemaName: targetSchemaName,
			objectName: indexName,
		});

		log(`Successfully created index %s on table %s.%s`, indexName, targetSchemaName, tableName);
	}

	/**
	 * Builds an IndexSchema from AST column definitions, validating against the table schema.
	 */
	private buildIndexSchema(
		stmt: AST.CreateIndexStmt,
		tableSchema: TableSchema,
		tableName: string,
		indexName: string
	): IndexSchema {
		const indexColumns = stmt.columns.map((indexedCol: AST.IndexedColumn) => {
			// The parser folds `col COLLATE x` into a collate expression over a bare
			// column reference; resolveImportedIndexColumn unwraps that form to a
			// { name, collation } pair, mirroring importIndex. A genuine expression
			// index (non-column operand) resolves to an unset name and is rejected.
			const { name: colName, collation } = resolveImportedIndexColumn(indexedCol);
			if (!colName) {
				throw new QuereusError(`Indices on expressions are not supported yet.`, StatusCode.ERROR, undefined, indexedCol.expr?.loc?.start.line, indexedCol.expr?.loc?.start.column);
			}
			const tableColIndex = tableSchema.columnIndexMap.get(colName.toLowerCase());
			if (tableColIndex === undefined) {
				throw new QuereusError(`Column '${colName}' not found in table '${tableName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
			const tableColSchema = tableSchema.columns[tableColIndex];
			return {
				index: tableColIndex,
				desc: indexedCol.direction === 'desc',
				collation: normalizeCollationName(collation || tableColSchema.collation || 'BINARY')
			};
		});

		return {
			name: indexName,
			columns: Object.freeze(indexColumns),
			unique: stmt.isUnique || undefined,
			predicate: stmt.where,
			tags: stmt.tags && Object.keys(stmt.tags).length > 0 ? Object.freeze({ ...stmt.tags }) : undefined,
		};
	}

	/**
	 * Drops a secondary index from the table that owns it.
	 * Searches all tables in the target schema to find the owning table.
	 *
	 * @param schemaName The schema to search in (e.g., "main")
	 * @param indexName The name of the index to drop
	 * @param ifExists If true, silently return if the index is not found
	 */
	async dropIndex(schemaName: string, indexName: string, ifExists: boolean = false): Promise<void> {
		const schema = this.getSchema(schemaName);
		if (!schema) {
			if (ifExists) return;
			throw new QuereusError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}

		// Find which table owns this index
		const lowerIndexName = indexName.toLowerCase();
		let ownerTable: TableSchema | undefined;
		for (const table of schema.getAllTables()) {
			if (table.indexes?.some(idx => idx.name.toLowerCase() === lowerIndexName)) {
				ownerTable = table;
				break;
			}
		}

		if (!ownerTable) {
			if (ifExists) {
				log(`Index %s.%s not found, but IF EXISTS specified`, schemaName, indexName);
				return;
			}
			throw new QuereusError(`no such index: ${indexName}`, StatusCode.ERROR);
		}

		// Call module.dropIndex if the module supports it
		const moduleReg = ownerTable.vtabModuleName ? this.getModule(ownerTable.vtabModuleName) : undefined;
		if (moduleReg?.module?.dropIndex) {
			try {
				await moduleReg.module.dropIndex(this.db, schemaName, ownerTable.name, indexName);
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
				throw new QuereusError(
					`dropIndex failed for index '${indexName}' on table '${ownerTable.name}': ${message}`,
					code, e instanceof Error ? e : undefined
				);
			}
		}

		// Remove the index from the table schema, along with any uniqueConstraint
		// that was synthesized from this index (see appendIndexToTableSchema).
		const updatedIndexes = (ownerTable.indexes || []).filter(
			idx => idx.name.toLowerCase() !== lowerIndexName
		);
		const updatedUniqueConstraints = (ownerTable.uniqueConstraints ?? []).filter(
			uc => uc.derivedFromIndex?.toLowerCase() !== lowerIndexName
		);
		const updatedTableSchema: TableSchema = {
			...ownerTable,
			indexes: Object.freeze(updatedIndexes),
			uniqueConstraints: updatedUniqueConstraints.length > 0
				? Object.freeze(updatedUniqueConstraints)
				: undefined,
		};
		schema.addTable(updatedTableSchema);

		this.changeNotifier.notifyChange({
			type: 'table_modified',
			schemaName,
			objectName: ownerTable.name,
			oldObject: ownerTable,
			newObject: updatedTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(ownerTable.vtabModuleName, {
			type: 'drop',
			objectType: 'index',
			schemaName,
			objectName: indexName,
		});

		log(`Successfully dropped index %s from table %s.%s`, indexName, schemaName, ownerTable.name);
	}

	/**
	 * Emits an auto schema event for modules that don't have native event support,
	 * if any schema listeners are registered.
	 */
	private emitAutoSchemaEventIfNeeded(
		moduleName: string | undefined,
		event: VTableSchemaChangeEvent
	): void {
		const moduleReg = moduleName ? this.getModule(moduleName) : undefined;
		if (this.db.hasSchemaListeners() && !hasNativeEventSupport(moduleReg?.module)) {
			this.db._getEventEmitter().emitAutoSchemaEvent(moduleName ?? 'memory', event);
		}
	}

	/**
	 * Defines a new table in the schema based on an AST.CreateTableStmt.
	 * Interacts with VTab modules (create) and registers the new table schema.
	 *
	 * @param stmt The AST node for the CREATE TABLE statement.
	 * @returns A Promise that resolves to the created TableSchema.
	 * @throws QuereusError on errors (e.g., module not found, create fails, table exists).
	 */
	async createTable(stmt: AST.CreateTableStmt): Promise<TableSchema> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;

		const schema = this.getSchema(targetSchemaName);
		if (!schema) {
			throw new QuereusError(`Internal error: Schema '${targetSchemaName}' not found.`, StatusCode.INTERNAL);
		}

		const seenColumnNames = new Set<string>();
		for (const col of stmt.columns) {
			const lower = col.name.toLowerCase();
			if (seenColumnNames.has(lower)) {
				throw new QuereusError(`Duplicate column name: ${col.name}`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
			}
			seenColumnNames.add(lower);
		}

		const existingTable = schema.getTable(tableName);
		const existingView = schema.getView(tableName);

		if (existingTable || existingView) {
			if (stmt.ifNotExists) {
				log(`Skipping CREATE TABLE: Item %s.%s already exists (IF NOT EXISTS).`, targetSchemaName, tableName);
				if (existingTable) return existingTable;
				throw new QuereusError(`Cannot CREATE TABLE ${targetSchemaName}.${tableName}: a VIEW with the same name already exists.`, StatusCode.CONSTRAINT, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
			}
			const itemType = existingTable ? 'Table' : 'View';
			throw new QuereusError(`${itemType} ${targetSchemaName}.${tableName} already exists`, StatusCode.CONSTRAINT, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		const { moduleName, effectiveModuleArgs, moduleInfo } = this.resolveModuleInfo(stmt);
		const baseTableSchema = this.buildTableSchemaFromAST(stmt, moduleName, effectiveModuleArgs, moduleInfo);

		const hasMutationContext = !!baseTableSchema.mutationContext && baseTableSchema.mutationContext.length > 0;
		// `nondeterministic_schema = true` lifts the strict-rejection gate at CREATE TABLE.
		// The captured artifact at the vtab.update() frontier is fully resolved per row, so
		// defaults / CHECKs / generated columns containing non-determinism remain replay-safe
		// (see docs/architecture.md § Constraints and docs/module-authoring.md § Mutation Statements).
		// The bind-parameter / column-reference pre-walks inside the validators still run
		// in both modes — those are scope checks, not determinism checks.
		const allowNonDet = this.db.options.getBooleanOption('nondeterministic_schema');
		this.validateDefaultDeterminism(baseTableSchema.columns, tableName, hasMutationContext, allowNonDet);
		this.validateCheckConstraintDeterminism(baseTableSchema.checkConstraints, tableName, allowNonDet);

		let tableInstance: VirtualTable;
		try {
			tableInstance = await moduleInfo.module.create(this.db, baseTableSchema);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
			throw new QuereusError(`Module '${moduleName}' create failed for table '${tableName}': ${message}`, code, e instanceof Error ? e : undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		const completeTableSchema = this.finalizeCreatedTableSchema(
			tableInstance, tableName, targetSchemaName, moduleName, effectiveModuleArgs, moduleInfo
		);

		schema.addTable(completeTableSchema);
		log(`Successfully created table %s.%s using module %s`, targetSchemaName, tableName, moduleName);

		this.changeNotifier.notifyChange({
			type: 'table_added',
			schemaName: targetSchemaName,
			objectName: tableName,
			newObject: completeTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(moduleName, {
			type: 'create',
			objectType: 'table',
			schemaName: targetSchemaName,
			objectName: tableName,
		});

		return completeTableSchema;
	}

	/**
	 * Creates a backing table from a pre-built `TableSchema` rather than a
	 * CREATE TABLE AST. Used by materialized views, whose backing-table columns
	 * and primary key are derived from the optimized body relation (carrying
	 * full {@link import('../common/datatype.js').ScalarType} fidelity that a
	 * round-trip through SQL type strings would lose).
	 *
	 * Reuses the same internal sequence as {@link createTable} — `module.create`
	 * → `finalizeCreatedTableSchema` → `addTable` → `table_added` notify — so the
	 * backing table behaves like any other table. The supplied schema must carry
	 * `vtabModule`/`vtabModuleName` (typically `memory`).
	 */
	async createBackingTable(tableSchema: TableSchema): Promise<TableSchema> {
		const targetSchemaName = tableSchema.schemaName;
		const tableName = tableSchema.name;

		const schema = this.getSchema(targetSchemaName);
		if (!schema) {
			throw new QuereusError(`Internal error: Schema '${targetSchemaName}' not found.`, StatusCode.INTERNAL);
		}

		if (schema.getTable(tableName) || schema.getView(tableName)) {
			throw new QuereusError(`Backing table ${targetSchemaName}.${tableName} already exists`, StatusCode.CONSTRAINT);
		}

		const moduleName = tableSchema.vtabModuleName;
		const moduleInfo = this.getModule(moduleName);
		if (!moduleInfo || !moduleInfo.module) {
			throw new QuereusError(`No virtual table module named '${moduleName}'`, StatusCode.ERROR);
		}

		let tableInstance: VirtualTable;
		try {
			tableInstance = await moduleInfo.module.create(this.db, tableSchema);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
			throw new QuereusError(`Module '${moduleName}' create failed for backing table '${tableName}': ${message}`, code, e instanceof Error ? e : undefined);
		}

		const completeTableSchema = this.finalizeCreatedTableSchema(
			tableInstance, tableName, targetSchemaName, moduleName, tableSchema.vtabArgs ?? {}, moduleInfo
		);

		schema.addTable(completeTableSchema);
		log(`Successfully created backing table %s.%s using module %s`, targetSchemaName, tableName, moduleName);

		this.changeNotifier.notifyChange({
			type: 'table_added',
			schemaName: targetSchemaName,
			objectName: tableName,
			newObject: completeTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(moduleName, {
			type: 'create',
			objectType: 'table',
			schemaName: targetSchemaName,
			objectName: tableName,
		});

		return completeTableSchema;
	}

	/**
	 * Import catalog objects from DDL statements without triggering storage creation.
	 * Used when connecting to existing storage that already contains data.
	 *
	 * This method:
	 * 1. Parses each DDL statement
	 * 2. Registers the schema objects (tables, indexes)
	 * 3. Calls module.connect() instead of module.create()
	 * 4. Skips schema change hooks (since these are existing objects)
	 *
	 * Each DDL string may hold **one or more** statements: a catalog entry can
	 * bundle a `CREATE TABLE` immediately followed by the `CREATE INDEX`es that
	 * belong to it. Statements within an entry are imported in document order, so
	 * a table always precedes the indexes that reference it. (Because every
	 * table's indexes are co-located with it in one entry, no global
	 * table-before-index ordering across entries is required.)
	 *
	 * @param ddlStatements Array of DDL strings (each one or more CREATE TABLE / CREATE INDEX, etc.)
	 * @returns Array of imported object names
	 */
	async importCatalog(ddlStatements: string[]): Promise<{ tables: string[]; indexes: string[] }> {
		const imported = { tables: [] as string[], indexes: [] as string[] };

		for (const ddl of ddlStatements) {
			try {
				for (const result of await this.importDDL(ddl)) {
					if (result.type === 'table') {
						imported.tables.push(result.name);
					} else {
						imported.indexes.push(result.name);
					}
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				errorLog('Failed to import DDL: %s - Error: %s', ddl.substring(0, 100), message);
				throw e;
			}
		}

		log('Imported catalog: %d tables, %d indexes', imported.tables.length, imported.indexes.length);
		return imported;
	}

	/**
	 * Import every statement in a DDL string without creating storage, in document
	 * order. A single string may carry several statements (a table bundled with
	 * its indexes); single-statement entries remain valid. Any unsupported
	 * statement type throws — `rehydrateCatalog` relies on this fail-loud contract
	 * to record import errors rather than silently dropping objects.
	 */
	private async importDDL(ddl: string): Promise<Array<{ type: 'table' | 'index'; name: string }>> {
		const parser = new Parser();
		const statements = parser.parseAll(ddl);

		const results: Array<{ type: 'table' | 'index'; name: string }> = [];
		for (const stmt of statements) {
			if (stmt.type === 'createTable') {
				results.push(await this.importTable(stmt as AST.CreateTableStmt));
			} else if (stmt.type === 'createIndex') {
				results.push(await this.importIndex(stmt as AST.CreateIndexStmt));
			} else {
				throw new QuereusError(`importCatalog does not support statement type: ${stmt.type}`, StatusCode.ERROR);
			}
		}
		return results;
	}

	/**
	 * Import a table schema without calling module.create().
	 * Uses module.connect() to bind to existing storage.
	 */
	private async importTable(stmt: AST.CreateTableStmt): Promise<{ type: 'table'; name: string }> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;

		const { moduleName, effectiveModuleArgs, moduleInfo } = this.resolveModuleInfo(stmt);
		const tableSchema = this.buildTableSchemaFromAST(stmt, moduleName, effectiveModuleArgs, moduleInfo);

		try {
			await moduleInfo.module.connect(
				this.db,
				moduleInfo.auxData,
				moduleName,
				targetSchemaName,
				tableName,
				effectiveModuleArgs,
				tableSchema
			);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Module '${moduleName}' connect failed during import for table '${tableName}': ${message}`, StatusCode.ERROR);
		}

		let schema = this.getSchema(targetSchemaName);
		if (!schema) {
			const lowerSchemaName = targetSchemaName.toLowerCase();
			schema = new Schema(lowerSchemaName);
			this.schemas.set(lowerSchemaName, schema);
		}

		schema.addTable(tableSchema);
		log(`Imported table %s.%s using module %s`, targetSchemaName, tableName, moduleName);

		return { type: 'table', name: `${targetSchemaName}.${tableName}` };
	}

	/**
	 * Import an index schema without calling module.createIndex().
	 *
	 * Reconstructs the index with full fidelity from the re-parsed DDL so a
	 * `CREATE [UNIQUE] INDEX ... (col [COLLATE x]) [WHERE ...]` survives a
	 * catalog round-trip: per-column collation, the UNIQUE flag, the partial
	 * predicate, and (for a unique index) the synthesized `derivedFromIndex`
	 * UNIQUE constraint — mirroring the live `buildIndexSchema` + the shared
	 * {@link appendIndexToTableSchema} that {@link createIndex} uses.
	 */
	private async importIndex(stmt: AST.CreateIndexStmt): Promise<{ type: 'index'; name: string }> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;
		const indexName = stmt.index.name;

		// Find the table
		const tableSchema = this.findTable(tableName, targetSchemaName);
		if (!tableSchema) {
			throw new QuereusError(`Cannot import index '${indexName}': table '${tableName}' not found`, StatusCode.ERROR);
		}

		// Build index columns schema. Mirrors buildIndexSchema's collation resolution
		// (per-column COLLATE → table column collation → BINARY).
		const indexColumns: IndexColumnSchema[] = stmt.columns.map(col => {
			const { name: colName, collation } = resolveImportedIndexColumn(col);
			if (!colName) {
				throw new QuereusError(`Expression-based index columns are not supported during import`, StatusCode.ERROR);
			}
			const colIdx = tableSchema.columnIndexMap.get(colName.toLowerCase());
			if (colIdx === undefined) {
				throw new QuereusError(`Column '${colName}' not found in table '${tableName}'`, StatusCode.ERROR);
			}
			const tableColSchema = tableSchema.columns[colIdx];
			return {
				index: colIdx,
				desc: col.direction === 'desc',
				collation: normalizeCollationName(collation || tableColSchema.collation || 'BINARY'),
			};
		});

		const indexSchema: IndexSchema = {
			name: indexName,
			columns: Object.freeze(indexColumns),
			unique: stmt.isUnique || undefined,
			predicate: stmt.where,
			tags: stmt.tags && Object.keys(stmt.tags).length > 0 ? Object.freeze({ ...stmt.tags }) : undefined,
		};

		// Append the index (and synthesize the derived UNIQUE constraint when
		// unique) without calling module.createIndex() — the storage already exists.
		const updatedTableSchema = appendIndexToTableSchema(tableSchema, indexSchema);

		const schema = this.getSchemaOrFail(targetSchemaName);
		schema.addTable(updatedTableSchema);
		log(`Imported index %s on table %s.%s`, indexName, targetSchemaName, tableName);

		return { type: 'index', name: `${targetSchemaName}.${tableName}.${indexName}` };
	}
}

/**
 * Resolves an indexed-column AST node to its underlying column name and optional
 * collation, for catalog import.
 *
 * The parser folds `col COLLATE x` into a `collate` expression wrapping a bare
 * column reference (see `indexedColumn()` in parser.ts), leaving `col.name`
 * unset. Since `generateIndexDDL` always emits an explicit `COLLATE <c>` per
 * column, *every* generated index DDL re-parses into this collate-wrapped form —
 * so unwrapping it is required for the common case, not just non-BINARY
 * collations. A genuine expression index (non-column operand) returns an unset
 * name and is rejected by the caller.
 */
function resolveImportedIndexColumn(col: AST.IndexedColumn): { name: string | undefined; collation: string | undefined } {
	// Bare column reference (`col [ASC|DESC]`) — name set directly by the parser.
	if (col.name) {
		return { name: col.name, collation: col.collation };
	}
	// Collate-wrapped column (`col COLLATE x`) — unwrap to the column + collation.
	const expr = col.expr;
	if (expr?.type === 'collate' && expr.expr.type === 'column' && !expr.expr.table && !expr.expr.schema) {
		return { name: expr.expr.name, collation: expr.collation };
	}
	// Anything else is a genuine expression index — unsupported on import.
	return { name: undefined, collation: undefined };
}
