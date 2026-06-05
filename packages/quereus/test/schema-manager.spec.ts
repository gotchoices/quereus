/**
 * Schema manager tests — written from the public interface only.
 *
 * Covers: schema creation, table/view lookup, multi-schema resolution,
 * search path behaviour, error cases, and schema clearing.
 *
 * Uses the Database public API (which delegates to SchemaManager) plus
 * direct SchemaManager access where the public API is the manager itself.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { Schema } from '../src/schema/schema.js';
import { parse } from '../src/parser/index.js';
import { computeSchemaHash } from '../src/schema/schema-hasher.js';
import type { DeclareSchemaStmt } from '../src/parser/ast.js';

describe('Schema Manager', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// ─────────────────────── Default schemas ───────────────────────
	describe('Default schemas', () => {
		it('should have main and temp schemas', () => {
			const sm = db.schemaManager;
			expect(sm.getCurrentSchemaName()).to.equal('main');
			expect(sm.getSchemaOrFail('main')).to.be.instanceOf(Schema);
			expect(sm.getSchemaOrFail('temp')).to.be.instanceOf(Schema);
		});

		it('should throw for non-existent schema', () => {
			expect(() => db.schemaManager.getSchemaOrFail('nosuch')).to.throw();
		});
	});

	// ─────────────────────── Adding schemas ───────────────────────
	describe('addSchema', () => {
		it('should create a new schema', () => {
			const schema = db.schemaManager.addSchema('aux');
			expect(schema).to.be.instanceOf(Schema);
			expect(schema.name).to.equal('aux');
			expect(db.schemaManager.getSchemaOrFail('aux')).to.equal(schema);
		});

		it('should be case-insensitive', () => {
			db.schemaManager.addSchema('AUX');
			expect(db.schemaManager.getSchemaOrFail('aux')).to.exist;
		});

		it('should throw on duplicate name', () => {
			expect(() => db.schemaManager.addSchema('main')).to.throw();
		});
	});

	// ─────────────────── Current schema switching ───────────────────
	describe('setCurrentSchema', () => {
		it('should change the current schema', () => {
			db.schemaManager.addSchema('other');
			db.schemaManager.setCurrentSchema('other');
			expect(db.schemaManager.getCurrentSchemaName()).to.equal('other');
		});

		it('should silently ignore non-existent schema', () => {
			db.schemaManager.setCurrentSchema('nonexistent');
			expect(db.schemaManager.getCurrentSchemaName()).to.equal('main');
		});
	});

	// ────────────────── Table creation and lookup ──────────────────
	describe('Table operations via SQL', () => {
		it('should create a table and find it', async () => {
			await db.exec('create table t1 (id integer primary key, name text)');
			const found = db.schemaManager.findTable('t1');
			expect(found).to.exist;
			expect(found!.name).to.equal('t1');
			expect(found!.columns.length).to.equal(2);
		});

		it('should find tables case-insensitively', async () => {
			await db.exec('create table MyTable (id integer primary key)');
			expect(db.schemaManager.findTable('mytable')).to.exist;
			expect(db.schemaManager.findTable('MYTABLE')).to.exist;
		});

		it('should return undefined for missing table', () => {
			expect(db.schemaManager.findTable('nonexistent')).to.be.undefined;
		});
	});

	// ────────────────── View operations ──────────────────
	describe('View operations via SQL', () => {
		it('should create a view and look it up via getSchemaItem', async () => {
			await db.exec('create table base (id integer primary key, v text)');
			await db.exec('create view v1 as select id, v from base');
			const item = db.schemaManager.getSchemaItem(null, 'v1');
			expect(item).to.exist;
		});

		it('views should shadow tables of the same name in getSchemaItem', async () => {
			// getSchemaItem checks views first
			await db.exec('create table dual_name (id integer primary key)');
			await db.exec('create view dual_name_view as select 1 as x');
			const item = db.schemaManager.getSchemaItem(null, 'dual_name_view');
			expect(item).to.exist;
		});
	});

	// ────────────────── clearAll ──────────────────
	describe('clearAll', () => {
		it('should remove all tables', async () => {
			await db.exec('create table t1 (id integer primary key)');
			await db.exec('create table t2 (id integer primary key)');
			expect(db.schemaManager.findTable('t1')).to.exist;

			db.schemaManager.clearAll();
			expect(db.schemaManager.findTable('t1')).to.be.undefined;
			expect(db.schemaManager.findTable('t2')).to.be.undefined;
		});
	});

	// ────────────────── Metadata tags ──────────────────
	describe('Metadata tags', () => {
		it('should return tags on a table created with WITH TAGS', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (display_name = 'Test', audit = true)");
			const tags = db.schemaManager.getTableTags('t1');
			expect(tags).to.deep.equal({ display_name: 'Test', audit: true });
		});

		it('should return undefined for a table without tags', async () => {
			await db.exec('create table t1 (id integer primary key)');
			const tags = db.schemaManager.getTableTags('t1');
			expect(tags).to.be.undefined;
		});

		it('should set tags via setTableTags', async () => {
			await db.exec('create table t1 (id integer primary key)');
			db.schemaManager.setTableTags('t1', { label: 'new' });
			const tags = db.schemaManager.getTableTags('t1');
			expect(tags).to.deep.equal({ label: 'new' });
		});

		it('should clear tags when setting empty object', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (x = 1)");
			db.schemaManager.setTableTags('t1', {});
			expect(db.schemaManager.getTableTags('t1')).to.be.undefined;
		});

		it('should throw when setting tags on non-existent table', () => {
			expect(() => db.schemaManager.setTableTags('nonexistent', { a: 1 })).to.throw();
		});

		it('should preserve column-level tags', async () => {
			await db.exec("create table t1 (id integer primary key, name text with tags (display_name = 'Name'))");
			const table = db.schemaManager.findTable('t1');
			expect(table).to.exist;
			expect(table!.columns[0].tags).to.be.undefined;
			expect(table!.columns[1].tags).to.deep.equal({ display_name: 'Name' });
		});

		it('should attach unnamed-constraint trailing WITH TAGS to the column', async () => {
			// `WITH TAGS` after an unnamed inline constraint (PK) attaches to the
			// column itself — this matches the natural reading of the syntax and
			// is what the rename-detection differ relies on (`quereus.previous_name`
			// hints have to land on the column).
			await db.exec("create table t1 (id integer primary key with tags (pk_info = 'auto'), name text)");
			const table = db.schemaManager.findTable('t1');
			expect(table).to.exist;
			expect(table!.columns[0].tags).to.deep.equal({ pk_info: 'auto' });
		});

		it('should preserve constraint-level tags on a NAMED CHECK constraint', async () => {
			// To anchor tags on a constraint instead of the column, the constraint
			// must be named — otherwise the tags fall through to the column.
			await db.exec("create table t1 (id integer primary key, qty integer not null constraint chk_qty check (qty > 0) with tags (msg = 'positive'))");
			const table = db.schemaManager.findTable('t1');
			expect(table).to.exist;
			expect(table!.checkConstraints.length).to.equal(1);
			expect(table!.checkConstraints[0].name).to.equal('chk_qty');
			expect(table!.checkConstraints[0].tags).to.deep.equal({ msg: 'positive' });
		});

		it('should preserve view-level tags', async () => {
			await db.exec('create table base (id integer primary key)');
			await db.exec("create view v1 as select * from base with tags (cacheable = true)");
			const view = db.schemaManager.getView('main', 'v1');
			expect(view).to.exist;
			expect(view!.tags).to.deep.equal({ cacheable: true });
		});

		// ── setColumnTags ──
		it('should set column tags via setColumnTags', async () => {
			await db.exec('create table t1 (id integer primary key, name text)');
			db.schemaManager.setColumnTags('t1', 'name', { searchable: true, display_name: 'Name' });
			const table = db.schemaManager.findTable('t1');
			expect(table!.columns[1].tags).to.deep.equal({ searchable: true, display_name: 'Name' });
		});

		it('should clear column tags when setting empty object', async () => {
			await db.exec("create table t1 (id integer primary key, name text with tags (x = 1))");
			db.schemaManager.setColumnTags('t1', 'name', {});
			const table = db.schemaManager.findTable('t1');
			expect(table!.columns[1].tags).to.be.undefined;
		});

		it('should not disturb other column attributes when setting column tags', async () => {
			await db.exec("create table t1 (id integer primary key, name text not null default 'x')");
			db.schemaManager.setColumnTags('t1', 'name', { a: 1 });
			const col = db.schemaManager.findTable('t1')!.columns[1];
			expect(col.notNull, 'NOT NULL preserved').to.be.true;
			expect(col.defaultValue, 'DEFAULT preserved').to.not.be.null;
			expect(col.tags).to.deep.equal({ a: 1 });
		});

		it('should throw NOTFOUND when setting column tags on an unknown column', async () => {
			await db.exec('create table t1 (id integer primary key)');
			expect(() => db.schemaManager.setColumnTags('t1', 'nope', { a: 1 })).to.throw(/not found/i);
		});

		it('should throw when setting column tags on an unknown table', () => {
			expect(() => db.schemaManager.setColumnTags('nope', 'c', { a: 1 })).to.throw();
		});

		// ── setConstraintTags ──
		it('should set tags on a named UNIQUE constraint', async () => {
			await db.exec('create table t1 (id integer primary key, email text, constraint uq_e unique (email))');
			db.schemaManager.setConstraintTags('t1', 'uq_e', { msg: 'unique' });
			const uc = db.schemaManager.findTable('t1')!.uniqueConstraints!.find(c => c.name === 'uq_e');
			expect(uc!.tags).to.deep.equal({ msg: 'unique' });
		});

		it('should set tags on a named CHECK constraint', async () => {
			await db.exec('create table t1 (id integer primary key, qty integer, constraint chk_q check (qty > 0))');
			db.schemaManager.setConstraintTags('t1', 'chk_q', { msg: 'positive' });
			const cc = db.schemaManager.findTable('t1')!.checkConstraints.find(c => c.name === 'chk_q');
			expect(cc!.tags).to.deep.equal({ msg: 'positive' });
		});

		it('should clear constraint tags when setting empty object', async () => {
			await db.exec("create table t1 (id integer primary key, email text, constraint uq_e unique (email) with tags (x = 1))");
			db.schemaManager.setConstraintTags('t1', 'uq_e', {});
			const uc = db.schemaManager.findTable('t1')!.uniqueConstraints!.find(c => c.name === 'uq_e');
			expect(uc!.tags).to.be.undefined;
		});

		it('should throw NOTFOUND when setting tags on an unknown constraint', async () => {
			await db.exec('create table t1 (id integer primary key)');
			expect(() => db.schemaManager.setConstraintTags('t1', 'nope', { a: 1 })).to.throw(/not found/i);
		});
	});

	// ────────────────── Schema hashing: tags excluded ──────────────────
	describe('Schema hashing with tags', () => {
		it('should produce the same hash regardless of tags', () => {
			const withoutTags = parse('declare schema test { table t1 (id integer primary key); }') as DeclareSchemaStmt;
			const withTags = parse("declare schema test { table t1 (id integer primary key) with tags (label = 'hello'); }") as DeclareSchemaStmt;
			expect(computeSchemaHash(withoutTags)).to.equal(computeSchemaHash(withTags));
		});

		it('should produce the same hash regardless of column tags', () => {
			const withoutTags = parse('declare schema test { table t1 (id integer primary key, name text); }') as DeclareSchemaStmt;
			const withTags = parse("declare schema test { table t1 (id integer primary key with tags (x = 1), name text); }") as DeclareSchemaStmt;
			expect(computeSchemaHash(withoutTags)).to.equal(computeSchemaHash(withTags));
		});

		it('should produce different hashes when schema structure differs', () => {
			const schema1 = parse('declare schema test { table t1 (id integer primary key); }') as DeclareSchemaStmt;
			const schema2 = parse('declare schema test { table t1 (id integer primary key, name text); }') as DeclareSchemaStmt;
			expect(computeSchemaHash(schema1)).to.not.equal(computeSchemaHash(schema2));
		});

		it('should produce the same hash regardless of tag VALUE (tag-only change is hash-neutral)', () => {
			// A tag-only mutation (the declarative analogue of `alter table set tags`)
			// must not perturb the structural schema hash — tags are excluded entirely.
			const v1 = parse("declare schema test { table t1 (id integer primary key) with tags (label = 'a'); }") as DeclareSchemaStmt;
			const v2 = parse("declare schema test { table t1 (id integer primary key) with tags (label = 'b'); }") as DeclareSchemaStmt;
			expect(computeSchemaHash(v1)).to.equal(computeSchemaHash(v2));
		});

		it('should produce the same hash regardless of constraint tag VALUE', () => {
			const v1 = parse("declare schema test { table t1 (id integer primary key, email text, constraint uq unique (email) with tags (m = '1')); }") as DeclareSchemaStmt;
			const v2 = parse("declare schema test { table t1 (id integer primary key, email text, constraint uq unique (email) with tags (m = '2')); }") as DeclareSchemaStmt;
			expect(computeSchemaHash(v1)).to.equal(computeSchemaHash(v2));
		});
	});

	// ────────────────── Schema items in specific schemas ──────────────────
	describe('getSchemaItem with explicit schema', () => {
		it('should find items in specified schema', async () => {
			await db.exec('create table t1 (id integer primary key)');
			expect(db.schemaManager.getSchemaItem('main', 't1')).to.exist;
		});

		it('should return undefined for wrong schema', async () => {
			await db.exec('create table t1 (id integer primary key)');
			db.schemaManager.addSchema('aux');
			expect(db.schemaManager.getSchemaItem('aux', 't1')).to.be.undefined;
		});
	});
});

