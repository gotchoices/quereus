import type { Database } from '../core/database.js';
import type * as AST from '../parser/ast.js';
import { Parser } from '../parser/parser.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { inferType } from '../types/registry.js';
import { normalizeCollationName } from '../util/comparison.js';
import { collectSchemaCatalog, type CatalogAssertion, type CatalogTable } from './catalog.js';

/** The kinds of catalog entry an export turns into declaration items, as named in error messages. */
type ExportedObjectKind = 'table' | 'view' | 'index' | 'assertion';

/** What an export needs from any catalog entry: its name and canonical DDL. */
interface ExportableEntry {
	readonly name: string;
	readonly ddl: string;
}

/** A table's live column attributes, from which session-elided clauses are restored. */
type CatalogColumn = CatalogTable['columns'][number];

/**
 * The live physical schema `schemaName` as a `declare schema` statement: every table
 * (plain and maintained), view, index and assertion `collectSchemaCatalog` lists, each
 * parsed from its catalog DDL and wrapped as a declaration item. Applying the result
 * with `apply schema` recreates the schema. Render it with `astToString`.
 *
 * The catalog decides what belongs to the schema, so engine-managed tables and hidden
 * implicit covering indexes are already absent. Exposed implicit indexes are skipped
 * here as well: the UNIQUE constraint in the table's DDL recreates them, and a
 * standalone `unique index` would duplicate it.
 *
 * Items are grouped tables, views, indexes, assertions, and sorted by name within each
 * group rather than kept in catalog order. Catalog order is creation order, and
 * `apply schema` creates in its own order (parents before children, maintained tables
 * after plain ones), so exporting a schema rebuilt from an export would otherwise list
 * the same objects differently.
 *
 * The statement carries no `version`, no `using (default_vtab_module …)` clause and no
 * `seed` items: each table's DDL already names its module when that differs from the
 * session default, and data is not part of a schema export. Every column states its
 * nullability, and a text column its collation, so the importer's
 * `default_column_nullability` / `default_collation` cannot change them.
 *
 * @throws QuereusError when the schema does not exist (an empty declaration would drop
 *   everything when applied), when it is a logical schema, or when an assertion has no
 *   CHECK expression to render.
 */
export function exportSchemaDeclaration(db: Database, schemaName: string = 'main'): AST.DeclareSchemaStmt {
	const schema = db.schemaManager.getSchema(schemaName);
	if (!schema) {
		throw new QuereusError(`no such schema: ${schemaName}`, StatusCode.ERROR);
	}
	if (schema.kind === 'logical') {
		throw new QuereusError(`Cannot export schema '${schema.name}': logical schemas cannot be exported`, StatusCode.ERROR);
	}

	const catalog = collectSchemaCatalog(db, schema.name);
	const items: AST.DeclareItem[] = [
		...sortedByName(catalog.tables).map(entry => withSessionDefaultsPinned(declareItemFor(entry, 'table', schema.name), entry)),
		...sortedByName(catalog.views).map(entry => declareItemFor(entry, 'view', schema.name)),
		...sortedByName(catalog.indexes.filter(index => !index.implicit)).map(entry => declareItemFor(entry, 'index', schema.name)),
		...sortedByName(catalog.assertions).map(entry => declareItemFor(assertionWithCheck(entry), 'assertion', schema.name)),
	];
	return { type: 'declareSchema', schemaName: schema.name, items };
}

/**
 * Orders by lowercased name, with the exact name as tie-break. Code-unit comparison
 * rather than `localeCompare`, so the order does not depend on the host's locale.
 */
function sortedByName<T extends ExportableEntry>(entries: readonly T[]): T[] {
	const key = (entry: T): [string, string] => [entry.name.toLowerCase(), entry.name];
	return [...entries].sort((a, b) => compareKeys(key(a), key(b)));
}

function compareKeys(a: readonly string[], b: readonly string[]): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

/**
 * Refuses an assertion whose catalog entry fell back to its `violationSql` (see
 * `assertionSchemaToCatalog`): that DDL embeds a query where the CHECK expression
 * goes, so a declaration built from it would never match the live assertion.
 */
function assertionWithCheck(entry: CatalogAssertion): CatalogAssertion {
	if (!entry.check) {
		throw new QuereusError(
			`Cannot export assertion '${entry.name}': its CHECK expression is not available, only the query that detects violations`,
			StatusCode.ERROR,
		);
	}
	return entry;
}

