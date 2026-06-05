import type { Database } from '../core/database.js';
import type { TableSchema, IndexSchema } from './table.js';
import type { ViewSchema, MaterializedViewSchema } from './view.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import { createTableToString, createViewToString, createMaterializedViewToString, createIndexToString, quoteIdentifier } from '../emit/ast-stringify.js';
import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { generateTableDDL, generateIndexDDL } from './ddl-generator.js';

/**
 * Represents a catalog snapshot of the current database schema state
 */
export interface SchemaCatalog {
	schemaName: string;
	tables: CatalogTable[];
	views: CatalogView[];
	materializedViews: CatalogMaterializedView[];
	indexes: CatalogIndex[];
	assertions: CatalogAssertion[];
}

export interface CatalogTable {
	name: string;
	ddl: string;
	columns: Array<{
		name: string;
		type: string;
		notNull: boolean;
		primaryKey: boolean;
		defaultValue: AST.Expression | null;
		/** Canonical collation (normalized, uppercase). Default `'BINARY'`. */
		collation: string;
		tags?: Readonly<Record<string, SqlValue>>;
	}>;
	primaryKey: Array<{ columnName: string; desc: boolean }>;
	/** Lowercased names of tables this table FK-references (within the same schema). */
	referencedTables: string[];
	tags?: Readonly<Record<string, SqlValue>>;
	/** Named constraints (CHECK / UNIQUE / FOREIGN KEY) carrying their tags. Constraints without a name are excluded. */
	namedConstraints: Array<{ name: string; tags?: Readonly<Record<string, SqlValue>> }>;
}

export interface CatalogView {
	name: string;
	ddl: string;
	tags?: Readonly<Record<string, SqlValue>>;
}

export interface CatalogMaterializedView {
	name: string;
	ddl: string;
	/** Canonical body hash — the differ compares this against a declared MV's
	 *  recomputed body hash to detect "body changed → rebuild". */
	bodyHash: string;
	tags?: Readonly<Record<string, SqlValue>>;
}

export interface CatalogIndex {
	name: string;
	tableName: string;
	ddl: string;
	tags?: Readonly<Record<string, SqlValue>>;
}

export interface CatalogAssertion {
	name: string;
	ddl: string;
}

/**
 * True when a constraint name is engine-synthesized rather than user-supplied.
 * The schema extractors auto-name unnamed column/table constraints with a
 * reserved `_`-leading prefix (`_check_<col>`, `_fk_<table>_<cols>`,
 * `_uc_<cols>`); such names are deterministic from structure but are NOT stable
 * identity a declarative schema can reference, so they are excluded from the
 * catalog's user-addressable `namedConstraints` (which drives differ
 * add/drop/rename lifecycle). A user who explicitly names a constraint `_x`
 * forfeits declarative lifecycle management of it — an acceptable corner.
 */
function isAutoConstraintName(name: string): boolean {
	return name.startsWith('_');
}

/**
 * Collects current schema state from the database into a catalog representation
 */
export function collectSchemaCatalog(db: Database, schemaName: string = 'main'): SchemaCatalog {
	const schema = db.schemaManager.getSchema(schemaName);
	if (!schema) {
		return {
			schemaName,
			tables: [],
			views: [],
			materializedViews: [],
			indexes: [],
			assertions: []
		};
	}

	const tables: CatalogTable[] = [];
	const views: CatalogView[] = [];
	const materializedViews: CatalogMaterializedView[] = [];
	const indexes: CatalogIndex[] = [];
	const assertions: CatalogAssertion[] = [];

	// Materialized-view backing tables are an implementation detail and are
	// excluded from user-facing catalog enumeration (the same way `isView`
	// tables are filtered below). The MV record itself round-trips as a
	// `CatalogMaterializedView` (collected below).
	const backingTableNames = new Set<string>();
	for (const mv of schema.getAllMaterializedViews()) {
		backingTableNames.add(mv.backingTableName.toLowerCase());
	}

	// Collect tables
	for (const tableSchema of schema.getAllTables()) {
		if (backingTableNames.has(tableSchema.name.toLowerCase())) continue;
		if (!tableSchema.isView) {
			tables.push(tableSchemaToCatalog(tableSchema, db));

			// Collect indexes for this table. Implicit covering structures (the
			// auto-built secondary BTree a declared UNIQUE constraint synthesizes for
			// enforcement) are a backing detail and are omitted by default, surfaced
			// only when the originating constraint opts in via
			// `quereus.expose_implicit_index` — preserving the user-visible shape.
			if (tableSchema.indexes && tableSchema.indexes.length > 0) {
				const implicit = implicitCoveringIndexExposure(tableSchema);
				for (const indexSchema of tableSchema.indexes) {
					const exposed = implicit.get(indexSchema.name);
					if (exposed === false) continue; // hidden implicit covering structure
					indexes.push(indexSchemaToCatalog(indexSchema, tableSchema, db));
				}
			}
		}
	}

	// Collect views
	for (const viewSchema of schema.getAllViews()) {
		views.push(viewSchemaToCatalog(viewSchema));
	}

	// Collect materialized views
	for (const mvSchema of schema.getAllMaterializedViews()) {
		materializedViews.push(materializedViewSchemaToCatalog(mvSchema));
	}

	// Collect assertions
	for (const assertionSchema of schema.getAllAssertions()) {
		assertions.push(assertionSchemaToCatalog(assertionSchema));
	}

	return {
		schemaName,
		tables,
		views,
		materializedViews,
		indexes,
		assertions
	};
}

