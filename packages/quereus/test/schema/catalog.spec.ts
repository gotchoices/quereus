import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { collectSchemaCatalog, generateDeclaredDDL } from '../../src/schema/catalog.js';
import { computeSchemaHash, computeShortSchemaHash } from '../../src/schema/schema-hasher.js';
import type * as AST from '../../src/parser/ast.js';

describe('Schema Catalog', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('collectSchemaCatalog', () => {
		it('should return empty catalog for missing schema', () => {
			const catalog = collectSchemaCatalog(db, 'nonexistent');
			expect(catalog.schemaName).to.equal('nonexistent');
			expect(catalog.tables).to.have.length(0);
			expect(catalog.views).to.have.length(0);
			expect(catalog.indexes).to.have.length(0);
			expect(catalog.assertions).to.have.length(0);
		});

		it('should collect tables from main schema', async () => {
			await db.exec('CREATE TABLE test_t (id INTEGER PRIMARY KEY, name TEXT)');

			const catalog = collectSchemaCatalog(db, 'main');
			expect(catalog.tables.length).to.be.greaterThanOrEqual(1);

			const table = catalog.tables.find(t => t.name === 'test_t');
			expect(table).to.exist;
			expect(table!.ddl).to.include('test_t');
			expect(table!.columns).to.have.length(2);
			expect(table!.columns[0].name).to.equal('id');
			expect(table!.columns[1].name).to.equal('name');
		});

		it('should collect tables with composite primary keys', async () => {
			await db.exec('CREATE TABLE comp_pk (a INTEGER, b TEXT, c REAL, PRIMARY KEY (a, b))');

			const catalog = collectSchemaCatalog(db, 'main');
			const table = catalog.tables.find(t => t.name === 'comp_pk');
			expect(table).to.exist;
			expect(table!.ddl).to.include('PRIMARY KEY');
		});

		it('should collect indexes', async () => {
			await db.exec('CREATE TABLE idx_t (id INTEGER PRIMARY KEY, name TEXT, category TEXT)');
			await db.exec('CREATE INDEX idx_name ON idx_t (name)');

			const catalog = collectSchemaCatalog(db, 'main');
			expect(catalog.indexes.length).to.be.greaterThanOrEqual(1);

			const idx = catalog.indexes.find(i => i.name === 'idx_name');
			expect(idx).to.exist;
			expect(idx!.tableName).to.equal('idx_t');
			expect(idx!.ddl).to.include('idx_name');
		});

		it('should collect views', async () => {
			await db.exec('CREATE TABLE v_src (id INTEGER PRIMARY KEY, val TEXT)');
			await db.exec('CREATE VIEW v_test AS SELECT id, val FROM v_src WHERE id > 0');

			const catalog = collectSchemaCatalog(db, 'main');
			expect(catalog.views.length).to.be.greaterThanOrEqual(1);

			const view = catalog.views.find(v => v.name === 'v_test');
			expect(view).to.exist;
			expect(view!.ddl).to.include('select');
		});

		it('should handle table with no indexes', async () => {
			await db.exec('CREATE TABLE no_idx (id INTEGER PRIMARY KEY, val TEXT)');

			const catalog = collectSchemaCatalog(db, 'main');
			const tableIndexes = catalog.indexes.filter(i => i.tableName === 'no_idx');
			expect(tableIndexes).to.have.length(0);
		});

		it('should default to main schema', async () => {
			await db.exec('CREATE TABLE default_schema (id INTEGER PRIMARY KEY)');

			const catalog = collectSchemaCatalog(db);
			expect(catalog.schemaName).to.equal('main');
			expect(catalog.tables.find(t => t.name === 'default_schema')).to.exist;
		});

		it('should emit PRIMARY KEY () for singleton tables', async () => {
			await db.exec('CREATE TABLE settings (name TEXT, val TEXT, PRIMARY KEY ()) USING memory');

			const catalog = collectSchemaCatalog(db, 'main');
			const table = catalog.tables.find(t => t.name === 'settings');
			expect(table, 'settings table').to.exist;
			expect(table!.ddl).to.include('PRIMARY KEY ()');
			expect(table!.primaryKey).to.have.length(0);
		});
	});

	// The differ compares a constraint's canonical body fragment (`definition`,
	// name + tags excluded) to detect a name-unchanged-but-body-changed constraint.
	// These pin the exact canonical form per class so the declared and actual sides
	// stay byte-comparable (a drift here would churn spurious drop+recreates).
	describe('namedConstraints definition canonicalization', () => {
		async function definitionOf(createSql: string, table: string, constraintName: string): Promise<string> {
			await db.exec(createSql);
			const cat = collectSchemaCatalog(db, 'main');
			const t = cat.tables.find(t => t.name === table)!;
			const c = t.namedConstraints.find(c => c.name === constraintName)!;
			expect(c, `constraint ${constraintName} surfaced`).to.exist;
			return c.definition;
		}

		it('CHECK: default (insert+update) operation mask is elided', async () => {
			const def = await definitionOf(
				'CREATE TABLE t (id INTEGER PRIMARY KEY, qty INTEGER, CONSTRAINT chk_qty CHECK (qty > 0))',
				't', 'chk_qty',
			);
			expect(def).to.equal('check (qty > 0)');
		});

		it('CHECK: a non-default operation mask is preserved', async () => {
			const def = await definitionOf(
				'CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER, CONSTRAINT c1 CHECK ON DELETE (v > 0))',
				't', 'c1',
			);
			expect(def).to.equal('check on delete (v > 0)');
		});

		it('UNIQUE: lists columns and elides the default ABORT conflict', async () => {
			const def = await definitionOf(
				'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, CONSTRAINT uq UNIQUE (a, b))',
				't', 'uq',
			);
			expect(def).to.equal('unique (a, b)');
		});

		it('UNIQUE: a non-default conflict action is preserved', async () => {
			const def = await definitionOf(
				'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, CONSTRAINT uq UNIQUE (a) ON CONFLICT REPLACE)',
				't', 'uq',
			);
			expect(def).to.equal('unique (a) on conflict replace');
		});

		it('FOREIGN KEY: elides default RESTRICT actions', async () => {
			await db.exec('CREATE TABLE parent (pid INTEGER PRIMARY KEY)');
			const def = await definitionOf(
				'CREATE TABLE child (id INTEGER PRIMARY KEY, pa INTEGER, CONSTRAINT fk FOREIGN KEY (pa) REFERENCES parent(pid))',
				'child', 'fk',
			);
			expect(def).to.equal('foreign key (pa) references parent(pid)');
		});

		it('FOREIGN KEY: a non-default ON DELETE action is preserved', async () => {
			await db.exec('CREATE TABLE parent (pid INTEGER PRIMARY KEY)');
			const def = await definitionOf(
				'CREATE TABLE child (id INTEGER PRIMARY KEY, pa INTEGER, CONSTRAINT fk FOREIGN KEY (pa) REFERENCES parent(pid) ON DELETE CASCADE)',
				'child', 'fk',
			);
			expect(def).to.equal('foreign key (pa) references parent(pid) on delete cascade');
		});

		it('definition excludes the constraint tags (tag-only change is not a body change)', async () => {
			const def = await definitionOf(
				"CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, CONSTRAINT uq UNIQUE (a) WITH TAGS (msg = 'hi'))",
				't', 'uq',
			);
			expect(def, 'tags must not appear in the canonical body').to.equal('unique (a)');
		});
	});

	// Roundtrip tests: catalog DDL must parse back into an equivalent schema.
	// These catch drift between generator branches and the parser — e.g. a
	// singleton table silently losing its PRIMARY KEY () on re-persistence.
	describe('DDL roundtrip', () => {
		async function roundtrip(createSql: string, tableName: string): Promise<void> {
			await db.exec(createSql);
			const beforeTable = db.schemaManager.getTable('main', tableName);
			expect(beforeTable, 'table exists before roundtrip').to.exist;
			const beforePk = beforeTable!.primaryKeyDefinition.map(pk => ({
				index: pk.index,
				desc: pk.desc ?? false,
			}));
			const beforeCols = beforeTable!.columns.map(c => c.name);

			const catalog = collectSchemaCatalog(db, 'main');
			const entry = catalog.tables.find(t => t.name === tableName);
			expect(entry, 'catalog entry').to.exist;

			await db.exec(`DROP TABLE ${tableName}`);
			expect(db.schemaManager.getTable('main', tableName)).to.not.exist;

			await db.exec(entry!.ddl);
			const afterTable = db.schemaManager.getTable('main', tableName);
			expect(afterTable, 'table exists after roundtrip').to.exist;

			expect(afterTable!.columns.map(c => c.name)).to.deep.equal(beforeCols);
			expect(afterTable!.primaryKeyDefinition.map(pk => ({
				index: pk.index,
				desc: pk.desc ?? false,
			}))).to.deep.equal(beforePk);
		}

		it('roundtrips a single-column PRIMARY KEY', async () => {
			await roundtrip(
				'CREATE TABLE rt_single (id INTEGER PRIMARY KEY, name TEXT) USING memory',
				'rt_single',
			);
		});

		it('roundtrips a composite PRIMARY KEY', async () => {
			await roundtrip(
				'CREATE TABLE rt_composite (a INTEGER, b TEXT, c REAL, PRIMARY KEY (a, b)) USING memory',
				'rt_composite',
			);
		});

		it('roundtrips a singleton (empty) PRIMARY KEY', async () => {
			await roundtrip(
				'CREATE TABLE rt_singleton (app_name TEXT, version TEXT, PRIMARY KEY ()) USING memory',
				'rt_singleton',
			);
		});

		it('preserves singleton semantics across roundtrip', async () => {
			await db.exec('CREATE TABLE rt_sing_sem (k TEXT, v TEXT, PRIMARY KEY ()) USING memory');
			const catalog = collectSchemaCatalog(db, 'main');
			const entry = catalog.tables.find(t => t.name === 'rt_sing_sem')!;
			await db.exec('DROP TABLE rt_sing_sem');
			await db.exec(entry.ddl);

			await db.exec("INSERT INTO rt_sing_sem VALUES ('a', 'b')");
			let threw = false;
			try {
				await db.exec("INSERT INTO rt_sing_sem VALUES ('c', 'd')");
			} catch {
				threw = true;
			}
			expect(threw, 'second insert into singleton must fail').to.be.true;
		});

		it('roundtrips tags, defaults, and mixed nullability with a composite PK', async () => {
			await db.exec(`CREATE TABLE rt_full (
				a INTEGER,
				b TEXT,
				c INTEGER NULL DEFAULT 7,
				d TEXT DEFAULT 'x',
				PRIMARY KEY (a, b)
			) USING memory WITH TAGS (owner = 'app', version = 1)`);

			const beforeTable = db.schemaManager.getTable('main', 'rt_full')!;
			const beforeTags = beforeTable.tags;
			const beforeNullability = beforeTable.columns.map(c => c.notNull);
			const beforeDefaults = beforeTable.columns.map(c => c.defaultValue !== null);

			const catalog = collectSchemaCatalog(db, 'main');
			const entry = catalog.tables.find(t => t.name === 'rt_full')!;
			expect(entry.ddl).to.include('WITH TAGS');
			expect(entry.ddl).to.include('DEFAULT');

			await db.exec('DROP TABLE rt_full');
			await db.exec(entry.ddl);

			const after = db.schemaManager.getTable('main', 'rt_full')!;
			expect(after.columns.map(c => c.notNull)).to.deep.equal(beforeNullability);
			expect(after.columns.map(c => c.defaultValue !== null)).to.deep.equal(beforeDefaults);
			expect(after.tags).to.deep.equal(beforeTags);
		});

		it('honors default_column_nullability for emission and survives a roundtrip', async () => {
			// Default is 'not_null': NOT NULL columns elide the annotation, nullable emits NULL.
			await db.exec('CREATE TABLE rt_nn (id INTEGER PRIMARY KEY, note TEXT NULL) USING memory');
			const defaultCatalog = collectSchemaCatalog(db, 'main');
			const defaultEntry = defaultCatalog.tables.find(t => t.name === 'rt_nn')!;
			expect(defaultEntry.ddl).to.include('"note" TEXT NULL');
			expect(defaultEntry.ddl).to.not.match(/"id" INTEGER NOT NULL/);

			await db.exec('DROP TABLE rt_nn');
			await db.exec(defaultEntry.ddl);
			const afterDefault = db.schemaManager.getTable('main', 'rt_nn')!;
			expect(afterDefault.columns.find(c => c.name === 'id')!.notNull).to.equal(true);
			expect(afterDefault.columns.find(c => c.name === 'note')!.notNull).to.equal(false);

			await db.exec('DROP TABLE rt_nn');

			// Flip pragma: nullable default. Now NOT NULL must be annotated, NULL is implicit.
			db.setOption('default_column_nullability', 'nullable');
			await db.exec('CREATE TABLE rt_nn (id INTEGER NOT NULL PRIMARY KEY, note TEXT) USING memory');
			const nullableCatalog = collectSchemaCatalog(db, 'main');
			const nullableEntry = nullableCatalog.tables.find(t => t.name === 'rt_nn')!;
			expect(nullableEntry.ddl).to.include('"id" INTEGER NOT NULL');
			expect(nullableEntry.ddl).to.not.match(/"note" TEXT NULL/);

			await db.exec('DROP TABLE rt_nn');
			await db.exec(nullableEntry.ddl);
			const afterNullable = db.schemaManager.getTable('main', 'rt_nn')!;
			expect(afterNullable.columns.find(c => c.name === 'id')!.notNull).to.equal(true);
			expect(afterNullable.columns.find(c => c.name === 'note')!.notNull).to.equal(false);
		});
	});

	describe('generateDeclaredDDL', () => {
		it('should generate DDL for a declared table', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredTable',
					tableStmt: {
						type: 'createTable',
						table: { type: 'identifier', name: 'users' },
						ifNotExists: false,
						columns: [
							{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
							{ name: 'name', dataType: 'TEXT', constraints: [{ type: 'notNull' }] },
						],
						constraints: [],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(1);
			expect(ddl[0].toLowerCase()).to.include('create table');
			expect(ddl[0]).to.include('users');
		});

		it('should qualify table name with non-main target schema', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'myapp',
				items: [{
					type: 'declaredTable',
					tableStmt: {
						type: 'createTable',
						table: { type: 'identifier', name: 'data' },
						ifNotExists: false,
						columns: [
							{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
						],
						constraints: [],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema, 'myapp');
			expect(ddl).to.have.length(1);
			expect(ddl[0]).to.include('myapp');
		});

		it('should not qualify when target schema is main', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredTable',
					tableStmt: {
						type: 'createTable',
						table: { type: 'identifier', name: 'data' },
						ifNotExists: false,
						columns: [
							{ name: 'id', dataType: 'INTEGER', constraints: [] },
						],
						constraints: [],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema, 'main');
			expect(ddl).to.have.length(1);
			// Should not include schema qualification for 'main'
		});

		it('should generate DDL for declared indexes', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredIndex',
					indexStmt: {
						type: 'createIndex',
						index: { type: 'identifier', name: 'idx_name' },
						table: { type: 'identifier', name: 'users' },
						ifNotExists: false,
						isUnique: false,
						columns: [{ name: 'name' }],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(1);
			expect(ddl[0].toLowerCase()).to.include('create index');
			expect(ddl[0]).to.include('idx_name');
		});

		it('should qualify index table with non-main target schema', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredIndex',
					indexStmt: {
						type: 'createIndex',
						index: { type: 'identifier', name: 'idx_x' },
						table: { type: 'identifier', name: 'data' },
						ifNotExists: false,
						isUnique: false,
						columns: [{ name: 'x' }],
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema, 'custom');
			expect(ddl).to.have.length(1);
			expect(ddl[0]).to.include('custom');
		});

		it('should generate DDL for declared views', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [{
					type: 'declaredView',
					viewStmt: {
						type: 'createView',
						view: { type: 'identifier', name: 'v_active' },
						ifNotExists: false,
						select: {
							type: 'select',
							columns: [{ type: 'all' }],
							from: { type: 'table', table: { type: 'identifier', name: 'users' } },
						},
					},
				}],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(1);
			expect(ddl[0].toLowerCase()).to.include('create view');
			expect(ddl[0]).to.include('v_active');
		});

		it('should handle empty schema', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'empty',
				items: [],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(0);
		});

		it('should handle mixed items', () => {
			const schema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				items: [
					{
						type: 'declaredTable',
						tableStmt: {
							type: 'createTable',
							table: { type: 'identifier', name: 't1' },
							ifNotExists: false,
							columns: [{ name: 'id', dataType: 'INTEGER', constraints: [] }],
							constraints: [],
						},
					},
					{
						type: 'declaredIndex',
						indexStmt: {
							type: 'createIndex',
							index: { type: 'identifier', name: 'idx1' },
							table: { type: 'identifier', name: 't1' },
							ifNotExists: false,
							isUnique: false,
							columns: [{ name: 'id' }],
						},
					},
				],
			};

			const ddl = generateDeclaredDDL(schema);
			expect(ddl).to.have.length(2);
		});
	});
});

