/**
 * `ColumnSchema.declaredType` — the raw DDL type token (e.g. 'BIGINT', 'TIMESTAMP')
 * carried forward alongside the flattened `logicalType` (see schema/column.ts).
 * `inferType` flattens BIGINT onto the shared INTEGER_TYPE (same object as plain
 * INTEGER) and TIMESTAMP (no registry entry, no "INT" affinity match) onto BLOB_TYPE,
 * erasing the distinction a host consuming the projected TableSchema (not the CREATE
 * TABLE AST) may still need; `declaredType` preserves it regardless of where
 * `logicalType` lands.
 */

import { expect } from 'chai';
import { parse } from '../src/parser/index.js';
import { columnDefToSchema } from '../src/schema/table.js';
import type { CreateTableStmt } from '../src/parser/ast.js';

function columnDef(sql: string, columnName: string) {
	const stmt = parse(sql) as CreateTableStmt;
	expect(stmt.type).to.equal('createTable');
	const col = stmt.columns.find(c => c.name === columnName);
	if (!col) throw new Error(`column ${columnName} not found`);
	return col;
}

describe('ColumnSchema.declaredType', () => {
	it('preserves BIGINT verbatim while logicalType flattens to INTEGER', () => {
		const schema = columnDefToSchema(columnDef('create table t (id BIGINT)', 'id'));
		expect(schema.declaredType).to.equal('BIGINT');
		expect(schema.logicalType.name).to.equal('INTEGER');
	});

	it('preserves TIMESTAMP verbatim while logicalType flattens to BLOB (no registry entry, no INT affinity match)', () => {
		const schema = columnDefToSchema(columnDef('create table t (created TIMESTAMP)', 'created'));
		expect(schema.declaredType).to.equal('TIMESTAMP');
		expect(schema.logicalType.name).to.equal('BLOB');
	});

	it('leaves declaredType undefined when no type is declared', () => {
		const schema = columnDefToSchema(columnDef('create table t (id)', 'id'));
		expect(schema.declaredType).to.be.undefined;
	});
});
