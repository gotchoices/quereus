import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { createIntegratedTableValuedFunction } from "../registration.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Database } from "../../core/database.js";
import type { FunctionSchema } from "../../schema/function.js";
import { isScalarFunctionSchema, isTableValuedFunctionSchema, isAggregateFunctionSchema } from "../../schema/function.js";
import { isWindowFunction } from "../../schema/window-function.js";
import { Schema } from "../../schema/schema.js";
import { INTEGER_TYPE, TEXT_TYPE } from "../../types/builtin-types.js";
import { ColumnSchema } from "../../schema/column.js";
import { FunctionFlags } from "../../common/constants.js";
import { RowOpFlag } from "../../schema/table.js";
import { jsonStringify } from "../../util/serialization.js";
import { expressionToString } from "../../emit/ast-stringify.js";
import { createLogger } from "../../common/logger.js";
import type * as AST from "../../parser/ast.js";
import type { RelationalPlanNode, UpdateSite } from "../../planner/nodes/plan-node.js";
import { TableReferenceNode } from "../../planner/nodes/reference.js";
import { readDefaultFor } from "../../planner/mutation/mutation-tags.js";
import { isJoinBody, isDecomposableJoinBody } from "../../planner/mutation/multi-source.js";
import type { ViewSchema } from "../../schema/view.js";

const log = createLogger('func:view_info');

/**
 * Encodes a tag bag as a JSON object string. Returns null when there are no
 * tags so callers can use `WHERE tags IS NULL` to filter untagged objects.
 * BigInt values are coerced to JSON-safe numbers/strings via `jsonStringify`.
 */
function tagsToJson(tags: Readonly<Record<string, SqlValue>> | undefined): string | null {
	if (!tags) return null;
	const keys = Object.keys(tags);
	if (keys.length === 0) return null;
	return jsonStringify(tags);
}

/**
 * Converts a RowOpMask bitmask to a comma-joined operations list.
 * An empty/default mask returns the canonical default-all string so the
 * value round-trips cleanly.
 */
function rowOpMaskToString(mask: number): string {
	const parts: string[] = [];
	if (mask & RowOpFlag.INSERT) parts.push('insert');
	if (mask & RowOpFlag.UPDATE) parts.push('update');
	if (mask & RowOpFlag.DELETE) parts.push('delete');
	if (parts.length === 0) return 'insert,update,delete';
	return parts.join(',');
}

/**
 * Generates a function signature string for display
 */
function stringifyCreateFunction(func: FunctionSchema): string {
	const argsString = func.numArgs === -1
		? '...' // Indicate variable arguments
		: Array(func.numArgs).fill('?').join(', ');
	return `FUNCTION ${func.name}(${argsString})`;
}