function declareItemFor(entry: ExportableEntry, kind: ExportedObjectKind, schemaName: string): AST.DeclareItem {
	const statement = parseCatalogDdl(entry, kind);
	switch (statement.type) {
		case 'createTable':
			return { type: 'declaredTable', tableStmt: { ...statement, table: unqualified(statement.table, schemaName, entry, kind) } };
		case 'createIndex':
			return {
				type: 'declaredIndex',
				indexStmt: { ...statement, index: unqualified(statement.index, schemaName, entry, kind), table: unqualified(statement.table, schemaName, entry, kind) },
			};
		case 'createView':
			return { type: 'declaredView', viewStmt: { ...statement, view: unqualified(statement.view, schemaName, entry, kind) } };
		case 'createMaterializedView':
			return { type: 'declaredMaterializedView', viewStmt: { ...statement, view: unqualified(statement.view, schemaName, entry, kind) } };
		case 'createAssertion':
			return { type: 'declaredAssertion', assertionStmt: { ...statement, name: unqualified(statement.name, schemaName, entry, kind) } };
		default:
			throw new QuereusError(
				`Cannot export ${kind} '${entry.name}': its catalog DDL is a '${statement.type}' statement, which has no declaration form`,
				StatusCode.INTERNAL,
			);
	}
}

/**
 * The catalog's table DDL leaves out a column's nullability when it matches the
 * exporting session's `default_column_nullability`, and a BINARY collation always.
 * Applying that text resolves both against the importing session, so each column
 * gets them written out from its live attributes. A collation is written only for a
 * type that can take a non-BINARY default (`resolveDefaultCollation` in `table.ts`).
 */
function withSessionDefaultsPinned(item: AST.DeclareItem, entry: CatalogTable): AST.DeclareItem {
	if (item.type !== 'declaredTable') return item;
	const columns = item.tableStmt.columns.map(def => withExplicitNullabilityAndCollation(def, catalogColumn(entry, def.name)));
	return { ...item, tableStmt: { ...item.tableStmt, columns } };
}

function catalogColumn(entry: CatalogTable, name: string): CatalogColumn {
	const column = entry.columns.find(c => c.name === name);
	if (!column) {
		throw new QuereusError(`Cannot export table '${entry.name}': its catalog DDL has column '${name}', which its catalog entry does not list`, StatusCode.INTERNAL);
	}
	return column;
}

/**
 * Inserts each missing clause where the DDL generator writes it (nullability first,
 * collation right after), so the text is the same whichever clauses the exporting
 * session's defaults let the generator elide.
 */
function withExplicitNullabilityAndCollation(def: AST.ColumnDef, column: CatalogColumn): AST.ColumnDef {
	const isNullability = (c: AST.ColumnConstraint) => c.type === 'notNull' || c.type === 'null';
	let constraints = def.constraints;
	if (!constraints.some(isNullability)) {
		constraints = [{ type: column.notNull ? 'notNull' : 'null' }, ...constraints];
	}
	if (!constraints.some(c => c.type === 'collate') && canTakeNonBinaryDefault(def.dataType)) {
		const at = constraints.findIndex(isNullability) + 1;
		constraints = [...constraints.slice(0, at), { type: 'collate', collation: column.collation }, ...constraints.slice(at)];
	}
	return constraints === def.constraints ? def : { ...def, constraints };
}

function canTakeNonBinaryDefault(dataType: string | undefined): boolean {
	return inferType(dataType).supportedCollations?.some(c => normalizeCollationName(c) !== 'BINARY') ?? false;
}

/** The single statement an entry's catalog DDL holds. Catalog DDL that fails to re-parse is an engine defect. */
function parseCatalogDdl(entry: ExportableEntry, kind: ExportedObjectKind): AST.Statement {
	// NOTE: the returned nodes keep `loc` positions into `entry.ddl`, not into any text the
	// caller holds; `astToString` ignores them. If a caller ever hands the AST straight to
	// `declaredSchemaManager.setDeclaredSchema`, strip `loc` first or apply errors point
	// into the wrong string.
	let statements: AST.Statement[];
	try {
		statements = new Parser().parseAll(entry.ddl);
	} catch (e) {
		throw new QuereusError(
			`Cannot export ${kind} '${entry.name}': its catalog DDL does not parse: ${entry.ddl}`,
			StatusCode.INTERNAL,
			e instanceof Error ? e : undefined,
		);
	}
	if (statements.length !== 1) {
		throw new QuereusError(
			`Cannot export ${kind} '${entry.name}': its catalog DDL holds ${statements.length} statements, expected one: ${entry.ddl}`,
			StatusCode.INTERNAL,
		);
	}
	return statements[0];
}

/**
 * `name` without its qualifier. Declaration items name objects of the declared schema
 * bare, and the declared-item writer prints only the bare name, so a qualifier naming
 * any other schema would be dropped silently; that would be an engine defect.
 */
function unqualified(name: AST.IdentifierExpr, schemaName: string, entry: ExportableEntry, kind: ExportedObjectKind): AST.IdentifierExpr {
	const { schema, ...bare } = name;
	if (schema === undefined) return name;
	if (schema.toLowerCase() !== schemaName.toLowerCase()) {
		throw new QuereusError(
			`Cannot export ${kind} '${entry.name}': its catalog DDL names schema '${schema}', not '${schemaName}'`,
			StatusCode.INTERNAL,
		);
	}
	return bare;
}
