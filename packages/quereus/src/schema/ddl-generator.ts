/**
 * Canonical DDL generation from TableSchema / IndexSchema.
 *
 * Exports:
 *   - generateTableDDL(tableSchema, db?) => CREATE TABLE ...
 *   - generateIndexDDL(indexSchema, tableSchema, db?) => CREATE INDEX ...
 *
 * When `db` is omitted, the generator emits fully-qualified DDL with
 * unconditional annotations (schema name qualified, USING emitted,
 * nullability annotated on every column). This makes the output safe to
 * persist and re-parse in any session.
 *
 * When `db` is provided, clauses that match the current session defaults
 * are elided for readability:
 *   - schema name qualification (db.schemaManager current schema)
 *   - USING module / args (db.options.default_vtab_module / default_vtab_args)
 *   - per-column NULL / NOT NULL annotation (db.options.default_column_nullability)
 */

import type { Database } from '../core/database.js';
import type { TableSchema, IndexSchema, RowConstraintSchema, UniqueConstraintSchema, ForeignKeyConstraintSchema, NamedConstraintClass } from './table.js';
import { maskToOps } from './table.js';
import type { ColumnSchema } from './column.js';
import type { SqlValue } from '../common/types.js';
import type * as AST from '../parser/ast.js';
import { quoteIdentifier, expressionToString, constraintBodyToCanonicalString } from '../emit/ast-stringify.js';

/**
 * Unconditionally double-quote an identifier, escaping internal quotes.
 *
 * This generator deliberately uses two quoting policies:
 *   - `quoteName` (here, unconditional) for *structural* names — table, column,
 *     schema, index, and primary-key columns — so they always emit quoted.
 *   - `quoteIdentifier` (conditional; from `../emit/ast-stringify.js`) for
 *     *operand* identifiers — collation name, USING module name, vtab-arg key,
 *     and tag key — which stay bare unless they are reserved words / non-bare-
 *     valid. This keeps the common forms readable and re-parseable
 *     (`USING store`, `COLLATE NOCASE`) while still quoting a reserved-word name
 *     (`USING "select"`). Both forms re-parse; the split matches the canonical
 *     DDL convention pinned by the quereus-store ddl-generator spec.
 */
