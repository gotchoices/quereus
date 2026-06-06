/**
 * Shared AST → constraint-schema builders plus the engine-level FK existing-row
 * validator. These are the single source of truth for turning a table-level
 * `ALTER TABLE … ADD <constraint>` (an `AST.TableConstraint`) into the
 * corresponding {@link UniqueConstraintSchema} / {@link ForeignKeyConstraintSchema},
 * reproducing the canonical mapping that {@link SchemaManager}'s
 * `extractUniqueConstraints` / `extractForeignKeys` table-level arms encode for
 * CREATE TABLE. Both the built-in modules (memory + store, via the
 * `@quereus/quereus` barrel) and the SchemaManager delegate here so the two
 * paths can never drift.
 *
 * Column resolution is always against the CHILD table's `columnIndexMap`
 * (`ALTER TABLE ADD CONSTRAINT` is always the table-level form). Parent-column
 * resolution for a FK stays deferred (the parent may not exist yet) exactly as
 * in the CREATE TABLE path.
 */

import type { Database } from '../core/database.js';
import type { TableSchema, UniqueConstraintSchema, ForeignKeyConstraintSchema } from './table.js';
import { resolveReferencedColumns } from './table.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type * as AST from '../parser/ast.js';
import { quoteIdentifier } from '../emit/ast-stringify.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('schema:constraint-builder');

/**
 * Builds a {@link UniqueConstraintSchema} from a table-level UNIQUE
 * `AST.TableConstraint`, resolving each declared column name to its index in the
 * child table. Mirrors `SchemaManager.extractUniqueConstraints` (table-level arm).
 */
export function buildUniqueConstraintSchema(
	con: AST.TableConstraint,
	columnIndexMap: ReadonlyMap<string, number>,
): UniqueConstraintSchema {
	if (con.type !== 'unique' || !con.columns || con.columns.length === 0) {
		throw new QuereusError('UNIQUE constraint requires at least one column', StatusCode.ERROR);
	}
	const colIndices = con.columns.map(col => {
		const idx = columnIndexMap.get(col.name.toLowerCase());
		if (idx === undefined) {
			throw new QuereusError(`UNIQUE constraint column '${col.name}' not found`, StatusCode.ERROR);
		}
		return idx;
	});
	return {
		name: con.name,
		columns: Object.freeze(colIndices),
		defaultConflict: con.onConflict,
		tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
	};
}

/**
 * Builds a {@link ForeignKeyConstraintSchema} from a table-level FOREIGN KEY
 * `AST.TableConstraint`, resolving child column names to indices and deferring
 * parent-column resolution (the parent table may not exist yet). Mirrors
 * `SchemaManager.extractForeignKeys` (table-level arm), including the
 * child/parent column-count mismatch error.
 */
export function buildForeignKeyConstraintSchema(
	con: AST.TableConstraint,
	columnIndexMap: ReadonlyMap<string, number>,
	childTableName: string,
	childSchemaName: string,
): ForeignKeyConstraintSchema {
	if (con.type !== 'foreignKey' || !con.foreignKey || !con.columns) {
		throw new QuereusError('FOREIGN KEY constraint requires child columns and a REFERENCES clause', StatusCode.ERROR);
	}
	const fk = con.foreignKey;
	const childColIndices = con.columns.map(col => {
		const idx = columnIndexMap.get(col.name.toLowerCase());
		if (idx === undefined) {
			throw new QuereusError(`FK column '${col.name}' not found in table '${childTableName}'`, StatusCode.ERROR);
		}
		return idx;
	});

	const fkName = con.name ?? `_fk_${childTableName}_${con.columns.map(c => c.name).join('_')}`;

	if (fk.columns && fk.columns.length !== childColIndices.length) {
		throw new QuereusError(
			`FK constraint '${fkName}' on table '${childTableName}': child column count (${childColIndices.length}) does not match parent column count (${fk.columns.length})`,
			StatusCode.ERROR,
		);
	}

	return {
		name: fkName,
		columns: Object.freeze(childColIndices),
		referencedTable: fk.table,
		referencedSchema: childSchemaName,
		referencedColumns: Object.freeze([]), // resolved at enforcement time
		referencedColumnNames: fk.columns, // deferred resolution via resolveReferencedColumns
		onDelete: fk.onDelete ?? 'restrict',
		onUpdate: fk.onUpdate ?? 'restrict',
		deferred: fk.initiallyDeferred ?? false,
		tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
	};
}

