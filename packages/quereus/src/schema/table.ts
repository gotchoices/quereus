import type { ColumnSchema } from './column.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';
import { MemoryTableModule } from '../vtab/memory/module.js';
import type { Expression } from '../parser/ast.js';
import type { ConflictResolution } from '../common/constants.js';
import { type ColumnDef, type TableConstraint } from '../parser/ast.js';
import { RowOp, StatusCode, type SqlValue } from '../common/types.js';
import type * as AST from '../parser/ast.js';
import { quereusError, QuereusError } from '../common/errors.js';
import { createLogger } from '../common/logger.js';
import { inferType } from '../types/registry.js';
import { traverseAst } from '../parser/visitor.js';
import type { TableStatistics } from '../planner/stats/catalog-stats.js';

const log = createLogger('schema:table');
const warnLog = log.extend('warn');

/**
 * Represents the schema definition of a table (real or virtual).
 */
export interface TableSchema {
	/** Table name */
	name: string;
	/** Schema name (e.g., "main", "temp") */
	schemaName: string;
	/** Ordered list of column definitions */
	columns: ReadonlyArray<ColumnSchema>;
	/** Map from column name (lowercase) to column index */
	columnIndexMap: ReadonlyMap<string, number>;
	/** Definition of the primary key, including order and direction */
	primaryKeyDefinition: ReadonlyArray<PrimaryKeyColumnDefinition>;
	/**
	 * Default conflict resolution declared on a table-level
	 * `PRIMARY KEY (...) ON CONFLICT <action>` clause. Resolution precedence for
	 * PK conflicts: statement-level OR > this field > column-level
	 * `defaultConflict` on any PK column > ABORT.
	 */
	primaryKeyDefaultConflict?: ConflictResolution;
	/** CHECK constraints defined on the table or its columns */
	checkConstraints: ReadonlyArray<RowConstraintSchema>;
	/** Reference to the registered module */
	vtabModule: AnyVirtualTableModule;
	/** If virtual, aux data passed during module registration */
	vtabAuxData?: unknown;
	/** If virtual, the arguments passed in CREATE VIRTUAL TABLE */
	vtabArgs?: Record<string, SqlValue>;
	/** If virtual, the name the module was registered with */
	vtabModuleName: string;
	/** Whether the table is a temporary table */
	isTemporary?: boolean;
	/** Whether the table is a view */
	isView: boolean;
	/** Whether the table is a subquery source */
	subqueryAST?: AST.SelectStmt;
	/** If virtual, the view definition */
	viewDefinition?: AST.SelectStmt;
	/** Table-level constraints */
	tableConstraints?: readonly TableConstraint[];
	/** Definitions of secondary indexes (relevant for planning) */
	indexes?: ReadonlyArray<IndexSchema>;
	/** Estimated number of rows in the table (for query planning) */
	readonly estimatedRows?: number;
	/** Whether the table is read-only */
	isReadOnly?: boolean;	// default false
	/** Mutation context variables for this table */
	mutationContext?: ReadonlyArray<MutationContextDefinition>;
	/** Cached table statistics from ANALYZE or VTab reporting */
	statistics?: TableStatistics;
	/** Foreign key constraints */
	foreignKeys?: ReadonlyArray<ForeignKeyConstraintSchema>;
	/** Unique constraints (beyond primary key) */
	uniqueConstraints?: ReadonlyArray<UniqueConstraintSchema>;
	/**
	 * For each generated column index, the set of column indices in this table its
	 * expression references. Populated alongside the columns array so INSERT/UPDATE
	 * planners and DROP COLUMN don't re-walk the AST.
	 */
	generatedColumnDependencies?: ReadonlyMap<number, ReadonlyArray<number>>;
	/**
	 * Generated column indices ordered so dependencies come before dependents.
	 * Empty / undefined when no generated columns exist.
	 */
	generatedColumnTopoOrder?: ReadonlyArray<number>;
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Builds a map from column names to their indices in the columns array
 *
 * @param columns Array of column schemas
 * @returns Map of lowercase column names to their indices
 */
export function buildColumnIndexMap(columns: ReadonlyArray<ColumnSchema>): Map<string, number> {
	const map = new Map<string, number>();
	columns.forEach((col, index) => {
		map.set(col.name.toLowerCase(), index);
	});
	return map;
}

/**
 * Extracts just the column indices from a primary key definition
 *
 * @param pkDef Primary key definition array
 * @returns Array of column indices that form the primary key
 */
export function getPrimaryKeyIndices(pkDef: ReadonlyArray<PrimaryKeyColumnDefinition>): ReadonlyArray<number> {
	return Object.freeze(pkDef.map(def => def.index));
}

/**
 * Converts a parsed ColumnDef AST node into a runtime ColumnSchema object
 *
 * @param def Column definition AST node
 * @param defaultNotNull Whether columns should be NOT NULL by default (Third Manifesto approach)
 * @returns A runtime ColumnSchema object
 */
export function columnDefToSchema(def: ColumnDef, defaultNotNull: boolean = true): ColumnSchema {
	// Infer logical type from the declared type name
	const logicalType = inferType(def.dataType);

	const schema: ColumnSchema = {
		name: def.name,
		logicalType: logicalType,
		notNull: defaultNotNull,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY',
		generated: false,
	};

	for (const constraint of def.constraints ?? []) {
		switch (constraint.type) {
			case 'primaryKey':
				schema.primaryKey = true;
				schema.pkDirection = constraint.direction;
				if (constraint.onConflict !== undefined) {
					schema.defaultConflict = constraint.onConflict;
				}
				break;
			case 'notNull':
				schema.notNull = true;
				if (constraint.onConflict !== undefined) {
					schema.defaultConflict = constraint.onConflict;
				}
				break;
			case 'null':
				schema.notNull = false;
				if (constraint.onConflict !== undefined) {
					schema.defaultConflict = constraint.onConflict;
				}
				break;
			case 'unique':
				break;
			case 'default':
				schema.defaultValue = constraint.expr ?? null;
				break;
			case 'collate': {
				schema.collation = constraint.collation ?? 'BINARY';
				if (constraint.collation && logicalType.supportedCollations &&
					!logicalType.supportedCollations.includes(constraint.collation)) {
					throw new QuereusError(
						`Collation '${constraint.collation}' is not supported for type '${logicalType.name}' on column '${def.name}'`,
						StatusCode.ERROR
					);
				}
				break;
			}
			case 'generated':
				schema.generated = true;
				if (constraint.generated) {
					schema.generatedExpr = constraint.generated.expr;
					schema.generatedStored = constraint.generated.stored;
				}
				break;
		}
	}

	if (schema.generated && schema.defaultValue !== null) {
		throw new QuereusError(
			`Column '${def.name}' cannot have both DEFAULT and GENERATED ALWAYS AS`,
			StatusCode.ERROR
		);
	}

	if (schema.primaryKey) {
		schema.notNull = true;
	}

	if (schema.primaryKey && schema.pkOrder === 0) {
		schema.pkOrder = 1;
	}

	// Thread column-level tags
	if (def.tags && Object.keys(def.tags).length > 0) {
		schema.tags = Object.freeze({ ...def.tags });
	}

	return schema;
}

/**
 * Mutation context variable definition
 */
export interface MutationContextDefinition {
	/** Variable name */
	name: string;
	/** Logical type of the variable */
	logicalType: import('../types/logical-type.js').LogicalType;
	/** Whether the variable is NOT NULL */
	notNull: boolean;
}

/**
 * Converts AST mutation context variable to schema definition
 *
 * @param varDef AST mutation context variable definition
 * @param defaultNotNull Whether variables should be NOT NULL by default
 * @returns Mutation context definition schema object
 */
export function mutationContextVarToSchema(varDef: AST.MutationContextVar, defaultNotNull: boolean = true): MutationContextDefinition {
	return {
		name: varDef.name,
		logicalType: inferType(varDef.dataType),
		notNull: varDef.notNull !== undefined ? varDef.notNull : defaultNotNull,
	};
}

/**
 * Defines a column in an index
 */
export interface IndexColumnSchema {
	/** Column index in TableSchema.columns */
	index: number;
	/** Whether the index should sort in descending order */
	desc?: boolean;	// default false
	/** Optional collation sequence for the column */
	collation?: string;
}

/**
 * Represents an index definition
 */
export interface IndexSchema {
	/** Index name */
	name: string;
	/** Columns in the index */
	columns: ReadonlyArray<IndexColumnSchema>;
	/** Whether the index enforces uniqueness on its key columns */
	unique?: boolean;
	/** Optional partial-index predicate (the WHERE clause AST). Rows for which this
	 *  evaluates to anything other than TRUE are excluded from the index and from
	 *  any UNIQUE enforcement that the index backs. */
	predicate?: Expression;
	/** Arbitrary metadata tags (informational only) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Creates a basic TableSchema with minimal configuration
 *
 * @param name Table name
 * @param columns Array of column name and type objects
 * @param pkColNames Optional array of primary key column names
 * @param defaultNotNull Whether columns should be NOT NULL by default (defaults to true for Third Manifesto compliance)
 * @returns A frozen TableSchema object
 */
export function createBasicSchema(name: string, columns: { name: string, type: string }[], pkColNames?: string[], defaultNotNull: boolean = true): Readonly<TableSchema> {
	const columnSchemas = columns.map(c => columnDefToSchema({
		name: c.name,
		dataType: c.type,
		constraints: []
	}, defaultNotNull));
	const columnIndexMap = buildColumnIndexMap(columnSchemas);
	const pkDef = pkColNames
		? pkColNames.map(pkName => {
			const idx = columnIndexMap.get(pkName.toLowerCase());
			if (idx === undefined) quereusError(`PK column ${pkName} not found`);
			return { index: idx, desc: false };
		})
		: [];

	const defaultMemoryModule = new MemoryTableModule();

	return Object.freeze({
		name: name,
		schemaName: 'main',
		columns: columnSchemas,
		columnIndexMap: columnIndexMap,
		primaryKeyDefinition: pkDef,
		checkConstraints: [] as RowConstraintSchema[],
		indexes: [],
		vtabModule: defaultMemoryModule,
		vtabAuxData: null,
		vtabArgs: {},
		vtabModuleName: 'memory',
		isTemporary: false,
		isView: false,
		subqueryAST: undefined,
		viewDefinition: undefined,
		tableConstraints: [],
	});
}

/** Bitmask for row operations */
export const enum RowOpFlag {
	INSERT = 1,
	UPDATE = 2,
	DELETE = 4
}
export type RowOpMask = RowOpFlag;
export const DEFAULT_ROWOP_MASK = RowOpFlag.INSERT | RowOpFlag.UPDATE;

/**
 * Converts an array of row operations to a bitmask
 *
 * @param list Optional array of operation types
 * @returns A bitmask representing the operations
 */
export function opsToMask(list?: RowOp[]): RowOpMask {
	if (!list || list.length === 0) {
		return DEFAULT_ROWOP_MASK;
	}
	let mask: RowOpMask = 0 as RowOpMask;
	list.forEach(op => {
		switch (op) {
			case 'insert': mask |= RowOpFlag.INSERT; break;
			case 'update': mask |= RowOpFlag.UPDATE; break;
			case 'delete': mask |= RowOpFlag.DELETE; break;
		}
	});
	return mask;
}

/**
 * Represents a CHECK constraint with operation flags
 */
export interface RowConstraintSchema {
	/** Optional constraint name */
	name?: string;
	/** Constraint expression */
	expr: Expression;
	/** Bitmask of operations the constraint applies to */
	operations: RowOpMask;
	/** Whether the constraint is deferrable */
	deferrable?: boolean;
	/** Whether the constraint is initially deferred */
	initiallyDeferred?: boolean;
	/**
	 * Default conflict resolution declared at the constraint level (e.g.,
	 * `CHECK (...) ON CONFLICT IGNORE`). Statement-level OR clauses override.
	 */
	defaultConflict?: ConflictResolution;
	/** Arbitrary metadata tags (informational only) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Represents a FOREIGN KEY constraint linking child columns to a parent table
 */
export interface ForeignKeyConstraintSchema {
	/** Optional constraint name */
	name?: string;
	/** Column indices in this (child) table */
	columns: ReadonlyArray<number>;
	/** Referenced (parent) table name */
	referencedTable: string;
	/** Referenced schema (default: same schema) */
	referencedSchema?: string;
	/** Column indices in the parent table */
	referencedColumns: ReadonlyArray<number>;
	/**
	 * Referenced column names for deferred resolution.
	 * Parent column indices can't be resolved at schema creation time because
	 * the parent table may not exist yet. These names are resolved to indices
	 * at enforcement time via {@link resolveReferencedColumns}.
	 */
	referencedColumnNames?: ReadonlyArray<string>;
	/** Action on parent DELETE (default: 'restrict') */
	onDelete: import('../parser/ast.js').ForeignKeyAction;
	/** Action on parent UPDATE of referenced columns (default: 'restrict') */
	onUpdate: import('../parser/ast.js').ForeignKeyAction;
	/** Whether enforcement is deferred to COMMIT */
	deferred: boolean;
	/**
	 * Default conflict resolution declared at the FK constraint level. Statement-level
	 * OR clauses override.
	 */
	defaultConflict?: ConflictResolution;
	/** Arbitrary metadata tags (informational only) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Resolves referenced column indices in the parent table from a FK schema.
 * Uses stored column names or falls back to the parent's primary key.
 */
export function resolveReferencedColumns(
	fk: ForeignKeyConstraintSchema,
	parentSchema: TableSchema,
): number[] {
	const refColNames = fk.referencedColumnNames;

	if (refColNames && refColNames.length > 0) {
		return refColNames.map(name => {
			const idx = parentSchema.columnIndexMap.get(name.toLowerCase());
			if (idx === undefined) {
				throw new QuereusError(
					`Referenced column '${name}' not found in table '${parentSchema.name}'`,
					StatusCode.ERROR
				);
			}
			return idx;
		});
	}

	// Default to primary key columns
	return parentSchema.primaryKeyDefinition.map(pk => pk.index);
}

/**
 * Represents a UNIQUE constraint on one or more columns (beyond the primary key)
 */
export interface UniqueConstraintSchema {
	/** Optional constraint name */
	name?: string;
	/** Column indices in this table that form the unique constraint */
	columns: ReadonlyArray<number>;
	/**
	 * Default conflict resolution declared at the constraint level (e.g.,
	 * `email TEXT UNIQUE ON CONFLICT REPLACE`). Statement-level OR clauses override.
	 */
	defaultConflict?: ConflictResolution;
	/** Optional partial-index predicate (the WHERE clause AST). Mirrored from the
	 *  backing IndexSchema so the runtime can skip uniqueness checks for rows that
	 *  fall outside the partial scope. Only set when the constraint was synthesized
	 *  from a `CREATE UNIQUE INDEX ... WHERE ...`. */
	predicate?: Expression;
	/** When set, this constraint was synthesized from a UNIQUE index of the
	 *  given name (see SchemaManager.addIndexToTableSchema). DROP INDEX of that
	 *  index removes this constraint. Unset for constraints declared at
	 *  CREATE TABLE time. */
	derivedFromIndex?: string;
	/** Arbitrary metadata tags (informational only) */
	tags?: Readonly<Record<string, SqlValue>>;
}

export interface PrimaryKeyColumnDefinition {
	index: number;
	desc?: boolean;	// default false
	collation?: string;
}

/**
 * Helper to parse primary key from AST column and table constraints.
 * @param columns Parsed column definitions from AST.
 * @param constraints Parsed table constraints from AST.
 * @returns The primary-key column list plus any table-level
 * `PRIMARY KEY (...) ON CONFLICT <action>` directive. `defaultConflict` is
 * undefined when the PK was column-declared (column-level `ON CONFLICT`
 * lives on `ColumnSchema.defaultConflict`) or when no `ON CONFLICT` was
 * declared on the table-level constraint.
 * @throws QuereusError if multiple primary keys are defined or PK column not found.
 */
export function findPKDefinition(
	columns: ReadonlyArray<ColumnSchema>,
	constraints: ReadonlyArray<AST.TableConstraint> | undefined,
): {
	pkDef: ReadonlyArray<PrimaryKeyColumnDefinition>;
	defaultConflict: ConflictResolution | undefined;
} {
	const columnPK = findColumnPKDefinition(columns);
	const constraintPK = findConstraintPKDefinition(columns, constraints);

	if (constraintPK && columnPK) {
		throw new QuereusError("Cannot define both table-level and column-level PRIMARY KEYs", StatusCode.CONSTRAINT);
	}

	let finalPkDef: ReadonlyArray<PrimaryKeyColumnDefinition> | undefined =
		constraintPK?.pkDef ?? columnPK;

	if (!finalPkDef) {
		// Quereus-specific behavior: Include all columns in the primary key when no explicit primary key is defined
		// This differs from SQLite which would use the first INTEGER column or an implicit rowid
		// This design choice ensures predictable behavior and avoids potential confusion with SQLite's implicit rules
		warnLog(`No PRIMARY KEY explicitly defined. Including all columns in primary key.`);
		finalPkDef = Object.freeze(
			columns.map((col, index) => ({
				index,
				desc: false,
				collation: col.collation || 'BINARY'
			}))
		);
	}

	// Don't require NOT NULL, we want to be more flexible

	return {
		pkDef: finalPkDef,
		defaultConflict: constraintPK?.defaultConflict,
	};
}

function findConstraintPKDefinition(
	columns: readonly ColumnSchema[],
	constraints: readonly TableConstraint[] | undefined
): {
	pkDef: PrimaryKeyColumnDefinition[];
	defaultConflict: ConflictResolution | undefined;
} | undefined {
	const colMap = buildColumnIndexMap(columns);
	let result: {
		pkDef: PrimaryKeyColumnDefinition[];
		defaultConflict: ConflictResolution | undefined;
	} | undefined;

	if (constraints) {
		for (const constraint of constraints) {
			if (constraint.type === 'primaryKey') {
				if (result) {
					throw new QuereusError("Multiple table-level PRIMARY KEY constraints defined", StatusCode.CONSTRAINT);
				}
				let pkDef: PrimaryKeyColumnDefinition[];
				if (!constraint.columns || constraint.columns.length === 0) {
					// An empty column list is fine; means table can have 0-1 rows
					pkDef = [];
				} else {
					pkDef = constraint.columns.map(colInfo => {
						const colIndex = colMap.get(colInfo.name.toLowerCase());
						if (colIndex === undefined) {
							throw new QuereusError(`PRIMARY KEY column '${colInfo.name}' not found in table definition`, StatusCode.ERROR);
						}
						return {
							index: colIndex,
							desc: colInfo.direction === 'desc',
							collation: columns[colIndex].collation || 'BINARY'
						};
					});
				}
				result = { pkDef, defaultConflict: constraint.onConflict };
			}
		}
	}
	return result;
}

function findColumnPKDefinition(columns: ReadonlyArray<ColumnSchema>): ReadonlyArray<PrimaryKeyColumnDefinition> | undefined {
	const pkCols = columns
		.map((col, index) => ({ ...col, originalIndex: index }))
		.filter(col => col.primaryKey)
		.sort((a, b) => a.pkOrder - b.pkOrder);

	if (pkCols.length > 1 && pkCols.some(col => col.pkOrder === 0)) {
		warnLog("Multiple column-level PRIMARY KEYs defined without explicit pkOrder; consider a table-level PRIMARY KEY for composite keys.");
	}

	if (pkCols.length > 1) {
		warnLog('Multiple columns defined as PRIMARY KEY at column level. Forming a composite key.');
	}

	if (pkCols.length === 0) {
		return undefined;
	}

	return Object.freeze(pkCols.map(col => ({
		index: col.originalIndex,
		desc: col.pkDirection === 'desc',
		collation: col.collation || 'BINARY'
	})));
}

/**
 * Returns a copy of `tableSchema` with `generatedColumnDependencies` and
 * `generatedColumnTopoOrder` recomputed from its current column list.
 * Throws on cycle. The other fields are preserved as-is.
 */
export function withGeneratedColumnGraph(tableSchema: TableSchema): TableSchema {
	const rawDeps = extractGeneratedColumnDependencies(tableSchema.columns, tableSchema.name);
	if (rawDeps.size === 0) {
		return Object.freeze({
			...tableSchema,
			generatedColumnDependencies: undefined,
			generatedColumnTopoOrder: undefined,
		});
	}
	const topoOrder = topoSortGeneratedColumns(tableSchema.columns, rawDeps);
	const frozenDeps = new Map<number, ReadonlyArray<number>>();
	for (const [k, v] of rawDeps) frozenDeps.set(k, Object.freeze(v));
	return Object.freeze({
		...tableSchema,
		generatedColumnDependencies: frozenDeps,
		generatedColumnTopoOrder: Object.freeze(topoOrder),
	});
}

/**
 * For each generated column, walks its expression AST and collects the column
 * indices in this table that the expression references. Unknown column names
 * referenced unqualified (or qualified to this table) are rejected with a
 * specific error so typos surface at CREATE TABLE / ALTER TABLE time rather
 * than at INSERT/UPDATE time.
 *
 * References qualified to a different table are skipped — they belong to
 * an outer scope (e.g. a scalar subquery's source) and don't constitute a
 * dependency on this table's columns.
 */
export function extractGeneratedColumnDependencies(
	columns: ReadonlyArray<ColumnSchema>,
	tableName: string,
): Map<number, number[]> {
	const columnIndexMap = buildColumnIndexMap(columns);
	const tableNameLower = tableName.toLowerCase();
	const result = new Map<number, number[]>();

	columns.forEach((col, colIdx) => {
		if (!col.generated || !col.generatedExpr) return;

		const deps = new Set<number>();
		traverseAst(col.generatedExpr as AST.AstNode, {
			enterNode: (node: AST.AstNode) => {
				if (node.type === 'column') {
					const ref = node as AST.ColumnExpr;
					if (ref.table && ref.table.toLowerCase() !== tableNameLower) return;
					const refIdx = columnIndexMap.get(ref.name.toLowerCase());
					if (refIdx === undefined) {
						throw new QuereusError(
							`Column '${ref.name}' referenced by generated column '${col.name}' not found in table '${tableName}'`,
							StatusCode.ERROR,
						);
					}
					deps.add(refIdx);
				} else if (node.type === 'identifier') {
					const ref = node as AST.IdentifierExpr;
					if (ref.schema) return;
					const refIdx = columnIndexMap.get(ref.name.toLowerCase());
					if (refIdx !== undefined) deps.add(refIdx);
				}
			},
		});

		result.set(colIdx, Array.from(deps).sort((a, b) => a - b));
	});

	return result;
}

/**
 * Topologically sorts generated columns so a generated column's dependencies
 * come before it. Throws on any cycle (including self-edges).
 *
 * The graph nodes are generated-column indices only — edges from a generated
 * column to a non-generated column are ignored for topo purposes (only
 * gen→gen edges can form cycles).
 */
export function topoSortGeneratedColumns(
	columns: ReadonlyArray<ColumnSchema>,
	deps: ReadonlyMap<number, ReadonlyArray<number>>,
): number[] {
	const genIndices = new Set<number>();
	for (const idx of deps.keys()) genIndices.add(idx);

	// Build in-degree only over gen→gen edges
	const inDegree = new Map<number, number>();
	const adjacency = new Map<number, number[]>();
	for (const idx of genIndices) {
		inDegree.set(idx, 0);
		adjacency.set(idx, []);
	}
	for (const [genIdx, depList] of deps) {
		for (const depIdx of depList) {
			if (!genIndices.has(depIdx)) continue;
			adjacency.get(depIdx)!.push(genIdx);
			inDegree.set(genIdx, (inDegree.get(genIdx) ?? 0) + 1);
		}
	}

	// Kahn's algorithm
	const queue: number[] = [];
	for (const [idx, deg] of inDegree) {
		if (deg === 0) queue.push(idx);
	}
	queue.sort((a, b) => a - b); // Stable ordering: prefer declaration order on ties

	const order: number[] = [];
	while (queue.length > 0) {
		const idx = queue.shift()!;
		order.push(idx);
		for (const next of adjacency.get(idx) ?? []) {
			const newDeg = inDegree.get(next)! - 1;
			inDegree.set(next, newDeg);
			if (newDeg === 0) {
				// Insert preserving sorted order so output is deterministic
				let inserted = false;
				for (let i = 0; i < queue.length; i++) {
					if (queue[i] > next) {
						queue.splice(i, 0, next);
						inserted = true;
						break;
					}
				}
				if (!inserted) queue.push(next);
			}
		}
	}

	if (order.length < genIndices.size) {
		const offending = Array.from(genIndices)
			.filter(i => !order.includes(i))
			.map(i => `'${columns[i].name}'`)
			.join(', ');
		throw new QuereusError(
			`Cyclic dependency in generated columns: ${offending}`,
			StatusCode.ERROR,
		);
	}

	return order;
}

