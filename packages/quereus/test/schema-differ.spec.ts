/**
 * Schema differ tests — covers generateMigrationDDL quoting and
 * applyTableDefaults JSON.parse error handling.
 */

import { expect } from 'chai';
import { generateMigrationDDL, computeSchemaDiff } from '../src/schema/schema-differ.js';
import type { SchemaDiff } from '../src/schema/schema-differ.js';
import type * as AST from '../src/parser/ast.js';
import type { SchemaCatalog } from '../src/schema/catalog.js';
import { QuereusError } from '../src/common/errors.js';

describe('Schema Differ', () => {
	describe('generateMigrationDDL identifier quoting', () => {
		it('should quote reserved-word table names in DROP statements', () => {
			const diff: SchemaDiff = {
				tablesToCreate: [],
				tablesToDrop: ['order', 'group'],
				tablesToAlter: [],
				viewsToCreate: [],
				viewsToDrop: [],
				indexesToCreate: [],
				indexesToDrop: [],
				assertionsToCreate: [],
				assertionsToDrop: [],
				renames: [],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP TABLE IF EXISTS "order"',
				'DROP TABLE IF EXISTS "group"',
			]);
		});

		it('should quote reserved-word view names in DROP statements', () => {
			const diff: SchemaDiff = {
				tablesToCreate: [],
				tablesToDrop: [],
				tablesToAlter: [],
				viewsToCreate: [],
				viewsToDrop: ['select'],
				indexesToCreate: [],
				indexesToDrop: [],
				assertionsToCreate: [],
				assertionsToDrop: [],
				renames: [],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP VIEW IF EXISTS "select"',
			]);
		});

		it('should quote reserved-word index names in DROP statements', () => {
			const diff: SchemaDiff = {
				tablesToCreate: [],
				tablesToDrop: [],
				tablesToAlter: [],
				viewsToCreate: [],
				viewsToDrop: [],
				indexesToCreate: [],
				indexesToDrop: ['index'],
				assertionsToCreate: [],
				assertionsToDrop: [],
				renames: [],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP INDEX IF EXISTS "index"',
			]);
		});

		it('should quote reserved-word table names in ALTER statements', () => {
			const diff: SchemaDiff = {
				tablesToCreate: [],
				tablesToDrop: [],
				tablesToAlter: [{
					tableName: 'table',
					columnsToAdd: ['col1 TEXT'],
					columnsToDrop: ['select'],
					columnsToAlter: [],
					columnsToRename: [],
				}],
				viewsToCreate: [],
				viewsToDrop: [],
				indexesToCreate: [],
				indexesToDrop: [],
				assertionsToCreate: [],
				assertionsToDrop: [],
				renames: [],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'ALTER TABLE "table" ADD COLUMN col1 TEXT',
				'ALTER TABLE "table" DROP COLUMN "select"',
			]);
		});

		it('should quote schema prefix when provided', () => {
			const diff: SchemaDiff = {
				tablesToCreate: [],
				tablesToDrop: ['users'],
				tablesToAlter: [],
				viewsToCreate: [],
				viewsToDrop: [],
				indexesToCreate: [],
				indexesToDrop: [],
				assertionsToCreate: [],
				assertionsToDrop: [],
				renames: [],
			};
			const ddl = generateMigrationDDL(diff, 'my schema');
			expect(ddl).to.deep.equal([
				'DROP TABLE IF EXISTS "my schema".users',
			]);
		});

		it('should not quote valid non-keyword identifiers', () => {
			const diff: SchemaDiff = {
				tablesToCreate: [],
				tablesToDrop: ['users'],
				tablesToAlter: [],
				viewsToCreate: [],
				viewsToDrop: [],
				indexesToCreate: [],
				indexesToDrop: [],
				assertionsToCreate: [],
				assertionsToDrop: [],
				renames: [],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP TABLE IF EXISTS users',
			]);
		});

		it('should quote names with special characters', () => {
			const diff: SchemaDiff = {
				tablesToCreate: [],
				tablesToDrop: ['my-table', 'has space'],
				tablesToAlter: [],
				viewsToCreate: [],
				viewsToDrop: [],
				indexesToCreate: [],
				indexesToDrop: [],
				assertionsToCreate: [],
				assertionsToDrop: [],
				renames: [],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP TABLE IF EXISTS "my-table"',
				'DROP TABLE IF EXISTS "has space"',
			]);
		});
	});

	describe('computeSchemaDiff JSON.parse error handling', () => {
		it('should throw QuereusError on malformed defaultVtabArgs JSON', () => {
			const declaredSchema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				using: {
					defaultVtabModule: 'memory',
					defaultVtabArgs: '{invalid json',
				},
				items: [{
					type: 'declaredTable',
					tableStmt: {
						type: 'createTable',
						table: { name: 'items' },
						columns: [{ name: 'id', constraints: {} }],
						constraints: [],
						ifNotExists: false,
					} as AST.CreateTableStmt,
				} as AST.DeclaredTable],
			};
			const emptyCatalog: SchemaCatalog = {
				schemaName: 'test',
				tables: [],
				views: [],
				indexes: [],
				assertions: [],
			};
			expect(() => computeSchemaDiff(declaredSchema, emptyCatalog))
				.to.throw(QuereusError, /Invalid JSON in schema default vtab args for table 'items'/);
		});
	});
});
