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
import { quoteIdentifier, expressionToString, constraintBodyToCanonicalString, tableConstraintsToString } from '../emit/ast-stringify.js';

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

	// Table-level CHECK / UNIQUE / FOREIGN KEY constraints. Emitting these is what
	// lets store-backed tables retain (and keep enforcing) their constraints across
	// a closeAll() + reopen + rehydrateCatalog, which re-parses this string. Reuse
	// the AST emitter (tableConstraintsToString) over the schema→AST lift so this
	// persistence path and the declarative AST→SQL path render constraints
	// identically and cannot drift. Emission is independent of the session defaults
	// (constraints have no default-elision), so the no-db and db-context branches
	// agree byte-for-byte.
	const constraintClause = emitTableConstraints(tableSchema);
	if (constraintClause) columnDefs.push(constraintClause);

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

/**
 * Lifts a stored named constraint back into the equivalent AST.TableConstraint.
 *
 * **Full-fidelity**: preserves the constraint `name` and `tags`, and (for FK)
 * reconstructs the deferrability clause, so the same lift drives both the
 * persistence emitter ({@link generateTableDDL}, via {@link tableConstraintsToString})
 * and the canonical-body comparison ({@link constraintToCanonicalDDL}). The
 * canonical consumer strips `name`/`tags`/deferrable downstream
 * (`constraintBodyToCanonicalString` does `{ ...tc, name: undefined, tags: undefined }`
 * and `canonicalForeignKeyClause` drops the deferrable clause), so carrying these
 * fields here does NOT change `constraintToCanonicalDDL` output — only the
 * persistence path benefits.
 */
function schemaConstraintToTableConstraint(
	kind: NamedConstraintClass,
	constraint: RowConstraintSchema | UniqueConstraintSchema | ForeignKeyConstraintSchema,
	tableSchema: TableSchema,
): AST.TableConstraint {
	const colName = (i: number): string => tableSchema.columns[i]?.name ?? String(i);
	switch (kind) {
		case 'check': {
			const c = constraint as RowConstraintSchema;
			return { type: 'check', name: c.name, expr: c.expr, operations: maskToOps(c.operations), onConflict: c.defaultConflict, tags: copyTags(c.tags) };
		}
		case 'unique': {
			const c = constraint as UniqueConstraintSchema;
			return { type: 'unique', name: c.name, columns: c.columns.map(i => ({ name: colName(i) })), onConflict: c.defaultConflict, tags: copyTags(c.tags) };
		}
		case 'foreignKey': {
			const c = constraint as ForeignKeyConstraintSchema;
			// The schema collapses every deferrability variant to a single `deferred`
			// boolean (= AST `initiallyDeferred`, see constraint-builder), so the only
			// form distinguishable here is `deferrable initially deferred`; all
			// non-deferred forms reconstruct as no clause (re-parses to deferred=false).
			//
			// Cross-schema FK limitation: AST.ForeignKeyClause.table is unqualified and
			// cannot encode `c.referencedSchema`, so a FK referencing a parent in a
			// different schema loses that qualification on persistence round-trip. This
			// is a pre-existing fidelity gap (cross-schema FKs are already excluded from
			// catalog drop-ordering in catalog.ts); same-schema FKs round-trip exactly.
			return {
				type: 'foreignKey',
				name: c.name,
				columns: c.columns.map(i => ({ name: colName(i) })),
				foreignKey: {
					table: c.referencedTable,
					columns: c.referencedColumnNames ? [...c.referencedColumnNames] : undefined,
					onDelete: c.onDelete,
					onUpdate: c.onUpdate,
					deferrable: c.deferred ? true : undefined,
					initiallyDeferred: c.deferred ? true : undefined,
				},
				onConflict: c.defaultConflict,
				tags: copyTags(c.tags),
			};
		}
	}
}

/** Mutable shallow copy of a (readonly) tags record, or undefined when absent. */
function copyTags(tags: Readonly<Record<string, SqlValue>> | undefined): Record<string, SqlValue> | undefined {
	return tags ? { ...tags } : undefined;
}

/**
 * Renders the table-level CHECK / UNIQUE / FOREIGN KEY constraints of a table as
 * a single comma-joined fragment (or '' when there are none), suitable to append
 * inside the CREATE TABLE column-def paren list.
 *
 * Order is deterministic — CHECK, then UNIQUE, then FOREIGN KEY, each in stored-
 * array order — so the persisted catalog DDL is byte-stable (which the declarative
 * differ and any diff-on-disk rely on).
 *
 * UNIQUE constraints synthesized from a `CREATE UNIQUE INDEX` (`derivedFromIndex`)
 * are skipped: they round-trip via their index, not as a table constraint, so
 * emitting them here would make the declarative differ churn a spurious
 * DROP CONSTRAINT. All CHECKs (including the engine's auto `_check_<col>` names)
 * and every FK are emitted — `_`-prefixed auto-names re-parse stably and stay
 * excluded from the differ's user-addressable `namedConstraints`.
 */
function emitTableConstraints(tableSchema: TableSchema): string {
	const constraints: AST.TableConstraint[] = [];
	for (const c of tableSchema.checkConstraints ?? []) {
		constraints.push(schemaConstraintToTableConstraint('check', c, tableSchema));
	}
	for (const c of tableSchema.uniqueConstraints ?? []) {
		if (c.derivedFromIndex) continue;
		constraints.push(schemaConstraintToTableConstraint('unique', c, tableSchema));
	}
	for (const c of tableSchema.foreignKeys ?? []) {
		constraints.push(schemaConstraintToTableConstraint('foreignKey', c, tableSchema));
	}
	return constraints.length > 0 ? tableConstraintsToString(constraints) : '';
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
