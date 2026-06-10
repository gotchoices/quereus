/**
 * Schema differ tests — covers generateMigrationDDL quoting and
 * applyTableDefaults JSON.parse error handling.
 */

import { expect } from 'chai';
import { generateMigrationDDL, computeSchemaDiff } from '../src/schema/schema-differ.js';
import type { SchemaDiff } from '../src/schema/schema-differ.js';
import type * as AST from '../src/parser/ast.js';
import type { SchemaCatalog, CatalogTable, CatalogView } from '../src/schema/catalog.js';
import { QuereusError } from '../src/common/errors.js';
import { Parser } from '../src/parser/parser.js';
import { viewDefinitionToCanonicalString } from '../src/emit/ast-stringify.js';

function parseDeclaredSchema(sql: string): AST.DeclareSchemaStmt {
	const stmt = new Parser().parse(sql);
	if (stmt.type !== 'declareSchema') throw new Error(`Expected declareSchema, got ${stmt.type}`);
	return stmt;
}

function makeCatalog(tables: CatalogTable[] = [], views: CatalogView[] = []): SchemaCatalog {
	return { schemaName: 'main', tables, views, materializedViews: [], indexes: [], assertions: [] };
}

function catalogTable(name: string, pkColumn: string): CatalogTable {
	return {
		name,
		ddl: '',
		columns: [{ name: pkColumn, type: 'integer', notNull: true, primaryKey: true, defaultValue: null }],
		primaryKey: [{ columnName: pkColumn, desc: false }],
		referencedTables: [],
		namedConstraints: [],
	};
}

/** A multi-column actual table for the column-rename reconciliation cases. */
function catalogTableWithColumns(name: string, columns: Array<{ name: string; primaryKey?: boolean }>): CatalogTable {
	return {
		name,
		ddl: '',
		columns: columns.map(c => ({
			name: c.name,
			type: 'integer',
			notNull: !!c.primaryKey,
			primaryKey: !!c.primaryKey,
			defaultValue: null,
			collation: 'BINARY',
		})),
		primaryKey: columns.filter(c => c.primaryKey).map(c => ({ columnName: c.name, desc: false })),
		referencedTables: [],
		namedConstraints: [],
	};
}

/** Builds a CatalogView from CREATE VIEW DDL the way `viewSchemaToCatalog` does
 *  (same canonical renderer over the parsed statement's definitional fields). */
function catalogView(sql: string): CatalogView {
	const stmt = new Parser().parse(sql);
	if (stmt.type !== 'createView') throw new Error(`Expected createView, got ${stmt.type}`);
	const view = stmt as AST.CreateViewStmt;
	return {
		name: view.view.name,
		ddl: sql,
		definition: viewDefinitionToCanonicalString(view.columns, view.select, view.insertDefaults),
		tags: view.tags,
	};
}