function tableSchemaToCatalog(tableSchema: TableSchema, db: Database): CatalogTable {
	// Generate canonical DDL from TableSchema
	const ddl = generateTableDDL(tableSchema, db);

	const columns = tableSchema.columns.map(col => ({
		name: col.name,
		type: col.logicalType.name,
		notNull: col.notNull,
		primaryKey: col.primaryKey,
		defaultValue: col.defaultValue ?? null,
		collation: col.collation || 'BINARY',
		tags: col.tags,
	}));

	const primaryKey = tableSchema.primaryKeyDefinition.map(pk => ({
		columnName: tableSchema.columns[pk.index].name,
		desc: pk.desc ?? false,
	}));

	// FK references within the same schema (cross-schema FKs are excluded — drop
	// ordering only matters for tables whose lifetimes are tied to this schema).
	const ownSchemaLower = tableSchema.schemaName.toLowerCase();
	const referencedTables: string[] = [];
	const seen = new Set<string>();
	for (const fk of tableSchema.foreignKeys ?? []) {
		const refSchema = (fk.referencedSchema ?? tableSchema.schemaName).toLowerCase();
		if (refSchema !== ownSchemaLower) continue;
		const refName = fk.referencedTable.toLowerCase();
		if (refName === tableSchema.name.toLowerCase()) continue; // self-FK
		if (seen.has(refName)) continue;
		seen.add(refName);
		referencedTables.push(refName);
	}

	// Surface *user-addressable* named constraints with their tags so the differ
	// can detect renames / drops / adds of named CHECK / UNIQUE / FOREIGN KEY
	// constraints. Excluded:
	//   - engine-synthesized names (the `_check_*` / `_fk_*` / `_uc_*` auto-names
	//     the extractors assign to unnamed column/table constraints) — these are
	//     not stable identity a user can reference declaratively, and surfacing
	//     them would churn add/drop on every diff against a declaration that only
	//     carries explicit names (see `isAutoConstraintName`);
	//   - UNIQUE constraints synthesized from a `CREATE UNIQUE INDEX`
	//     (`derivedFromIndex`) — those are managed as indexes (the differ's
	//     index buckets), not as table constraints.
	const namedConstraints: CatalogTable['namedConstraints'] = [];
	for (const c of tableSchema.checkConstraints ?? []) {
		if (c.name && !isAutoConstraintName(c.name)) namedConstraints.push({ name: c.name, tags: c.tags });
	}
	for (const c of tableSchema.uniqueConstraints ?? []) {
		if (c.name && !isAutoConstraintName(c.name) && !c.derivedFromIndex) namedConstraints.push({ name: c.name, tags: c.tags });
	}
	for (const c of tableSchema.foreignKeys ?? []) {
		if (c.name && !isAutoConstraintName(c.name)) namedConstraints.push({ name: c.name, tags: c.tags });
	}

	return {
		name: tableSchema.name,
		ddl,
		columns,
		primaryKey,
		referencedTables,
		tags: tableSchema.tags,
		namedConstraints,
	};
}

function viewSchemaToCatalog(viewSchema: ViewSchema): CatalogView {
	return {
		name: viewSchema.name,
		ddl: viewSchema.sql,
		tags: viewSchema.tags,
	};
}

function materializedViewSchemaToCatalog(mvSchema: MaterializedViewSchema): CatalogMaterializedView {
	return {
		name: mvSchema.name,
		ddl: mvSchema.sql,
		bodyHash: mvSchema.bodyHash,
		tags: mvSchema.tags,
	};
}

/**
 * Tag opting a UNIQUE constraint's implicit covering structure into catalog /
 * `export_schema` visibility. Off by default — the auto-built secondary BTree is
 * a backing detail of enforcement, not part of the user-visible schema shape.
 */
const EXPOSE_IMPLICIT_INDEX_TAG = 'quereus.expose_implicit_index';

