import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider & { stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();

	return {
		stores,
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			const key = `${schemaName}.${tableName}_idx_${indexName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getStatsStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}.__stats__`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getCatalogStore() {
			const key = '__catalog__';
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async closeStore(_schemaName: string, _tableName: string) {
			// No-op for in-memory stores
		},
		async closeIndexStore(_schemaName: string, _tableName: string, _indexName: string) {
			// No-op for in-memory stores
		},
		async closeAll() {
			for (const store of stores.values()) {
				await store.close();
			}
			stores.clear();
		},
	};
}

describe('StoreModule.rehydrateCatalog()', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('rehydrates a single table from persisted catalog', async () => {
		// Phase 1: create table and persist DDL
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				name TEXT
			) USING store
		`);
		await db1.exec(`INSERT INTO items VALUES (1, 'Widget')`);

		// Phase 2: new Database, same provider — rehydrate
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);

		const result = await mod2.rehydrateCatalog(db2);

		expect(result.errors).to.have.lengthOf(0);
		expect(result.tables).to.have.lengthOf(1);

		// Table should be queryable
		const rows = await asyncIterableToArray(db2.eval('select id, name from items'));
		expect(rows).to.deep.equal([{ id: 1, name: 'Widget' }]);
	});

	it('rehydrates multiple tables', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`CREATE TABLE a (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`CREATE TABLE b (id INTEGER PRIMARY KEY, val TEXT) USING store`);
		// Touch both tables so DDL gets persisted to the catalog
		await db1.exec(`INSERT INTO a VALUES (1)`);
		await db1.exec(`INSERT INTO b VALUES (1, 'x')`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);

		const result = await mod2.rehydrateCatalog(db2);

		expect(result.errors).to.have.lengthOf(0);
		expect(result.tables).to.have.lengthOf(2);
	});

	it('returns empty result for empty catalog', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		const result = await mod.rehydrateCatalog(db);

		expect(result.tables).to.have.lengthOf(0);
		expect(result.indexes).to.have.lengthOf(0);
		expect(result.errors).to.have.lengthOf(0);
	});

	it('collects errors for corrupt DDL without blocking other tables', async () => {
		// Phase 1: create a real table and touch it to persist DDL
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`CREATE TABLE good (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`INSERT INTO good VALUES (1)`);

		// Manually inject a corrupt DDL entry into the catalog
		const catalogStore = await provider.getCatalogStore();
		const encoder = new TextEncoder();
		await catalogStore.put(
			encoder.encode('main.corrupt'),
			encoder.encode('THIS IS NOT VALID SQL')
		);

		// Phase 2: rehydrate — corrupt entry should be skipped
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);

		const result = await mod2.rehydrateCatalog(db2);

		expect(result.errors).to.have.lengthOf(1);
		expect(result.errors[0].ddl).to.equal('THIS IS NOT VALID SQL');
		expect(result.tables).to.include('main.good');
	});

	it('APPLY SCHEMA sees rehydrated tables and generates correct diff', async () => {
		// Phase 1: create table with original schema
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT
			) USING store
		`);
		await db1.exec(`INSERT INTO users VALUES (1, 'Alice')`);

		// Phase 2: new Database, rehydrate, then APPLY SCHEMA with added column
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		db2.setDefaultVtabName('store');

		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors).to.have.lengthOf(0);

		// Declare schema with an additional column
		await db2.exec(`
			declare schema main
				using (default_vtab_module = 'store')
			{
				table users {
					id INTEGER PRIMARY KEY,
					name TEXT,
					email TEXT NULL
				}
			}
		`);

		// Apply should ADD COLUMN, not try to CREATE TABLE
		await db2.exec(`apply schema main`);

		// Verify the column was added and data preserved
		const rows = await asyncIterableToArray(db2.eval('select id, name, email from users'));
		expect(rows).to.deep.equal([{ id: 1, name: 'Alice', email: null }]);
	});

	it('no-ops APPLY SCHEMA when persisted schema matches declared schema', async () => {
		// Phase 1: create table
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING store
		`);
		await db1.exec(`INSERT INTO items VALUES (1, 'Widget')`);

		// Phase 2: rehydrate and declare identical schema
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		db2.setDefaultVtabName('store');

		await mod2.rehydrateCatalog(db2);

		await db2.exec(`
			declare schema main
				using (default_vtab_module = 'store')
			{
				table items {
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL
				}
			}
		`);

		// DIFF should produce no migration statements
		const diffRows = await asyncIterableToArray(db2.eval('diff schema main'));
		expect(diffRows).to.have.lengthOf(0);

		// APPLY should be a no-op
		await db2.exec(`apply schema main`);

		// Data preserved
		const rows = await asyncIterableToArray(db2.eval('select * from items'));
		expect(rows).to.deep.equal([{ id: 1, name: 'Widget' }]);
	});

	// Constraint-survival across reopen: generateTableDDL persists the catalog DDL
	// that rehydrateCatalog re-parses, so a table's UNIQUE / CHECK / FOREIGN KEY
	// constraints must still ENFORCE after a fresh Database rehydrates the catalog.
	// Before the fix, generateTableDDL dropped all table constraints, so these
	// inserts would silently succeed on reopen.
	async function expectRejected(fn: () => Promise<unknown>, msg: string): Promise<void> {
		let rejected = false;
		try {
			await fn();
		} catch (e) {
			rejected = true;
			expect(String(e), `${msg}: error mentions constraint`).to.match(/constraint/i);
		}
		expect(rejected, msg).to.be.true;
	}

	it('UNIQUE constraint survives reopen and still rejects duplicates', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec(`
			CREATE TABLE uq_t (
				id INTEGER PRIMARY KEY,
				email TEXT,
				CONSTRAINT uq_email UNIQUE (email)
			) USING store
		`);
		// Insert persists the DDL (and a row) so the constraint must round-trip.
		await db1.exec(`INSERT INTO uq_t VALUES (1, 'a@x.com')`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed constraint DDL parses cleanly').to.have.lengthOf(0);

		// A duplicate of the persisted email is still rejected after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO uq_t VALUES (2, 'a@x.com')`),
			'duplicate email rejected after reopen',
		);
		// A distinct email still succeeds.
		await db2.exec(`INSERT INTO uq_t VALUES (3, 'b@x.com')`);
	});

	it('CHECK constraint survives reopen and still rejects violations', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec(`
			CREATE TABLE chk_t (
				id INTEGER PRIMARY KEY,
				qty INTEGER,
				CONSTRAINT chk_qty CHECK (qty > 0)
			) USING store
		`);
		await db1.exec(`INSERT INTO chk_t VALUES (1, 5)`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed constraint DDL parses cleanly').to.have.lengthOf(0);

		// A CHECK-violating insert is still rejected after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO chk_t VALUES (2, -1)`),
			'CHECK violation rejected after reopen',
		);
		// A satisfying insert still succeeds.
		await db2.exec(`INSERT INTO chk_t VALUES (3, 10)`);
	});

	it('FOREIGN KEY constraint survives reopen and still rejects orphans', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('PRAGMA foreign_keys = true');
		await db1.exec(`CREATE TABLE fk_parent (pid INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`
			CREATE TABLE fk_child (
				id INTEGER PRIMARY KEY,
				pref INTEGER,
				CONSTRAINT fk_pref FOREIGN KEY (pref) REFERENCES fk_parent (pid)
			) USING store
		`);
		await db1.exec(`INSERT INTO fk_parent VALUES (1)`);
		// Valid child (parent 1 exists); persists both tables' DDL.
		await db1.exec(`INSERT INTO fk_child VALUES (10, 1)`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('PRAGMA foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed constraint DDL parses cleanly').to.have.lengthOf(0);

		// An orphan child (no parent pid=99) is still rejected after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO fk_child VALUES (20, 99)`),
			'orphan child rejected after reopen',
		);
		// A valid child (parent pid=1 exists) still succeeds.
		await db2.exec(`INSERT INTO fk_child VALUES (21, 1)`);
	});

	// ALTER TABLE ADD COLUMN with a column-level constraint must persist that
	// constraint into the catalog DDL — the engine merges it into the live
	// in-memory schema, but only the store's persisted DDL survives reopen.
	it('ADD COLUMN column-level FOREIGN KEY survives reopen and still rejects orphans', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('PRAGMA foreign_keys = true');
		await db1.exec(`CREATE TABLE p (pid INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`CREATE TABLE c (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`INSERT INTO p VALUES (1)`);
		await db1.exec(`INSERT INTO c VALUES (10)`);
		// Add a column carrying a column-level FK. The column is nullable, so the
		// existing row's new value is NULL, which MATCH-SIMPLE exempts from the FK —
		// the ALTER succeeds. (Without NULL the store defaults to NOT NULL and rejects
		// the no-default backfill on a non-empty table.)
		await db1.exec(`ALTER TABLE c ADD COLUMN pref INTEGER NULL REFERENCES p (pid)`);
		// Live enforcement: an orphan is rejected in the same session.
		await expectRejected(
			() => db1.exec(`INSERT INTO c VALUES (11, 99)`),
			'orphan rejected live (pre-reopen)',
		);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('PRAGMA foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed ADD COLUMN FK DDL parses cleanly').to.have.lengthOf(0);

		// The persisted column-level FK must still reject an orphan after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO c VALUES (12, 99)`),
			'orphan child rejected after reopen',
		);
		// A valid child (parent pid=1 exists) still succeeds.
		await db2.exec(`INSERT INTO c VALUES (13, 1)`);
	});

	it('ADD COLUMN column-level CHECK survives reopen and still rejects violations', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec(`CREATE TABLE chk_add (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`INSERT INTO chk_add VALUES (1)`);
		// Column-level CHECK on the added column. The nullable column leaves the
		// existing row's qty NULL, which CHECK admits (passes on NULL), so the ALTER
		// succeeds. (NULL also dodges the store's NOT NULL no-default backfill reject.)
		await db1.exec(`ALTER TABLE chk_add ADD COLUMN qty INTEGER NULL CHECK (qty > 0)`);
		await expectRejected(
			() => db1.exec(`INSERT INTO chk_add VALUES (2, -1)`),
			'CHECK violation rejected live (pre-reopen)',
		);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed ADD COLUMN CHECK DDL parses cleanly').to.have.lengthOf(0);

		// A CHECK-violating insert is still rejected after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO chk_add VALUES (3, -5)`),
			'CHECK violation rejected after reopen',
		);
		// A satisfying insert still succeeds.
		await db2.exec(`INSERT INTO chk_add VALUES (4, 10)`);
	});

	// Persistence must NOT be gated on a foldable (literal) DEFAULT: a per-row
	// (non-foldable) DEFAULT like `new.id` rides a backfill evaluator, but the
	// column-level FK is extracted from the AST regardless and must still persist.
	it('ADD COLUMN with per-row DEFAULT + column-level FK survives reopen', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('PRAGMA foreign_keys = true');
		await db1.exec(`CREATE TABLE pp (pid INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`CREATE TABLE cc (id INTEGER PRIMARY KEY) USING store`);
		// Parent must contain every existing child id, since the new column backfills
		// each existing row to `new.id` and the FK validates those backfilled values.
		await db1.exec(`INSERT INTO pp VALUES (1)`);
		await db1.exec(`INSERT INTO cc VALUES (1)`);
		// Per-row (non-foldable) DEFAULT `new.id` + column-level FK to pp(pid).
		await db1.exec(`ALTER TABLE cc ADD COLUMN pref INTEGER DEFAULT (new.id) REFERENCES pp (pid)`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('PRAGMA foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed per-row-default ADD COLUMN FK DDL parses cleanly').to.have.lengthOf(0);

		// The persisted FK must still reject an orphan after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO cc VALUES (20, 99)`),
			'orphan child rejected after reopen (per-row default path)',
		);
		// A valid child (parent pid=1 exists) still succeeds.
		await db2.exec(`INSERT INTO cc VALUES (21, 1)`);
	});
});
