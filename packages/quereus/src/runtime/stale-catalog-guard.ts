import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import type { Database } from '../core/database.js';
import type { ColumnSchema } from '../schema/column.js';
import type { TableSchema } from '../schema/table.js';
import type { VirtualTable } from '../vtab/table.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';

const errorLog = createLogger('runtime:stale-catalog-guard').extend('error');

/**
 * Fails a freshly connected table instance whose module reports a row layout the connecting
 * `Database`'s catalog does not describe — the state another `Database` sharing the same module
 * instance leaves behind when it ALTERs the table, since each `Database` keeps its own catalog.
 * Planning against the stale entry would read values under the wrong names and, on write, store
 * them into the wrong columns. Throws `StatusCode.SCHEMA` (after disconnecting the instance, which
 * the caller has not yet taken ownership of). See docs/schema.md § "Catalogs are per connection".
 *
 * Compares against the CURRENT catalog entry, never the plan's schema: within one `Database` the
 * same ALTER updates both the module and the catalog, whereas a plan can legitimately be older
 * than the module (a deferred constraint's frozen plan evaluated after a later ADD COLUMN in the
 * same transaction).
 *
 * No-op when the instance does not report `tableSchema` (it is optional, and some modules populate
 * it lazily), when the catalog has no entry under this name, and when the REGISTERED `module` (not
 * `vtab.module`, which a wrapper module may delegate to) has no `alterTable`: no ALTER reaches such
 * a module's layout — the one ALTER it admits, RENAME COLUMN, is applied to the engine's catalog
 * alone, so its instance keeps the create-time names by design.
 *
 * NOTE: checked at connect only. A statement already running in this `Database` when another one
 * alters the table keeps its connected instance and is not re-checked; if interleaved cross-
 * connection DDL ever needs covering, the module must re-validate per cursor, not this helper.
 */
export async function assertCatalogMatchesModule(
	db: Database,
	module: AnyVirtualTableModule,
	schemaName: string,
	tableName: string,
	vtab: VirtualTable,
): Promise<void> {
	const live = vtab.tableSchema;
	if (!live || typeof module.alterTable !== 'function') return;
	const catalog = db.schemaManager.getTable(schemaName, tableName);
	if (!catalog || catalog === live) return;

	const difference = describeRowLayoutDifference(catalog, live);
	if (difference === null) return;

	if (typeof vtab.disconnect === 'function') {
		await vtab.disconnect().catch((e: unknown) => {
			errorLog(`Error disconnecting stale instance of '${schemaName}.${tableName}': ${e}`);
		});
	}
	throw new QuereusError(
		`Table ${schemaName}.${tableName} was altered outside this connection (${difference}); `
		+ `this connection's definition of it is stale — re-open the connection`,
		StatusCode.SCHEMA,
	);
}

/**
 * The first difference between two schemas in what places a value in a row — which column slot
 * (column count, names in order, whether the column is generated) and which row (the primary
 * key) — or null when they agree.
 *
 * Everything else is deliberately NOT compared, because one `Database` legitimately lets its
 * catalog and the module's instance disagree on it:
 * - tags, statistics, aux data — informational; a tag-only ALTER must not break other connections;
 * - CHECK / FOREIGN KEY / UNIQUE and column NOT NULL — constraints; a module may present a
 *   NOT NULL it enforces outside its instance's `tableSchema` (`test/alter-add-column-delegate.spec.ts`);
 * - column type and collation — a materialized-view reshape registers a catalog preview of the
 *   types / collations it is about to land while it validates (`previewReshapedColumns`);
 * - DEFAULT — the same value-not-placement class as type.
 * Another connection's change to any of these is therefore not caught here.
 */
function describeRowLayoutDifference(stale: TableSchema, live: TableSchema): string | null {
	return describeColumnsDifference(stale.columns, live.columns)
		?? describePrimaryKeyDifference(stale, live);
}

function describeColumnsDifference(stale: ReadonlyArray<ColumnSchema>, live: ReadonlyArray<ColumnSchema>): string | null {
	if (stale === live) return null;
	if (stale.length !== live.length) {
		return `${stale.length} columns here, ${live.length} in the table`;
	}
	for (let i = 0; i < stale.length; i++) {
		const a = stale[i];
		const b = live[i];
		if (a === b) continue;
		if (a.name.toLowerCase() !== b.name.toLowerCase()) {
			return `column ${i + 1} is '${a.name}' here, '${b.name}' in the table`;
		}
		if (!!a.generated !== !!b.generated) {
			return `column '${a.name}' is ${a.generated ? '' : 'not '}generated here`;
		}
	}
	return null;
}

function describePrimaryKeyDifference(stale: TableSchema, live: TableSchema): string | null {
	const a = stale.primaryKeyDefinition;
	const b = live.primaryKeyDefinition;
	if (a === b) return null;
	const same = a.length === b.length
		&& a.every((def, i) => def.index === b[i].index && !!def.desc === !!b[i].desc);
	return same ? null : 'primary key differs';
}
