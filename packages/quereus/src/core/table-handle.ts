import type { TableSchema } from '../schema/table.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';
import { tryGetEventEmitter, type VTableEventEmitter } from '../vtab/events.js';

/**
 * Public handle to a table, obtained via {@link Database.getTable}.
 *
 * The handle is a snapshot taken at acquisition time. Its `schema` reference is
 * frozen — if the underlying table is dropped or recreated, the handle keeps
 * the original schema but no further events for that name will arrive. Callers
 * who watch schema changes should re-acquire after schema events if they need
 * fresh state.
 *
 * Instances are produced solely by {@link Database.getTable}; the constructor
 * is internal.
 */
export class Table {
	/** Schema name ('main', 'temp', or an attached schema name). */
	readonly schemaName: string;
	/** Table name (as registered, case preserved). */
	readonly tableName: string;
	/** Frozen reference to the underlying table schema for read-only inspection. */
	readonly schema: TableSchema;
	/** Module name that owns this table (e.g. `'memory'`, `'memory_events'`). */
	readonly moduleName: string;

	private readonly module: AnyVirtualTableModule;

	/** @internal */
	constructor(schema: TableSchema, moduleName: string, module: AnyVirtualTableModule) {
		this.schema = schema;
		this.schemaName = schema.schemaName;
		this.tableName = schema.name;
		this.moduleName = moduleName;
		this.module = module;
	}

	/**
	 * Returns the table's event emitter.
	 *
	 * Currently this is the **module-level** {@link VTableEventEmitter} — the
	 * same instance shared by every table that lives under the same module.
	 * Consumers must filter incoming events by `schemaName`/`tableName` if they
	 * only care about this one table.
	 *
	 * Returns `undefined` when the module does not provide an emitter. In that
	 * case, fall back to {@link Database.onDataChange} / {@link Database.onSchemaChange},
	 * which the engine populates automatically for modules without native event
	 * support.
	 *
	 * The reference is a snapshot taken at `db.getTable()` time. If the table
	 * is dropped or replaced, the emitter reference remains valid (the module
	 * outlives individual tables) but no further events for this specific table
	 * will be produced.
	 */
	getEventEmitter(): VTableEventEmitter | undefined {
		return tryGetEventEmitter(this.module);
	}
}
