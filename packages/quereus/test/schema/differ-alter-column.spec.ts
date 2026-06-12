/**
 * Tests for the declarative schema differ's column-attribute detection.
 *
 * Covers:
 *   - nullability drift (declared null vs actual not-null, and reverse)
 *   - DEFAULT drift (add, change, drop)
 *   - data-type drift
 *   - combined attributes on a single column
 *   - no-op when all attributes match
 */

import { expect } from 'chai';
import { Parser } from '../../src/parser/parser.js';
import { computeSchemaDiff, generateMigrationDDL } from '../../src/schema/schema-differ.js';
import type { SchemaCatalog, CatalogTable } from '../../src/schema/catalog.js';
import type * as AST from '../../src/parser/ast.js';

function parseDeclaredSchema(sql: string): AST.DeclareSchemaStmt {
	const parser = new Parser();
	const stmt = parser.parse(sql);
	if (stmt.type !== 'declareSchema') {
		throw new Error(`Expected declareSchema, got ${stmt.type}`);
	}
	return stmt;
}

function parseLiteralDefault(sql: string): AST.Expression {
	// Parse a throwaway create table to extract the DEFAULT expression AST for col c.
	const parser = new Parser();
	const stmt = parser.parse(`create table __t (c integer default ${sql})`) as AST.CreateTableStmt;
	const d = stmt.columns[0].constraints.find(c => c.type === 'default');
	if (!d?.expr) throw new Error('no default expression parsed');
	return d.expr;
}

function makeCatalog(tables: CatalogTable[]): SchemaCatalog {
	return { schemaName: 'main', tables, views: [], indexes: [], assertions: [] };
}

function catalogTable(
	name: string,
	columns: Array<{ name: string; type: string; notNull?: boolean; defaultValue?: AST.Expression | null; primaryKey?: boolean }>,
	primaryKey: Array<{ columnName: string; desc?: boolean }> = [],
): CatalogTable {
	return {
		name,
		ddl: '',
		columns: columns.map(c => ({
			name: c.name,
			type: c.type,
			notNull: c.notNull ?? false,
			primaryKey: c.primaryKey ?? false,
			defaultValue: c.defaultValue ?? null,
		})),
		primaryKey: primaryKey.map(pk => ({ columnName: pk.columnName, desc: pk.desc ?? false })),
	};
}

describe('Schema differ — ALTER COLUMN detection', () => {
	it('detects NOT NULL → NULL relaxation', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer null); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: true },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter).to.have.length(1);
		expect(diff.tablesToAlter[0].columnsToAlter).to.deep.equal([
			{ columnName: 'c', notNull: false },
		]);
	});

	it('detects NULL → NOT NULL tightening', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer not null); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: false },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.deep.equal([
			{ columnName: 'c', notNull: true },
		]);
	});

	it('detects added DEFAULT', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer default 0); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer' },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.have.length(1);
		const change = diff.tablesToAlter[0].columnsToAlter[0];
		expect(change.columnName).to.equal('c');
		expect(change.defaultValue).to.not.be.null;
		expect((change.defaultValue as AST.LiteralExpr).value).to.equal(0);
	});

	it('detects dropped DEFAULT when declared lacks one', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', defaultValue: parseLiteralDefault('0') },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.deep.equal([
			{ columnName: 'c', defaultValue: null },
		]);
	});

	it('detects data-type change', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c real); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer' },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.deep.equal([
			{ columnName: 'c', dataType: 'real' },
		]);
	});

	it('populates all three attributes on one column when all differ', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c real not null default 1); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: false },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.have.length(1);
		const change = diff.tablesToAlter[0].columnsToAlter[0];
		expect(change.columnName).to.equal('c');
		expect(change.notNull).to.equal(true);
		expect(change.dataType).to.equal('real');
		expect(change.defaultValue).to.not.be.null;
	});

	it('emits no alter when attributes match', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer not null); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: true },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter).to.have.length(0);
	});

	it('generates expected DDL statements in the correct order (type → default → null)', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c real not null default 1); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: false },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		const ddl = generateMigrationDDL(diff);
		expect(ddl).to.deep.equal([
			'ALTER TABLE t ALTER COLUMN c SET DATA TYPE real',
			'ALTER TABLE t ALTER COLUMN c SET DEFAULT 1',
			'ALTER TABLE t ALTER COLUMN c SET NOT NULL',
		]);
	});

	it('emits DROP DEFAULT when declared drops a present default', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', defaultValue: parseLiteralDefault('5') },
			], [{ columnName: 'id' }]),
		]);
		const diff = computeSchemaDiff(declared, actual);
		const ddl = generateMigrationDDL(diff);
		expect(ddl).to.deep.equal([
			'ALTER TABLE t ALTER COLUMN c DROP DEFAULT',
		]);
	});
});