// Schema introspection function (table-valued function)
export const schemaFunc = createIntegratedTableValuedFunction(
	{
		name: 'schema',
		numArgs: 0,
		deterministic: false, // Schema can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'schema', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tbl_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database): AsyncIterable<Row> {
		try {
			const schemaManager = db.schemaManager;

			const processSchemaInstance = function* (schemaInstance: Schema) {
				const schemaName = schemaInstance.name;

				// Process Tables
				for (const tableSchema of schemaInstance.getAllTables()) {
					let createSql: string | null = null;
					try {
						const columnsStr = tableSchema.columns.map((c: ColumnSchema) => `"${c.name}" ${c.logicalType.name}`).join(', ');
						const argsStr = Object.entries(tableSchema.vtabArgs ?? {}).map(([key, value]) => `${key}=${value}`).join(', ');
						createSql = `create table "${tableSchema.name}" (${columnsStr}) using ${tableSchema.vtabModuleName}(${argsStr})`;
					} catch {
						createSql = null;
					}

					yield [
						schemaName,
						tableSchema.isView ? 'view' : 'table',
						tableSchema.name,
						tableSchema.name,
						createSql,
						tagsToJson(tableSchema.tags)
					] as Row;

					// Process Indexes for this table
					if (tableSchema.indexes) {
						for (const indexSchema of tableSchema.indexes) {
							let indexSql: string | null = null;
							try {
								const indexColumns = indexSchema.columns.map(col => {
									const column = tableSchema.columns[col.index];
									let colStr = `"${column.name}"`;
									if (col.collation) {
										colStr += ` COLLATE ${col.collation}`;
									}
									if (col.desc) {
										colStr += ' DESC';
									}
									return colStr;
								}).join(', ');
								indexSql = `CREATE INDEX "${indexSchema.name}" ON "${tableSchema.name}" (${indexColumns})`;
							} catch {
								indexSql = null;
							}

							yield [
								schemaName,
								'index',
								indexSchema.name,
								tableSchema.name,
								indexSql,
								tagsToJson(indexSchema.tags)
							] as Row;
						}
					}
				}

				// Process Views
				for (const viewSchema of schemaInstance.getAllViews()) {
					yield [
						schemaName,
						'view',
						viewSchema.name,
						viewSchema.name,
						viewSchema.sql,
						tagsToJson(viewSchema.tags)
					] as Row;
				}

				// Process Functions
				for (const funcSchema of schemaInstance._getAllFunctions()) {
					yield [
						schemaName,
						'function',
						funcSchema.name,
						funcSchema.name,
						stringifyCreateFunction(funcSchema),
						null
					] as Row;
				}
			};

			// Process all schemas
			for (const schemaInstance of schemaManager._getAllSchemas()) {
				yield* processSchemaInstance(schemaInstance);
			}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (error: any) {
			// If schema introspection fails, yield an error row
			yield ['', 'error', 'schema_error', 'schema_error', `Failed to introspect schema: ${error.message}`, null];
		}
	}
);

// Table information function (table-valued function)
export const tableInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'table_info',
		numArgs: 1,
		deterministic: false, // Table structure can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'cid', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'notnull', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'dflt_value', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'pk', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'collation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'generated', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// `cid` (column 0) is the column ordinal — unique per row.
			keys: [[{ index: 0 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('table_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		for (let i = 0; i < table.columns.length; i++) {
			const column = table.columns[i];
			const isPrimaryKey = table.primaryKeyDefinition.some(pk => pk.index === i);
			// 0 = not generated, 1 = virtual generated, 2 = stored generated
			const generatedFlag = column.generated
				? (column.generatedStored ? 2 : 1)
				: 0;

			yield [
				i,                                    // cid
				column.name,                         // name
				column.logicalType.name,             // type
				column.notNull ? 1 : 0,             // notnull
				column.defaultValue?.toString() || null, // dflt_value
				isPrimaryKey ? 1 : 0,               // pk
				tagsToJson(column.tags),            // tags
				column.collation || 'BINARY',       // collation
				generatedFlag                       // generated
			];
		}
	}
);

// Foreign key information function (table-valued function)
export const foreignKeyInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'foreign_key_info',
		numArgs: 1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'table', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'from', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'referenced_table', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'referenced_schema', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'to', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'on_update', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'on_delete', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deferred', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'seq', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite key (id, seq): each FK has one row per referenced column.
			keys: [[{ index: 0 }, { index: 10 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('foreign_key_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		const foreignKeys = table.foreignKeys;
		if (!foreignKeys) return;

		for (let fkIdx = 0; fkIdx < foreignKeys.length; fkIdx++) {
			const fk = foreignKeys[fkIdx];
			const fkTagJson = tagsToJson(fk.tags);
			for (let seq = 0; seq < fk.columns.length; seq++) {
				const fromCol = table.columns[fk.columns[seq]];

				// Resolve parent column name
				let toColName: string;
				if (fk.referencedColumnNames && fk.referencedColumnNames[seq]) {
					toColName = fk.referencedColumnNames[seq];
				} else {
					const parentTable = db._findTable(fk.referencedTable);
					if (parentTable) {
						toColName = parentTable.columns[fk.referencedColumns[seq]].name;
					} else {
						toColName = String(fk.referencedColumns[seq]);
					}
				}

				yield [
					fkIdx,                              // id
					fk.name ?? null,                    // name
					table.name,                         // table
					fromCol.name,                       // from
					fk.referencedTable,                 // referenced_table
					fk.referencedSchema ?? null,        // referenced_schema
					toColName,                          // to
					fk.onUpdate,                        // on_update
					fk.onDelete,                        // on_delete
					fk.deferred ? 1 : 0,                // deferred
					seq,                                // seq
					fkTagJson,                          // tags
				];
			}
		}
	}
);

// Index information function (table-valued function)
export const indexInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'index_info',
		numArgs: 1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'index_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'seq', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'column_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'desc', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'collation', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'unique', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'partial', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite key (index_name, seq): each index has one row per indexed column position.
			keys: [[{ index: 0 }, { index: 1 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('index_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		if (!table.indexes) return;

		for (const idx of table.indexes) {
			const tagJson = tagsToJson(idx.tags);
			const uniqueFlag = idx.unique ? 1 : 0;
			const partialFlag = idx.predicate ? 1 : 0;
			for (let seq = 0; seq < idx.columns.length; seq++) {
				const col = idx.columns[seq];
				const tableCol = table.columns[col.index];
				yield [
					idx.name,                       // index_name
					seq,                            // seq
					tableCol.name,                  // column_name
					col.desc ? 1 : 0,               // desc
					col.collation ?? null,          // collation
					uniqueFlag,                     // unique
					partialFlag,                    // partial
					tagJson,                        // tags
				];
			}
		}
	}
);

// CHECK constraint information function (table-valued function)
export const checkConstraintInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'check_constraint_info',
		numArgs: 1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'expr', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operations', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deferrable', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'initially_deferred', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// `id` (column 0) is the constraint ordinal — unique per emitted row.
			keys: [[{ index: 0 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('check_constraint_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		const checks = table.checkConstraints;
		for (let i = 0; i < checks.length; i++) {
			const cc = checks[i];
			yield [
				i,                                  // id
				cc.name ?? null,                    // name
				expressionToString(cc.expr),        // expr
				rowOpMaskToString(cc.operations),   // operations
				cc.deferrable ? 1 : 0,              // deferrable
				cc.initiallyDeferred ? 1 : 0,       // initially_deferred
				tagsToJson(cc.tags),                // tags
			];
		}
	}
);

// UNIQUE constraint information function (table-valued function)
export const uniqueConstraintInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'unique_constraint_info',
		numArgs: 1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'seq', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'column_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'partial', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tags', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite (id, seq): one row per (constraint, column position).
			keys: [[{ index: 0 }, { index: 2 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('unique_constraint_info() requires a table name string argument', StatusCode.ERROR);
		}

		const table = db._findTable(tableName);
		if (!table) {
			throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
		}

		const uniques = table.uniqueConstraints;
		if (!uniques) return;

		for (let i = 0; i < uniques.length; i++) {
			const uc = uniques[i];
			const tagJson = tagsToJson(uc.tags);
			const partialFlag = uc.predicate ? 1 : 0;
			for (let seq = 0; seq < uc.columns.length; seq++) {
				const tableCol = table.columns[uc.columns[seq]];
				yield [
					i,                          // id
					uc.name ?? null,            // name
					seq,                        // seq
					tableCol.name,              // column_name
					partialFlag,                // partial
					tagJson,                    // tags
				];
			}
		}
	}
);

// Assertion information function (table-valued function)
export const assertionInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'assertion_info',
		numArgs: 0,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'violation_sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deferrable', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'initially_deferred', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'dependent_tables', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			keys: [[{ index: 0 }]],
		},
	},
	async function* (db: Database): AsyncIterable<Row> {
		for (const assertion of db.schemaManager.getAllAssertions()) {
			const deps = assertion.dependentTables ?? [];
			yield [
				assertion.name,
				assertion.violationSql,
				assertion.deferrable ? 1 : 0,
				assertion.initiallyDeferred ? 1 : 0,
				jsonStringify(deps),
			];
		}
	}
);

export function classifyFunction(funcSchema: FunctionSchema): string {
	if (isWindowFunction(funcSchema.name)) return 'window';
	if (isScalarFunctionSchema(funcSchema)) return 'scalar';
	if (isTableValuedFunctionSchema(funcSchema)) return 'table';
	if (isAggregateFunctionSchema(funcSchema)) return 'aggregate';
	return 'unknown';
}

function* yieldFunctionRow(funcSchema: FunctionSchema) {
	const isDeterministic = (funcSchema.flags & FunctionFlags.DETERMINISTIC) !== 0;
	yield [
		funcSchema.name,
		funcSchema.numArgs,
		classifyFunction(funcSchema),
		isDeterministic ? 1 : 0,
		funcSchema.flags,
		stringifyCreateFunction(funcSchema)
	] as Row;
}

// Function information function (table-valued function)
export const functionInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'function_info',
		numArgs: -1,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'num_args', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deterministic', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'flags', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'signature', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite (name, num_args): function-key matches the (name, numArgs) registration key.
			keys: [[{ index: 0 }, { index: 1 }]],
		},
	},
	async function* (db: Database, filterName?: SqlValue): AsyncIterable<Row> {
		const nameFilter = (typeof filterName === 'string') ? filterName.toLowerCase() : null;

		try {
			const schemaManager = db.schemaManager;

			for (const schemaInstance of schemaManager._getAllSchemas()) {
				for (const funcSchema of schemaInstance._getAllFunctions()) {
					if (nameFilter !== null && funcSchema.name.toLowerCase() !== nameFilter) continue;
					yield* yieldFunctionRow(funcSchema);
				}
			}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (error: any) {
			yield ['error', -1, 'error', 0, 0, `Failed to get function info: ${error.message}`];
		}
	}
);

// ---------------------------------------------------------------------------
// view_info(): per-view updateability surface.
//
// The engine-idiomatic realization of `docs/view-updateability.md`
// § Information Schema Surface's `information_schema.views`: a read-only TVF
// (consistent with the `*_info` introspection family) projecting the four
// view-level updateability columns over plain (non-materialized) views.
//
// Every value is derived **statically** from the planned view body's backward
// `updateLineage` / `attributeDefaults` (threaded onto `PhysicalProperties` by
// the view-mutation lineage pass) plus the base-table not-null/default/generated
// flags — no dry-run mutation. The substrate's `propagate()` insert / delete
// paths remain the authoritative *dynamic* check; this surface is the
// conservative static reading (cross-checked by test, not invoked here).
// ---------------------------------------------------------------------------

/** Derived view-level updateability facts (pre-`'YES'`/`'NO'` encoding). */
interface ViewInfoRow {
	readonly isInsertableInto: boolean;
	readonly isUpdatable: boolean;
	readonly isDeletable: boolean;
	/** Distinct base-table names reachable by default, sorted for determinism. */
	readonly effectiveTargets: string[];
}

/** The conservative all-`NO` / `[]` row for a body with no recoverable base lineage. */
const CONSERVATIVE_VIEW_INFO: ViewInfoRow = {
	isInsertableInto: false,
	isUpdatable: false,
	isDeletable: false,
	effectiveTargets: [],
};

/** SQL-standard `'YES'`/`'NO'` text encoding for a boolean updateability flag. */
function yesNo(value: boolean): string {
	return value ? 'YES' : 'NO';
}

/**
 * Resolve an UpdateSite to its underlying base reference: the producing
 * `TableReferenceNode` id + base column for a `base` site, else `undefined`
 * (a `computed` / leaf-less site).
 *
 * The `null-extended` unwrap is now defensive only: `deriveViewInfo`
 * short-circuits any body carrying a `null-extended` site to the conservative
 * row (`hasNullExtendedLineage`) *before* this is reached, so on a cleared body
 * this only ever sees plain `base` sites and the unwrap is a no-op. It is
 * retained for the future per-side relaxation — when outer-join write
 * materialization lands and the gate softens to per-side writability, this will
 * again resolve the preserved side's base for `effective_targets` membership.
 */
function baseSiteOf(site: UpdateSite | undefined): { readonly table: number; readonly baseColumn: string } | undefined {
	let s = site;
	while (s && s.kind === 'null-extended') s = s.inner;
	return s && s.kind === 'base' ? { table: s.table, baseColumn: s.baseColumn } : undefined;
}

/** Every relational node in the planned body (deduped), root-first. */
function collectBodyNodes(root: RelationalPlanNode): RelationalPlanNode[] {
	const out: RelationalPlanNode[] = [];
	const seen = new Set<RelationalPlanNode>();
	const visit = (n: RelationalPlanNode): void => {
		if (seen.has(n)) return;
		seen.add(n);
		out.push(n);
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	return out;
}

/**
 * Index every `TableReferenceNode` in a planned body by its numeric node id.
 * Shared by `deriveViewInfo` and `deriveColumnInfo`: an UpdateSite's `table`
 * field is the producing reference's id, which both surfaces resolve back to a
 * base-table name through this map.
 */
function buildTableRefsById(nodes: RelationalPlanNode[]): Map<number, TableReferenceNode> {
	const tableRefsById = new Map<number, TableReferenceNode>();
	for (const n of nodes) {
		if (n instanceof TableReferenceNode) tableRefsById.set(Number(n.id), n);
	}
	return tableRefsById;
}

/**
 * True when any collected body node carries a `null-extended` lineage site —
 * the signature of a LEFT/RIGHT/FULL outer-join body (`deriveJoinUpdateLineage`
 * wraps the non-preserved side `null-extended`). `propagateMultiSource` rejects
 * the *entire* outer join today (`collectInnerJoinSources` accepts only inner
 * equi-joins, on either side), so such a body supports no mutation at all;
 * `deriveViewInfo` short-circuits it to the conservative row to agree with
 * `propagate()`. Walks the whole spine — not just the root — because an outer
 * join whose non-preserved columns are all projected away still carries the
 * `null-extended` sites on the `JoinNode`'s own lineage.
 */
function hasNullExtendedLineage(nodes: RelationalPlanNode[]): boolean {
	for (const n of nodes) {
		const l = n.physical?.updateLineage;
		if (l) for (const site of l.values()) if (site.kind === 'null-extended') return true;
	}
	return false;
}

/** Record `baseColumn` (lowercased) as defaultable for base table `table`. */
function addDefaultable(map: Map<number, Set<string>>, table: number, baseColumn: string): void {
	const set = map.get(table) ?? new Set<string>();
	set.add(baseColumn.toLowerCase());
	map.set(table, set);
}

/**
 * Derive the four view-level updateability columns statically from the planned
 * view body. The **logical** tree is used deliberately (via `_buildPlan`, not
 * `getPlan`): it preserves the Project/Filter/Join/TableReference operator
 * structure that threads `updateLineage`, whereas the optimizer degrades a join's
 * top-node lineage to `computed` (docs/view-updateability.md § surface authority).
 * This mirrors the view-mutation substrate (`planner/mutation/*`), which plans the
 * body logically for the same reason — so `effective_targets` agrees with the
 * base set `propagate()` reaches.
 *
 * Re-plans on every call (same re-plan-on-read posture as `deriveBackingShape`);
 * caching is a later optimization.
 */
function deriveViewInfo(db: Database, view: ViewSchema): ViewInfoRow {
	const { plan } = db._buildPlan([view.selectAst as AST.Statement]);
	const root = plan.getRelations()[0];
	if (!root) return CONSERVATIVE_VIEW_INFO;

	const nodes = collectBodyNodes(root);

	// Outer-join gate (Divergence 2): a body carrying any `null-extended` site is
	// a LEFT/RIGHT/FULL outer join, which `propagate()` rejects wholesale today
	// (both sides). Short-circuit to the conservative row before the target walk
	// so `view_info()` agrees with the dynamic truth, regardless of which columns
	// the projection keeps. Inner-join bodies never null-extend, so the
	// multi-source positive case (`ms_jv`) is untouched.
	if (hasNullExtendedLineage(nodes)) return CONSERVATIVE_VIEW_INFO;

	// Non-inner-join shape gate (Divergence 3): cross / comma (implicit) / subquery- or
	// function-source join bodies never null-extend (only LEFT/RIGHT/FULL do — see
	// `deriveJoinUpdateLineage`), so they carry strict-`base` lineage and slip past the
	// outer-join gate above. `propagate()` decomposes an n-way (≥2) inner equi-join —
	// composite-PK sides and self-joins included (`isDecomposableJoinBody`, the boolean
	// shadow of `collectInnerJoinSources`) — and rejects every other join shape, so
	// without this gate the target walk below resolves their bases and over-reports
	// `is_updatable = 'YES'` (and possibly insertable/deletable). Mirrors the same gate
	// in `deriveColumnInfo`: this reads the AST shape, `hasNullExtendedLineage` reads
	// lineage — kept parallel as defense-in-depth. The accepted inner-join positive cases
	// (`ms_jv`, n-way, composite-PK, self-join) are not a match (`isDecomposableJoinBody`
	// accepts them) and stay writable.
	if (isJoinBody(view.selectAst) && !isDecomposableJoinBody(view.selectAst)) {
		return CONSERVATIVE_VIEW_INFO;
	}

	const tableRefsById = buildTableRefsById(nodes);

	// Output-column lineage: effective targets, the per-table set of base columns
	// exposed by the projection, and the is_updatable flag (≥1 output column with
	// base lineage — docs: "at least one output column has base lineage").
	const rootLineage = root.physical?.updateLineage;
	const targetIds = new Set<number>();
	const exposed = new Map<number, Set<string>>();
	let anyBase = false;
	for (const attr of root.getAttributes()) {
		const bs = baseSiteOf(rootLineage?.get(attr.id));
		if (!bs) continue;
		anyBase = true;
		targetIds.add(bs.table);
		const set = exposed.get(bs.table) ?? new Set<string>();
		set.add(bs.baseColumn.toLowerCase());
		exposed.set(bs.table, set);
	}

	// No base lineage at the root ⇒ wholly read-only (VALUES / aggregate / set-op /
	// computed-only / recursive-CTE body). The conservative row falls straight out.
	if (targetIds.size === 0) return CONSERVATIVE_VIEW_INFO;

	// Defaultable base columns: every (node, attribute) carrying an insert default
	// (`constant-fd` selection pin, declared `base-default`, `tag-default`),
	// resolved through THAT node's own lineage back to a base column. Walking the
	// whole spine — not just the root — recovers a *projected-away* constant-FD
	// column (e.g. `select name from t where color = 'green'`, where `color`'s
	// default lives on the Filter, below the projection that drops it).
	const defaultable = new Map<number, Set<string>>();
	for (const n of nodes) {
		const nl = n.physical?.updateLineage;
		const nd = n.physical?.attributeDefaults;
		if (!nl || !nd) continue;
		for (const attrId of nd.keys()) {
			const bs = baseSiteOf(nl.get(attrId));
			if (!bs) continue;
			addDefaultable(defaultable, bs.table, bs.baseColumn);
		}
	}

	// View-level `default_for.<col>` tags (Divergence 1): the `tag-default`
	// provenance is never threaded onto `PhysicalProperties` (it is consumed only
	// in the rewrite), so this body is planned without the view's tags and the
	// walk above misses it. Fold each tag column into `defaultable` directly,
	// mirroring `resolveDefaultForColumn` — a base column of a reachable target
	// (the common projected-away case) or a visible view-output column with base
	// lineage. Unlike the rewrite, an unresolvable name is silently skipped: a
	// read-only introspection surface stays on its never-throw posture (the
	// per-view try/catch would otherwise collapse the row to all-`NO`).
	for (const colName of readDefaultFor(view.tags).keys()) {
		let resolved = false;
		for (const id of targetIds) {
			const match = tableRefsById.get(id)?.tableSchema.columns
				.find(c => c.name.toLowerCase() === colName);
			if (match) {
				addDefaultable(defaultable, id, match.name);
				resolved = true;
			}
		}
		if (resolved) continue;

		const attr = root.getAttributes().find(a => a.name.toLowerCase() === colName);
		const bs = attr && baseSiteOf(rootLineage?.get(attr.id));
		if (bs) addDefaultable(defaultable, bs.table, bs.baseColumn);
	}

	const targetNames = new Set<string>();
	let isDeletable = true;
	let isInsertableInto = true;
	for (const id of targetIds) {
		const ref = tableRefsById.get(id);
		if (!ref) {
			// A base-site id with no resolved TableReferenceNode should not happen
			// (root lineage ids come from the nodes we collected); fail conservative.
			isDeletable = false;
			isInsertableInto = false;
			continue;
		}
		const tbl = ref.tableSchema;
		targetNames.add(tbl.name);
		const exp = exposed.get(id) ?? new Set<string>();
		const def = defaultable.get(id) ?? new Set<string>();

		// Deletable iff every PK column of this base is exposed through base lineage
		// (so `pk = <view value>` is constructible). A keyless base is undeletable.
		const pkCols = tbl.primaryKeyDefinition.map(pk => tbl.columns[pk.index].name.toLowerCase());
		if (pkCols.length === 0 || !pkCols.every(c => exp.has(c))) isDeletable = false;

		// Insertable iff every not-null-without-declared-default, non-generated base
		// column has a recoverable value: projected (exposed) or carries an insert
		// default. Generated columns are computed/auto; nullable columns take null;
		// declared-default columns supply themselves.
		for (const col of tbl.columns) {
			if (col.generated || !col.notNull || col.defaultValue != null) continue;
			const name = col.name.toLowerCase();
			if (!exp.has(name) && !def.has(name)) {
				isInsertableInto = false;
				break;
			}
		}
	}

	return {
		isInsertableInto,
		isUpdatable: anyBase,
		isDeletable,
		effectiveTargets: [...targetNames].sort(),
	};
}

// View updateability function (table-valued function)
export const viewInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'view_info',
		numArgs: -1,
		deterministic: false, // Schema (and therefore lineage) can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'schema', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'is_insertable_into', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'is_updatable', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'is_deletable', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'effective_targets', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// Composite (schema, name): a view is unique per (schema, name) — guards
			// against same-named views across schemas (main / temp / …).
			keys: [[{ index: 0 }, { index: 1 }]],
		},
	},
	async function* (db: Database, filterName?: SqlValue): AsyncIterable<Row> {
		const nameFilter = (typeof filterName === 'string') ? filterName.toLowerCase() : null;

		for (const schemaInstance of db.schemaManager._getAllSchemas()) {
			for (const view of schemaInstance.getAllViews()) {
				if (nameFilter !== null && view.name.toLowerCase() !== nameFilter) continue;

				let info: ViewInfoRow;
				try {
					info = deriveViewInfo(db, view);
				} catch (error) {
					// Per-view conservative fallback: a body that fails to plan (stale
					// source, unsupported shape) yields the all-`NO` / `[]` row rather
					// than throwing the whole TVF. Logged so a genuinely unexpected
					// failure is not silently swallowed.
					log('conservative row for view %s.%s: %s', schemaInstance.name, view.name,
						error instanceof Error ? error.message : String(error));
					info = CONSERVATIVE_VIEW_INFO;
				}

				yield [
					schemaInstance.name,
					view.name,
					yesNo(info.isInsertableInto),
					yesNo(info.isUpdatable),
					yesNo(info.isDeletable),
					jsonStringify(info.effectiveTargets),
				] as Row;
			}
		}
	}
);

// ---------------------------------------------------------------------------
// column_info(name): per-column updateability surface.
//
// The column-granular companion to `view_info()` — the engine-idiomatic
// realization of `docs/view-updateability.md` § Information Schema Surface's
// `information_schema.columns.is_updatable`, covering every column of every base
// table and plain (non-materialized) view. `view_info : schema()` ::
// `column_info : table_info`.
//
// A dedicated TVF (not a `table_info` extension): `table_info` resolves base
// tables only (`_findTable`), whereas views live in a separate catalog map and
// carry none of the per-column metadata `table_info` emits. `column_info`
// resolves *either* a base table or a view and emits only the column-granular
// updateability facts, uniformly.
//
// Every value is derived **statically**: a base column's `is_updatable` is just
// `!generated`; a view column's is read from the planned body's backward
// `updateLineage` (the same substrate `view_info()` reads) — no dry-run
// mutation, no new planner pass.
// ---------------------------------------------------------------------------

/** Per-column updateability facts for one emitted `column_info` row (pre-encoding). */
interface ColumnInfoRow {
	readonly schema: string;
	readonly objectName: string;
	readonly cid: number;
	readonly columnName: string;
	readonly isUpdatable: boolean;
	readonly baseTable: string | null;
	readonly baseColumn: string | null;
}

/**
 * Derive the per-column updateability rows for a base table or plain view.
 *
 * **Base table** (`_findTable` hit) — every non-generated column is trivially a
 * `base` write target; generated columns are computed/read-only. The `schema`
 * comes straight off the resolved `TableSchema.schemaName`.
 *
 * **Plain view** (first `getView` hit across schemas, main→temp→attached order
 * mirroring `_findTable`) — plan the body **logically** (via `_buildPlan`, not
 * `getPlan`, for the same lineage-preservation reason as `deriveViewInfo`) and
 * read each output attribute's backward `updateLineage` site. A `base` site
 * (unwrapped through `null-extended`) that resolves to a `TableReferenceNode`
 * is updatable and carries its base table/column trace; everything else is
 * read-only with `null` trace.
 *
 * Throws `'<name>' not found` when neither resolves (parity with `table_info`'s
 * required-target posture — `column_info` takes a *required* name, unlike
 * `view_info`'s optional filter). A view body that fails to plan or yields no
 * relational output produces *no rows* (logged) — the conservative, never-throw
 * posture `view_info` takes, but at row granularity there is no all-`NO` row to
 * emit. Materialized views resolve to neither path (their backing table is the
 * reserved `_mv_<name>`), so an MV name throws not-found — consistent with
 * `view_info` excluding MVs.
 */
function deriveColumnInfo(db: Database, name: string): ColumnInfoRow[] {
	// Base table first (mirrors table_info's `_findTable`-only resolution).
	const table = db._findTable(name);
	if (table) {
		return table.columns.map((col, i): ColumnInfoRow => {
			const updatable = !col.generated;
			return {
				schema: table.schemaName,
				objectName: table.name,
				cid: i,
				columnName: col.name,
				isUpdatable: updatable,
				baseTable: updatable ? table.name : null,
				baseColumn: updatable ? col.name : null,
			};
		});
	}

	// View fallback: first `getView` hit across schemas (main → temp → attached,
	// the insertion order `_getAllSchemas` yields — same order `_findTable` uses).
	let view: ViewSchema | undefined;
	let schemaName: string | undefined;
	for (const schemaInstance of db.schemaManager._getAllSchemas()) {
		const v = schemaInstance.getView(name);
		if (v) { view = v; schemaName = schemaInstance.name; break; }
	}
	if (!view || schemaName === undefined) {
		throw new QuereusError(`'${name}' not found`, StatusCode.ERROR);
	}

	try {
		const { plan } = db._buildPlan([view.selectAst as AST.Statement]);
		const root = plan.getRelations()[0];
		if (!root) return [];

		const nodes = collectBodyNodes(root);

		// Outer-join gate (mirrors `deriveViewInfo`'s Divergence 2): a body carrying
		// any `null-extended` site is a LEFT/RIGHT/FULL outer join, which
		// `propagate()` rejects wholesale today (both sides — `collectInnerJoinSources`
		// accepts only inner equi-joins), so *every* column is non-updatable. Without
		// this gate `baseSiteOf` would unwrap `null-extended` to the inner base and
		// over-report a preserved-side column as `'YES'` even though no write through
		// the view is accepted — disagreeing with both `view_info()` (which short-
		// circuits the same body to all-`NO`) and the dynamic truth. When per-side
		// write materialization lands and the gate softens, both surfaces relax
		// together (see `baseSiteOf`'s forward-looking note).
		const outerJoin = hasNullExtendedLineage(nodes);

		// Non-inner-join shape gate (Divergence 3): cross / comma / subquery-source join
		// bodies never null-extend (only LEFT/RIGHT/FULL do), so they carry strict-
		// `base` lineage and slip past `outerJoin`. `propagate()` decomposes an n-way
		// (≥2) inner equi-join — composite-PK sides and self-joins included
		// (`isDecomposableJoinBody`, the boolean shadow of `collectInnerJoinSources`) —
		// and rejects every other join shape, so without this gate `baseSiteOf` resolves
		// their bases and over-reports `is_updatable = 'YES'`. The shape check subsumes
		// the `outerJoin` gate for join bodies (it also rejects `joinType !== 'inner'`);
		// both are kept as parallel, defense-in-depth gates mirroring `deriveViewInfo`'s
		// structure — `outerJoin` reads lineage, this reads the AST shape.
		const unsupportedJoinShape = isJoinBody(view.selectAst) && !isDecomposableJoinBody(view.selectAst);

		const tableRefsById = buildTableRefsById(nodes);
		const rootLineage = root.physical?.updateLineage;

		const attrs = root.getAttributes();
		const rows: ColumnInfoRow[] = [];
		for (let i = 0; i < attrs.length; i++) {
			const attr = attrs[i];
			const bs = (outerJoin || unsupportedJoinShape) ? undefined : baseSiteOf(rootLineage?.get(attr.id));
			const ref = bs ? tableRefsById.get(bs.table) : undefined;
			// Updatable iff a base site resolves to a producing TableReferenceNode.
			// A base id without a resolved ref should not happen (root lineage ids
			// come from the collected nodes); fail conservative if it does.
			const updatable = !!(bs && ref);
			rows.push({
				schema: schemaName,
				objectName: view.name,
				cid: i,
				columnName: attr.name,
				isUpdatable: updatable,
				baseTable: updatable ? ref!.tableSchema.name : null,
				baseColumn: updatable ? bs!.baseColumn : null,
			});
		}
		return rows;
	} catch (error) {
		// A body that fails to plan (stale source, unsupported shape) yields no
		// rows rather than throwing the whole TVF — logged so a genuinely
		// unexpected failure is not silently swallowed.
		log('column_info: no rows for view %s.%s: %s', schemaName, view.name,
			error instanceof Error ? error.message : String(error));
		return [];
	}
}

// Per-column updateability function (table-valued function)
export const columnInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'column_info',
		numArgs: 1,
		deterministic: false, // Schema (and therefore lineage) can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'schema', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'cid', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'column_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'is_updatable', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'base_table', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'base_column', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// `cid` (column 2) is the column ordinal — unique per emitted row.
			keys: [[{ index: 2 }]],
		},
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('column_info() requires a table or view name string argument', StatusCode.ERROR);
		}

		for (const r of deriveColumnInfo(db, tableName)) {
			yield [
				r.schema,
				r.objectName,
				r.cid,
				r.columnName,
				yesNo(r.isUpdatable),
				r.baseTable,
				r.baseColumn,
			] as Row;
		}
	}
);