function quoteName(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Generate canonical DDL for a table from its schema. */
export function generateTableDDL(tableSchema: TableSchema, db?: Database): string {
	const ctx = resolveEmitContext(db);

	const parts: string[] = ['CREATE'];
	parts.push('TABLE', qualifiedName(tableSchema.schemaName, tableSchema.name, ctx.currentSchemaName));

	const columnDefs: string[] = [];
	for (const col of tableSchema.columns) {
		columnDefs.push(formatColumnDef(col, tableSchema, ctx.defaultNotNull));
	}

	// Table-level PRIMARY KEY: empty () for singleton, (a, b, ...) for composite.
	// Single-column PK is emitted inline on the column above.
	if (tableSchema.primaryKeyDefinition.length === 0) {
		columnDefs.push('PRIMARY KEY ()');
	} else if (tableSchema.primaryKeyDefinition.length > 1) {
		const pkCols = tableSchema.primaryKeyDefinition
			.map(pk => quoteName(tableSchema.columns[pk.index].name))
			.join(', ');
		columnDefs.push(`PRIMARY KEY (${pkCols})`);
	}

	parts.push(`(${columnDefs.join(', ')})`);

	// USING clause: emit when vtabModuleName differs from the session default,
	// or always when no db context is provided.
	const usingClause = formatUsingClause(tableSchema, ctx);
	if (usingClause) parts.push(usingClause);

	// Table-level WITH TAGS
	if (hasTags(tableSchema.tags)) {
		parts.push(formatTagsClause(tableSchema.tags!));
	}

	return parts.join(' ');
}

/** Generate canonical DDL for an index from its schema. */
export function generateIndexDDL(
	indexSchema: IndexSchema,
	tableSchema: TableSchema,
	db?: Database,
): string {
	const ctx = resolveEmitContext(db);
	const parts: string[] = ['CREATE INDEX'];
	parts.push(quoteName(indexSchema.name));
	parts.push('ON');
	parts.push(qualifiedName(tableSchema.schemaName, tableSchema.name, ctx.currentSchemaName));

	const cols = indexSchema.columns.map(col => {
		let colStr = quoteName(tableSchema.columns[col.index].name);
		if (col.collation) colStr += ` COLLATE ${quoteIdentifier(col.collation)}`;
		if (col.desc) colStr += ' DESC';
		return colStr;
	});
	parts.push(`(${cols.join(', ')})`);

	if (hasTags(indexSchema.tags)) {
		parts.push(formatTagsClause(indexSchema.tags!));
	}

	return parts.join(' ');
}

/**
 * Canonical DDL **body fragment** for a stored named constraint (CHECK / UNIQUE /
 * FOREIGN KEY), excluding its `constraint <name>` prefix and `with tags (...)`
 * suffix. This is the actual-catalog comparison key the declarative differ
 * diffs against the declared-AST fragment (rendered by the same
 * {@link constraintBodyToCanonicalString}) to detect a constraint whose name is
 * unchanged but whose body changed. The schema constraint is first lifted back
 * into the equivalent {@link AST.TableConstraint} (column indices → names,
 * operation mask → `RowOp[]`, `defaultConflict` → `onConflict`, FK actions and
 * deferred resolution mapped over), so both sides share one rendering path and
 * stay byte-comparable.
 */
export function constraintToCanonicalDDL(
	kind: NamedConstraintClass,
	constraint: RowConstraintSchema | UniqueConstraintSchema | ForeignKeyConstraintSchema,
	tableSchema: TableSchema,
): string {
	return constraintBodyToCanonicalString(schemaConstraintToTableConstraint(kind, constraint, tableSchema));
}

/** Lifts a stored named constraint back into the equivalent AST.TableConstraint. */
function schemaConstraintToTableConstraint(
	kind: NamedConstraintClass,
	constraint: RowConstraintSchema | UniqueConstraintSchema | ForeignKeyConstraintSchema,
	tableSchema: TableSchema,
): AST.TableConstraint {
	const colName = (i: number): string => tableSchema.columns[i]?.name ?? String(i);
	switch (kind) {
		case 'check': {
			const c = constraint as RowConstraintSchema;
			return { type: 'check', expr: c.expr, operations: maskToOps(c.operations), onConflict: c.defaultConflict };
		}
		case 'unique': {
			const c = constraint as UniqueConstraintSchema;
			return { type: 'unique', columns: c.columns.map(i => ({ name: colName(i) })), onConflict: c.defaultConflict };
		}
		case 'foreignKey': {
			const c = constraint as ForeignKeyConstraintSchema;
			return {
				type: 'foreignKey',
				columns: c.columns.map(i => ({ name: colName(i) })),
				foreignKey: {
					table: c.referencedTable,
					columns: c.referencedColumnNames ? [...c.referencedColumnNames] : undefined,
					onDelete: c.onDelete,
					onUpdate: c.onUpdate,
				},
				onConflict: c.defaultConflict,
			};
		}
	}
}

// --- Internals ---

interface EmitContext {
	/** Current schema name used to elide qualification; undefined = always qualify. */
	currentSchemaName: string | undefined;
	/** Session default_column_nullability; undefined = always annotate. */
	defaultNotNull: boolean | undefined;
	/** Session default vtab module; undefined = always emit USING when set. */
	defaultVtabModule: string | undefined;
	/** Session default vtab args; undefined = always emit args when set. */
	defaultVtabArgs: Record<string, SqlValue> | undefined;
}

function resolveEmitContext(db?: Database): EmitContext {
	if (!db) {
		return {
			currentSchemaName: undefined,
			defaultNotNull: undefined,
			defaultVtabModule: undefined,
			defaultVtabArgs: undefined,
		};
	}
	const nullability = db.options.getStringOption('default_column_nullability');
	return {
		currentSchemaName: db.schemaManager.getCurrentSchemaName(),
		defaultNotNull: nullability === 'not_null',
		defaultVtabModule: db.options.getStringOption('default_vtab_module'),
		defaultVtabArgs: db.options.getObjectOption('default_vtab_args'),
	};
}

function qualifiedName(schemaName: string | undefined, name: string, currentSchemaName: string | undefined): string {
	const quotedName = quoteName(name);
	if (!schemaName) return quotedName;
	// Elide qualification when schema matches the session's current schema.
	if (currentSchemaName !== undefined && schemaName.toLowerCase() === currentSchemaName.toLowerCase()) {
		return quotedName;
	}
	return `${quoteName(schemaName)}.${quotedName}`;
}

function formatColumnDef(col: ColumnSchema, tableSchema: TableSchema, defaultNotNull: boolean | undefined): string {
	let colDef = quoteName(col.name);
	if (col.logicalType) colDef += ` ${col.logicalType.name}`;

	const nullAnnotation = nullabilityAnnotation(col.notNull, defaultNotNull);
	if (nullAnnotation) colDef += ` ${nullAnnotation}`;

	if (col.primaryKey && tableSchema.primaryKeyDefinition.length === 1) {
		colDef += ' PRIMARY KEY';
	}

	if (col.defaultValue !== null && col.defaultValue !== undefined) {
		colDef += ` DEFAULT ${formatDefaultExpression(col.defaultValue)}`;
	}

	if (hasTags(col.tags)) {
		colDef += ' ' + formatTagsClause(col.tags!);
	}

	return colDef;
}

/**
 * Decides what nullability annotation (if any) to emit.
 *
 * - With a known session default: emit only the annotation that differs from the default.
 * - Without a session default: always emit explicitly (safe for persistence under any reader).
 */
function nullabilityAnnotation(notNull: boolean, defaultNotNull: boolean | undefined): string | null {
	if (defaultNotNull === undefined) {
		return notNull ? 'NOT NULL' : 'NULL';
	}
	if (defaultNotNull && !notNull) return 'NULL';
	if (!defaultNotNull && notNull) return 'NOT NULL';
	return null;
}

function formatUsingClause(tableSchema: TableSchema, ctx: EmitContext): string | null {
	const moduleName = tableSchema.vtabModuleName;
	if (!moduleName) return null;

	const args = tableSchema.vtabArgs ?? {};
	const hasArgs = Object.keys(args).length > 0;

	// If no db context, always emit both module and args.
	if (ctx.defaultVtabModule === undefined) {
		let clause = `USING ${quoteIdentifier(moduleName)}`;
		if (hasArgs) clause += ` (${formatVtabArgs(args)})`;
		return clause;
	}

	const moduleMatches = moduleName === ctx.defaultVtabModule;
	const defaultArgs = ctx.defaultVtabArgs ?? {};
	const argsMatch = recordsShallowEqual(args, defaultArgs);

	if (moduleMatches && argsMatch) return null;

	let clause = `USING ${quoteIdentifier(moduleName)}`;
	if (hasArgs) clause += ` (${formatVtabArgs(args)})`;
	return clause;
}

function formatVtabArgs(args: Record<string, SqlValue>): string {
	return Object.entries(args)
		.map(([key, value]) => `${quoteIdentifier(key)} = ${formatSqlLiteral(value)}`)
		.join(', ');
}

function formatDefaultExpression(expr: AST.Expression): string {
	// Prefer AST stringifier, which preserves lexeme for literals where possible.
	return expressionToString(expr);
}

/** Format a SqlValue as a SQL literal (suitable for DEFAULT / USING args). */
function formatSqlLiteral(value: SqlValue): string {
	if (value === null) return 'NULL';
	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	if (typeof value === 'boolean') return value ? '1' : '0';
	// Fallback for complex values — stringify as JSON string literal.
	return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

/**
 * Format a tag value. Differs from formatSqlLiteral: booleans emit TRUE/FALSE.
 */
function formatTagValue(value: SqlValue): string {
	if (value === null) return 'NULL';
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
	return String(value);
}

function formatTagsClause(tags: Readonly<Record<string, SqlValue>>): string {
	const entries = Object.entries(tags)
		.map(([key, value]) => `${quoteIdentifier(key)} = ${formatTagValue(value)}`)
		.join(', ');
	return `WITH TAGS (${entries})`;
}

function hasTags(tags: Readonly<Record<string, SqlValue>> | undefined): boolean {
	return !!tags && Object.keys(tags).length > 0;
}

function recordsShallowEqual(a: Record<string, SqlValue>, b: Record<string, SqlValue>): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const k of aKeys) {
		if (!Object.hasOwn(b, k)) return false;
		if (a[k] !== b[k]) return false;
	}
	return true;
}