describe('Schema Differ', () => {
	describe('generateMigrationDDL identifier quoting', () => {
		it('should quote reserved-word table names in DROP statements', () => {
			const diff: SchemaDiff = {
				tablesToCreate: [],
				tablesToDrop: ['order', 'group'],
				tablesToAlter: [],
				viewsToCreate: [],
				viewsToDrop: [],
				materializedViewsToCreate: [],
				materializedViewsToDrop: [],
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
				materializedViewsToCreate: [],
				materializedViewsToDrop: [],
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
				materializedViewsToCreate: [],
				materializedViewsToDrop: [],
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
				materializedViewsToCreate: [],
				materializedViewsToDrop: [],
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
				materializedViewsToCreate: [],
				materializedViewsToDrop: [],
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
				materializedViewsToCreate: [],
				materializedViewsToDrop: [],
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
				materializedViewsToCreate: [],
				materializedViewsToDrop: [],
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
						columns: [{ name: 'id', constraints: [] }],
						constraints: [],
						ifNotExists: false,
					} as AST.CreateTableStmt,
				} as AST.DeclaredTable],
			};
			const emptyCatalog: SchemaCatalog = {
				schemaName: 'test',
				tables: [],
				views: [],
				materializedViews: [],
				indexes: [],
				assertions: [],
			};
			expect(() => computeSchemaDiff(declaredSchema, emptyCatalog))
				.to.throw(QuereusError, /Invalid JSON in schema default vtab args for table 'items'/);
		});
	});

	describe('reserved-tag validation (registry-governed, physical declarative path)', () => {
		it('throws on a typo in a physical declared table tag (was silently soft-warned)', () => {
			// Headline regression-closer: a `quereus.*` typo on a physical declared
			// object used to be swallowed by the differ's soft-warn allow-list; it
			// now hard-errors through the typed registry like every other path.
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer } with tags ("quereus.update.taget" = 'x') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('throws on a typo in a physical declared column tag', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer with tags ("quereus.previuos_name" = 'y') } }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('accepts a valid quereus.previous_name and still produces the rename op', () => {
			// Parity with the existing rename behavior: a legal hint must NOT trip
			// the new validation, and must still resolve to a RENAME against the
			// matching actual.
			const declared = parseDeclaredSchema(
				`declare schema main { table customer { client_id integer primary key, name text not null } with tags ("quereus.previous_name" = 'client') }`
			);
			const diff = computeSchemaDiff(declared, makeCatalog([catalogTable('client', 'client_id')]));
			expect(diff.renames).to.deep.include({ kind: 'table', oldName: 'client', newName: 'customer' });
			expect(diff.tablesToCreate).to.have.length(0);
			expect(diff.tablesToDrop).to.have.length(0);
		});

		it('accepts a hyphenated quereus.id value (guards the string value-schema)', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table thing { id integer primary key, label text } with tags ("quereus.id" = 'tbl-thing') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog())).to.not.throw();
		});

		it('accepts the rename hints on a declared view (legal at view-ddl)', () => {
			// quereus.id / quereus.previous_name are the only reserved keys legal at
			// view-ddl (inert on a direct create; the differ reads them for renames).
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer } view v as select id from t with tags ("quereus.id" = 'v-1') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog())).to.not.throw();
		});

		it('throws on the removed quereus.update.default_for tag on a declared view', () => {
			// default_for was the last quereus.update.* key; the first-class
			// `insert defaults (col = expr, …)` clause replaced it, so it is unknown
			// at any site — including its former view-ddl home.
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer } view v as select id from t with tags ("quereus.update.default_for.x" = '0') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('throws on the removed quereus.update.policy routing tag on a declared view', () => {
			// policy (with target / exclude / delete_via) was removed — routing is now a
			// per-row presence/membership column, not a tag — so it is unknown at any site.
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer } view v as select id from t with tags ("quereus.update.policy" = 'strict') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('throws on a typo in an UNNAMED table-constraint tag (table-level WITH TAGS is consumed even unnamed)', () => {
			// A table-level constraint consumes its trailing `WITH TAGS` whether or
			// not it is named, so an unnamed constraint can carry a reserved tag.
			// Validation must not gate on the constraint name, else a typo here is a
			// silent no-op — the exact escape the unified hard-error posture closes.
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, a integer, b integer, unique (a, b) with tags ("quereus.update.taget" = 'x') } }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('surfaces a tag typo BEFORE a rename conflict (validation precedes rename resolution)', () => {
			// Determinism guarantee: when a schema carries BOTH a reserved-tag typo
			// AND a rename conflict (declared name and previous_name resolving to two
			// distinct actuals), the tag error must win — tag validation runs before
			// the throw-y rename resolution. Without that ordering this would throw
			// the rename-conflict error instead.
			const declared = parseDeclaredSchema(
				`declare schema main { table customer { id integer primary key, name text with tags ("quereus.taget" = 'oops') } with tags ("quereus.previous_name" = 'client') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog([catalogTable('client', 'id'), catalogTable('customer', 'id')])))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});
	});

	describe('view definition drift (canonical compare + rename reconciliation)', () => {
		it('clause-only drift on a name-matched view → drop+recreate, no SET TAGS', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key } view v as select id from t insert defaults (created = 222) }`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[catalogView('create view v as select id from t insert defaults (created = 111)')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal(['v']);
			expect(diff.viewsToCreate).to.deep.equal(['create view v as select id from t insert defaults (created = 222)']);
			expect(diff.viewTagsChanges, 'a recreate carries the declared tags — no separate SET TAGS').to.deep.equal([]);
		});

		it('identical definition with tag drift → in-place SET TAGS, no recreate', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key } view v as select id from t with tags (owner = 'a') }`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[catalogView('create view v as select id from t')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate).to.deep.equal([]);
			expect(diff.viewTagsChanges).to.deep.equal([{ name: 'v', tags: { owner: 'a' } }]);
		});

		it('a definition recreate under require-hint does not trip the unhinted-rename guard', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key } view v as select id from t where id > 0 }`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[catalogView('create view v as select id from t')],
			);
			const diff = computeSchemaDiff(declared, catalog, 'require-hint');
			expect(diff.viewsToDrop).to.deep.equal(['v']);
			expect(diff.viewsToCreate).to.have.length(1);
		});

		it('in-diff column rename reconciles body, clause expression, and an unrenamed clause target — no recreate', () => {
			// Declared references the NEW column name in the body projection AND
			// inside an insert-defaults expression; the actual catalog still carries
			// the OLD name at diff time. The inverse-applied declared definition must
			// match the actual, leaving only the RENAME COLUMN op.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t {
						id integer primary key,
						newc integer with tags ("quereus.previous_name" = 'oldc'),
						extra integer
					}
					view v as select id, newc from t insert defaults (extra = newc + 1)
				}`
			);
			const catalog = makeCatalog(
				[catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'oldc' }, { name: 'extra' }])],
				[catalogView('create view v as select id, oldc from t insert defaults (extra = oldc + 1)')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate).to.deep.equal([]);
			expect(diff.tablesToAlter[0]?.columnsToRename).to.deep.equal([{ oldName: 'oldc', newName: 'newc' }]);
		});

		it('in-diff rename of the clause TARGET column reconciles — no recreate', () => {
			// The clause column names a base-table column the body projects away, so
			// the select-body rewrite alone cannot reconcile it — the clause-specific
			// inverse rename (scoped to the view's FROM tables) must.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t {
						id integer primary key,
						newc integer with tags ("quereus.previous_name" = 'oldc')
					}
					view v as select id from t insert defaults (newc = 1)
				}`
			);
			const catalog = makeCatalog(
				[catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'oldc' }])],
				[catalogView('create view v as select id from t insert defaults (oldc = 1)')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate).to.deep.equal([]);
		});

		it('an unrelated table\'s column rename does NOT rewrite the clause target (FROM-scoped lookup)', () => {
			// `other` renames a column whose NEW name collides with the view's clause
			// target on `t`; since `other` is not in the view's FROM, the clause must
			// not be inverse-rewritten — the definitions match raw and stay matched.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, marker integer }
					table other {
						id integer primary key,
						marker integer with tags ("quereus.previous_name" = 'old_marker')
					}
					view v as select id from t insert defaults (marker = 1)
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'marker' }]),
					catalogTableWithColumns('other', [{ name: 'id', primaryKey: true }, { name: 'old_marker' }]),
				],
				[catalogView('create view v as select id from t insert defaults (marker = 1)')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate).to.deep.equal([]);
		});

		it('a genuine definition edit layered on an in-diff rename still recreates', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t {
						id integer primary key,
						newc integer with tags ("quereus.previous_name" = 'oldc')
					}
					view v as select id, newc from t where id > 0
				}`
			);
			const catalog = makeCatalog(
				[catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'oldc' }])],
				[catalogView('create view v as select id, oldc from t')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal(['v']);
			expect(diff.viewsToCreate).to.deep.equal(['create view v as select id, newc from t where id > 0']);
		});
	});
});