/**
 * Maps each implicit-covering-structure index name to its exposure flag. An index
 * is an implicit covering structure when it is the secondary BTree auto-built to
 * back a declared (inline) UNIQUE constraint — identified by the deterministic
 * auto-index name `uc.name ?? '_uc_<cols>'` (see
 * `MemoryTableManager.ensureUniqueConstraintIndexes`). Constraints synthesized
 * from a real `CREATE UNIQUE INDEX` (`derivedFromIndex` set) are excluded — that
 * index is the user's, always shown. The flag is `true` when the constraint
 * carries {@link EXPOSE_IMPLICIT_INDEX_TAG} (surface it), `false` otherwise
 * (hide). Index names absent from the map are ordinary indexes (always shown).
 */
function implicitCoveringIndexExposure(tableSchema: TableSchema): Map<string, boolean> {
	const map = new Map<string, boolean>();
	for (const uc of tableSchema.uniqueConstraints ?? []) {
		if (uc.derivedFromIndex) continue;
		const colNames = uc.columns.map(i => tableSchema.columns[i]?.name ?? String(i));
		const name = uc.name ?? `_uc_${colNames.join('_')}`;
		map.set(name, uc.tags?.[EXPOSE_IMPLICIT_INDEX_TAG] === true);
	}
	return map;
}

/**
 * True when `indexName` names an index that is a **hidden** implicit covering
 * structure on `tableSchema` — the auto-built secondary BTree backing a declared
 * UNIQUE constraint that has NOT opted into catalog visibility via
 * {@link EXPOSE_IMPLICIT_INDEX_TAG}. Such an index is a backing detail, not a
 * user-addressable object, so `ALTER INDEX … SET TAGS` treats it as NOTFOUND (its
 * tags live on the originating constraint — use `ALTER TABLE … ALTER CONSTRAINT
 * … SET TAGS`). An *exposed* implicit index (flag true) and any ordinary index
 * are not hidden. Match is by exact stored index name (as the catalog uses it).
 */
export function isHiddenImplicitIndex(tableSchema: TableSchema, indexName: string): boolean {
	return implicitCoveringIndexExposure(tableSchema).get(indexName) === false;
}

function indexSchemaToCatalog(
	indexSchema: IndexSchema,
	tableSchema: TableSchema,
	db: Database,
): CatalogIndex {
	return {
		name: indexSchema.name,
		tableName: tableSchema.name,
		ddl: generateIndexDDL(indexSchema, tableSchema, db),
		tags: indexSchema.tags,
	};
}

function assertionSchemaToCatalog(assertionSchema: IntegrityAssertionSchema): CatalogAssertion {
	return {
		name: assertionSchema.name,
		ddl: `CREATE ASSERTION ${quoteIdentifier(assertionSchema.name)} CHECK (${assertionSchema.violationSql})`
	};
}

/**
 * Generates canonical DDL from a declared schema AST
 */
export function generateDeclaredDDL(declaredSchema: AST.DeclareSchemaStmt, targetSchema?: string): string[] {
	const ddlStatements: string[] = [];

	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable': {
				// Qualify table name with schema if specified
				const tableStmt = item.tableStmt;
				if (targetSchema && targetSchema !== 'main' && !tableStmt.table.schema) {
					const qualifiedStmt: AST.CreateTableStmt = {
						...tableStmt,
						table: {
							...tableStmt.table,
							schema: targetSchema
						}
					};
					ddlStatements.push(createTableToString(qualifiedStmt));
				} else {
					ddlStatements.push(createTableToString(tableStmt));
				}
				break;
			}
			case 'declaredIndex': {
				// Generate index DDL using AST stringifier
				const indexStmt = item.indexStmt;
				if (targetSchema && targetSchema !== 'main' && !indexStmt.table.schema) {
					const qualifiedStmt: AST.CreateIndexStmt = {
						...indexStmt,
						table: {
							...indexStmt.table,
							schema: targetSchema
						}
					};
					ddlStatements.push(createIndexToString(qualifiedStmt));
				} else {
					ddlStatements.push(createIndexToString(indexStmt));
				}
				break;
			}
			case 'declaredView': {
				// Qualify view name with schema if specified
				const viewStmt = item.viewStmt;
				if (targetSchema && targetSchema !== 'main' && !viewStmt.view.schema) {
					const qualifiedStmt: AST.CreateViewStmt = {
						...viewStmt,
						view: {
							...viewStmt.view,
							schema: targetSchema
						}
					};
					ddlStatements.push(createViewToString(qualifiedStmt));
				} else {
					ddlStatements.push(createViewToString(viewStmt));
				}
				break;
			}
			case 'declaredMaterializedView': {
				// Qualify MV name with schema if specified
				const mvStmt = item.viewStmt;
				if (targetSchema && targetSchema !== 'main' && !mvStmt.view.schema) {
					const qualifiedStmt: AST.CreateMaterializedViewStmt = {
						...mvStmt,
						view: {
							...mvStmt.view,
							schema: targetSchema
						}
					};
					ddlStatements.push(createMaterializedViewToString(qualifiedStmt));
				} else {
					ddlStatements.push(createMaterializedViewToString(mvStmt));
				}
				break;
			}
		}
	}

	return ddlStatements;
}


