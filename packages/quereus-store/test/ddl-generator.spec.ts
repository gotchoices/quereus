/**
 * Tests for DDL generation utilities.
 */

import { expect } from 'chai';
import { generateTableDDL, generateIndexDDL, INTEGER_TYPE, TEXT_TYPE, REAL_TYPE } from '@quereus/quereus';
import type { TableSchema, TableIndexSchema, ColumnSchema } from '@quereus/quereus';

/** Helper to build a minimal TableSchema for testing. */
function makeTableSchema(overrides: Partial<TableSchema> & { name: string; columns: ColumnSchema[] }): TableSchema {
	const columns = overrides.columns;
	const columnIndexMap = new Map(columns.map((c, i) => [c.name.toLowerCase(), i]));
	return {
		schemaName: 'main',
		primaryKeyDefinition: [],
		checkConstraints: [],
		vtabModule: {} as any,
		vtabModuleName: '',
		isView: false,
		columnIndexMap,
		...overrides,
	} as TableSchema;
}

/** Helper to build a minimal ColumnSchema. */
function makeColumn(name: string, type: ColumnSchema['logicalType'], opts?: Partial<ColumnSchema>): ColumnSchema {
	return {
		name,
		logicalType: type,
		notNull: true,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: '',
		generated: false,
		...opts,
	};
}