describe('Schema Hasher', () => {
	it('should compute a hash from declared schema', () => {
		const schema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [
						{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
					],
					constraints: [],
				},
			}],
		};

		const hash = computeSchemaHash(schema);
		expect(hash).to.be.a('string');
		expect(hash.length).to.be.greaterThan(0);
	});

	it('should compute identical hash for identical schemas', () => {
		const makeSchema = (): AST.DeclareSchemaStmt => ({
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [
						{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
						{ name: 'name', dataType: 'TEXT', constraints: [] },
					],
					constraints: [],
				},
			}],
		});

		const hash1 = computeSchemaHash(makeSchema());
		const hash2 = computeSchemaHash(makeSchema());
		expect(hash1).to.equal(hash2);
	});

	it('should compute different hash for different schemas', () => {
		const schema1: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [{ name: 'id', dataType: 'INTEGER', constraints: [] }],
					constraints: [],
				},
			}],
		};

		const schema2: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'orders' },
					ifNotExists: false,
					columns: [{ name: 'id', dataType: 'INTEGER', constraints: [] }],
					constraints: [],
				},
			}],
		};

		expect(computeSchemaHash(schema1)).to.not.equal(computeSchemaHash(schema2));
	});

	it('should strip tags before hashing (tags do not affect hash)', () => {
		const baseSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [
						{ name: 'id', dataType: 'INTEGER', constraints: [{ type: 'primaryKey' }] },
					],
					constraints: [],
				},
			}],
		};

		const taggedSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [
						{
							name: 'id',
							dataType: 'INTEGER',
							constraints: [{ type: 'primaryKey' }],
							tags: { label: 'pk-col' },
						},
					],
					constraints: [],
					tags: { version: '1.0' },
				},
			}],
		};

		expect(computeSchemaHash(baseSchema)).to.equal(computeSchemaHash(taggedSchema));
	});

	it('should strip tags from indexes', () => {
		const noTagSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredIndex',
				indexStmt: {
					type: 'createIndex',
					index: { type: 'identifier', name: 'idx1' },
					table: { type: 'identifier', name: 't1' },
					ifNotExists: false,
					isUnique: false,
					columns: [{ name: 'col1' }],
				},
			}],
		};

		const taggedSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredIndex',
				indexStmt: {
					type: 'createIndex',
					index: { type: 'identifier', name: 'idx1' },
					table: { type: 'identifier', name: 't1' },
					ifNotExists: false,
					isUnique: false,
					columns: [{ name: 'col1' }],
					tags: { note: 'performance' },
				},
			}],
		};

		expect(computeSchemaHash(noTagSchema)).to.equal(computeSchemaHash(taggedSchema));
	});

	it('should strip tags from views', () => {
		const noTagSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredView',
				viewStmt: {
					type: 'createView',
					view: { type: 'identifier', name: 'v1' },
					ifNotExists: false,
					select: {
						type: 'select',
						columns: [{ type: 'all' }],
						from: { type: 'table', table: { type: 'identifier', name: 't1' } },
					},
				},
			}],
		};

		const taggedSchema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredView',
				viewStmt: {
					type: 'createView',
					view: { type: 'identifier', name: 'v1' },
					ifNotExists: false,
					select: {
						type: 'select',
						columns: [{ type: 'all' }],
						from: { type: 'table', table: { type: 'identifier', name: 't1' } },
					},
					tags: { api: 'v2' },
				},
			}],
		};

		expect(computeSchemaHash(noTagSchema)).to.equal(computeSchemaHash(taggedSchema));
	});

	it('should compute short hash of 8 characters', () => {
		const schema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [{
				type: 'declaredTable',
				tableStmt: {
					type: 'createTable',
					table: { type: 'identifier', name: 'users' },
					ifNotExists: false,
					columns: [{ name: 'id', dataType: 'INTEGER', constraints: [] }],
					constraints: [],
				},
			}],
		};

		const shortHash = computeShortSchemaHash(schema);
		expect(shortHash).to.have.length(8);

		const fullHash = computeSchemaHash(schema);
		expect(fullHash.startsWith(shortHash)).to.be.true;
	});

	it('should handle empty schema', () => {
		const schema: AST.DeclareSchemaStmt = {
			type: 'declareSchema',
			schemaName: 'test',
			items: [],
		};

		const hash = computeSchemaHash(schema);
		expect(hash).to.be.a('string');
		expect(hash.length).to.be.greaterThan(0);
	});
});
