import type { Database } from '../core/database.js';
import type { TableSchema, IndexSchema } from './table.js';
import type { ViewSchema } from './view.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import { createTableToString, createViewToString, createIndexToString } from '../emit/ast-stringify.js';
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
 * Collects current schema state from the database into a catalog representation
 */
export function collectSchemaCatalog(db: Database, schemaName: string = 'main'): SchemaCatalog {
	const schema = db.schemaManager.getSchema(schemaName);
	if (!schema) {
		return {
			schemaName,
			tables: [],
			views: [],
			indexes: [],
			assertions: []
		};
	}

	const tables: CatalogTable[] = [];
	const views: CatalogView[] = [];
	const indexes: CatalogIndex[] = [];
	const assertions: CatalogAssertion[] = [];

	// Collect tables
	for (const tableSchema of schema.getAllTables()) {
		if (!tableSchema.isView) {
			tables.push(tableSchemaToCatalog(tableSchema, db));

			// Collect indexes for this table
			if (tableSchema.indexes && tableSchema.indexes.length > 0) {
				for (const indexSchema of tableSchema.indexes) {
					indexes.push(indexSchemaToCatalog(indexSchema, tableSchema, db));
				}
			}
		}
	}

	// Collect views
	for (const viewSchema of schema.getAllViews()) {
		views.push(viewSchemaToCatalog(viewSchema));
	}

	// Collect assertions
	for (const assertionSchema of schema.getAllAssertions()) {
		assertions.push(assertionSchemaToCatalog(assertionSchema));
	}

	return {
		schemaName,
		tables,
		views,
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

	// Surface named constraints with their tags so the differ can detect renames
	// of named CHECK / UNIQUE / FOREIGN KEY constraints.
	const namedConstraints: CatalogTable['namedConstraints'] = [];
	for (const c of tableSchema.checkConstraints ?? []) {
		if (c.name) namedConstraints.push({ name: c.name, tags: c.tags });
	}
	for (const c of tableSchema.uniqueConstraints ?? []) {
		if (c.name) namedConstraints.push({ name: c.name, tags: c.tags });
	}
	for (const c of tableSchema.foreignKeys ?? []) {
		if (c.name) namedConstraints.push({ name: c.name, tags: c.tags });
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
		ddl: `CREATE ASSERTION ${assertionSchema.name} CHECK (${assertionSchema.violationSql})`
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
		}
	}

	return ddlStatements;
}