describe('DDL generator', () => {
	describe('generateTableDDL', () => {
		it('generates simple table with single PK', () => {
			const schema = makeTableSchema({
				name: 'users',
				columns: [
					makeColumn('id', INTEGER_TYPE, { primaryKey: true, pkOrder: 0 }),
					makeColumn('name', TEXT_TYPE),
				],
				primaryKeyDefinition: [{ index: 0 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('CREATE TABLE');
			expect(ddl).to.include('"users"');
			// Without a db context the generator annotates nullability explicitly.
			expect(ddl).to.include('"id" INTEGER NOT NULL PRIMARY KEY');
			expect(ddl).to.include('"name" TEXT NOT NULL');
		});

		it('generates singleton PRIMARY KEY () for empty PK definition', () => {
			const schema = makeTableSchema({
				name: 'settings',
				columns: [
					makeColumn('name', TEXT_TYPE, { notNull: false }),
					makeColumn('val', TEXT_TYPE, { notNull: false }),
				],
				primaryKeyDefinition: [],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('PRIMARY KEY ()');
			// No column-level PK annotation should leak in.
			expect(ddl).not.to.match(/\bPRIMARY KEY\b(?!\s*\()/);
		});

		it('generates composite PK as table constraint', () => {
			const schema = makeTableSchema({
				name: 'order_items',
				columns: [
					makeColumn('order_id', INTEGER_TYPE, { primaryKey: true, pkOrder: 0 }),
					makeColumn('item_id', INTEGER_TYPE, { primaryKey: true, pkOrder: 1 }),
					makeColumn('qty', INTEGER_TYPE),
				],
				primaryKeyDefinition: [{ index: 0 }, { index: 1 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('PRIMARY KEY ("order_id", "item_id")');
			// Single-column PK annotation should NOT appear
			expect(ddl).not.to.match(/"order_id" INTEGER PRIMARY KEY/);
		});

		it('generates schema-qualified name for non-main schema', () => {
			const schema = makeTableSchema({
				name: 'items',
				schemaName: 'inventory',
				columns: [makeColumn('id', INTEGER_TYPE)],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"inventory"."items"');
		});

		it('includes USING clause for virtual tables', () => {
			const schema = makeTableSchema({
				name: 'data',
				vtabModuleName: 'store',
				columns: [makeColumn('id', INTEGER_TYPE)],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('USING store');
		});

		it('includes NULL annotation for nullable columns', () => {
			const schema = makeTableSchema({
				name: 'data',
				columns: [makeColumn('notes', TEXT_TYPE, { notNull: false })],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"notes" TEXT NULL');
		});

		it('emits table-level WITH TAGS', () => {
			const schema = makeTableSchema({
				name: 'tagged',
				columns: [makeColumn('id', INTEGER_TYPE, { primaryKey: true })],
				primaryKeyDefinition: [{ index: 0 }],
				tags: { display_name: 'Tagged Table', audit: true },
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('WITH TAGS');
			expect(ddl).to.include("display_name = 'Tagged Table'");
			expect(ddl).to.include('audit = TRUE');
		});

		it('emits column-level WITH TAGS', () => {
			const schema = makeTableSchema({
				name: 'col_tagged',
				columns: [
					makeColumn('id', INTEGER_TYPE, { primaryKey: true }),
					makeColumn('name', TEXT_TYPE, { tags: { display_name: 'Name', searchable: true } }),
				],
				primaryKeyDefinition: [{ index: 0 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"name" TEXT NOT NULL WITH TAGS');
			expect(ddl).to.include("display_name = 'Name'");
		});

		it('quotes tag keys that are reserved words', () => {
			const schema = makeTableSchema({
				name: 'reserved_tags',
				columns: [makeColumn('id', INTEGER_TYPE)],
				tags: { select: 'yes', order: 42 },
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"select"');
			expect(ddl).to.include('"order"');
		});

		it('does not emit WITH TAGS when tags are empty', () => {
			const schema = makeTableSchema({
				name: 'no_tags',
				columns: [makeColumn('id', INTEGER_TYPE, { tags: {} })],
				tags: {},
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).not.to.include('WITH TAGS');
		});

		it('without db context: always qualifies, annotates, and emits USING with custom args', () => {
			const schema = makeTableSchema({
				name: 'events',
				schemaName: 'audit',
				columns: [
					makeColumn('id', INTEGER_TYPE, { primaryKey: true, pkOrder: 0 }),
					makeColumn('note', TEXT_TYPE, { notNull: false }),
				],
				primaryKeyDefinition: [{ index: 0 }],
				vtabModuleName: 'store',
				vtabArgs: { collation: 'NOCASE', cache_size: 100 },
			});
			const ddl = generateTableDDL(schema);
			// Schema qualification even for a module that might be the session default.
			expect(ddl).to.include('"audit"."events"');
			// Every column's nullability is explicit.
			expect(ddl).to.include('"id" INTEGER NOT NULL PRIMARY KEY');
			expect(ddl).to.include('"note" TEXT NULL');
			// USING emitted unconditionally when no db is available.
			expect(ddl).to.include('USING store');
			// Args emitted as SQL literals (strings quoted, numbers bare) - not JSON.
			expect(ddl).to.include("collation = 'NOCASE'");
			expect(ddl).to.include('cache_size = 100');
		});
	});

	describe('generateIndexDDL', () => {
		const tableSchema = makeTableSchema({
			name: 'users',
			columns: [
				makeColumn('id', INTEGER_TYPE),
				makeColumn('email', TEXT_TYPE),
				makeColumn('score', REAL_TYPE),
			],
		});

		it('generates simple index', () => {
			const idx: TableIndexSchema = { name: 'idx_email', columns: [{ index: 1 }] };
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('CREATE INDEX "idx_email"');
			// Without a db context, the generator qualifies the table name unconditionally.
			expect(ddl).to.include('ON "main"."users"');
			expect(ddl).to.include('"email"');
		});

		it('includes COLLATE for collated columns', () => {
			const idx: TableIndexSchema = { name: 'idx_email_nc', columns: [{ index: 1, collation: 'NOCASE' }] };
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('COLLATE NOCASE');
		});

		it('includes DESC for descending columns', () => {
			const idx: TableIndexSchema = { name: 'idx_score_desc', columns: [{ index: 2, desc: true }] };
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('DESC');
		});

		it('generates schema-qualified table name', () => {
			const schemaQualified = makeTableSchema({
				name: 'users',
				schemaName: 'auth',
				columns: [makeColumn('email', TEXT_TYPE)],
			});
			const idx: TableIndexSchema = { name: 'idx_email', columns: [{ index: 0 }] };
			const ddl = generateIndexDDL(idx, schemaQualified);
			expect(ddl).to.include('"auth"."users"');
		});

		it('emits index-level WITH TAGS', () => {
			const idx: TableIndexSchema = {
				name: 'idx_email',
				columns: [{ index: 1 }],
				tags: { label: 'email index', priority: 1 },
			};
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('WITH TAGS');
			expect(ddl).to.include("label = 'email index'");
			expect(ddl).to.include('priority = 1');
		});
	});
});