/** Qualify a relation reference, eliding the `main.` prefix (the default schema). */
function qualifyRelation(schemaName: string, tableName: string): string {
	const prefix = schemaName.toLowerCase() !== 'main' ? `${quoteIdentifier(schemaName)}.` : '';
	return `${prefix}${quoteIdentifier(tableName)}`;
}

/**
 * Validates every existing CHILD row against a newly-added FOREIGN KEY,
 * throwing `StatusCode.CONSTRAINT` if any row references a non-existent parent.
 *
 * Engine-level and backend-agnostic: it reads committed/base data through
 * `db.prepare` + scan (which does not take any module schema-change latch, so it
 * is safe to call while a module holds its own schema-change lock). No-op when
 * `pragma foreign_keys` is off.
 *
 * MATCH SIMPLE semantics: a child row with ANY NULL FK column is allowed
 * regardless of the parent, so only fully-non-NULL orphans abort. When the
 * parent table is absent, no fully-non-NULL child row can be satisfied, so any
 * such row is an orphan (mirrors the child-side builder's null-guards-only
 * fallback in `planner/building/foreign-key-builder.ts`).
 */
export async function validateForeignKeyOverExistingRows(
	db: Database,
	childSchema: TableSchema,
	fk: ForeignKeyConstraintSchema,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const childRef = qualifyRelation(childSchema.schemaName, childSchema.name);
	const childAlias = '_c';
	// MATCH SIMPLE: only rows where every FK column is non-NULL can violate.
	const notNullChain = fk.columns
		.map(idx => `${childAlias}.${quoteIdentifier(childSchema.columns[idx].name)} is not null`)
		.join(' and ');

	const parentSchemaName = fk.referencedSchema ?? childSchema.schemaName;
	const parentTable = db.schemaManager.findTable(fk.referencedTable, parentSchemaName);

	let sql: string;
	if (!parentTable) {
		// Parent absent: any fully-non-NULL child row references a non-existent parent.
		sql = `select 1 from ${childRef} as ${childAlias} where ${notNullChain} limit 1`;
	} else {
		const parentColIndices = resolveReferencedColumns(fk, parentTable);
		if (parentColIndices.length !== fk.columns.length) {
			throw new QuereusError(
				`FK constraint '${fk.name ?? `_fk_${childSchema.name}`}' on table '${childSchema.name}': child column count (${fk.columns.length}) does not match parent column count (${parentColIndices.length})`,
				StatusCode.ERROR,
			);
		}
		const parentRef = qualifyRelation(parentTable.schemaName, parentTable.name);
		const parentAlias = '_p';
		// Aliases keep the correlation unambiguous even for a self-referencing FK
		// (child table === parent table).
		const matchChain = fk.columns
			.map((childIdx, i) =>
				`${parentAlias}.${quoteIdentifier(parentTable.columns[parentColIndices[i]].name)} = ${childAlias}.${quoteIdentifier(childSchema.columns[childIdx].name)}`)
			.join(' and ');
		sql = `select 1 from ${childRef} as ${childAlias} where ${notNullChain} `
			+ `and not exists (select 1 from ${parentRef} as ${parentAlias} where ${matchChain}) limit 1`;
	}

	log('FK existing-row validation for %s.%s: %s', childSchema.schemaName, childSchema.name, sql);

	const stmt = db.prepare(sql);
	try {
		for await (const _row of stmt._iterateRowsRaw()) {
			const colNames = fk.columns.map(idx => childSchema.columns[idx].name).join(', ');
			throw new QuereusError(
				`FOREIGN KEY constraint failed: ${childSchema.name} (${colNames}) has rows referencing a missing '${fk.referencedTable}'`,
				StatusCode.CONSTRAINT,
			);
		}
	} finally {
		await stmt.finalize();
	}
}
