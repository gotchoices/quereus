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
				{ name: 'sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }
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
						createSql
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
								indexSql
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
						viewSchema.sql
					] as Row;
				}

				// Process Functions
				for (const funcSchema of schemaInstance._getAllFunctions()) {
					yield [
						schemaName,
						'function',
						funcSchema.name,
						funcSchema.name,
						stringifyCreateFunction(funcSchema)
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
			yield ['', 'error', 'schema_error', 'schema_error', `Failed to introspect schema: ${error.message}`];
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
				{ name: 'pk', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
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

			yield [
				i,                                    // cid
				column.name,                         // name
				column.logicalType.name,             // type
				column.notNull ? 1 : 0,             // notnull
				column.defaultValue?.toString() || null, // dflt_value
				isPrimaryKey ? 1 : 0                // pk
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
			],
			keys: [],
			rowConstraints: []
		}
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
					seq,                                 // seq
				];
			}
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
		}
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
