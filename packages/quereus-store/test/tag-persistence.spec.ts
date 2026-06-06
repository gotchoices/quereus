import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildCatalogKey,
	type KVStore,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * A persistent in-memory provider: unlike the teardown-flavored factory in
 * `rehydrate-catalog.spec.ts`, its `closeStore` / `closeIndexStore` / `closeAll`
 * are no-ops, so the underlying data survives a *logical* `StoreModule.closeAll()`
 * — mirroring real disk. This lets a test close db1's module (which drains the
 * catalog persist queue) and then reopen the SAME storage with a fresh module,
 * the only way to express close → reopen. `_hardClose()` is the real teardown.
 */
function createPersistentProvider(): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};

	return {
		stores,
		async getStore(schemaName: string, tableName: string) {
			return getOrCreate(`${schemaName}.${tableName}`);
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return getOrCreate(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore(schemaName: string, tableName: string) {
			return getOrCreate(`${schemaName}.${tableName}.__stats__`);
		},
		async getCatalogStore() {
			return getOrCreate('__catalog__');
		},
		async closeStore() {
			/* no-op: durable storage survives a logical close */
		},
		async closeIndexStore() {
			/* no-op */
		},
		async closeAll() {
			/* no-op: data survives module close, mirroring real disk */
		},
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule catalog-only tag persistence', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => {
		provider = createPersistentProvider();
	});

	afterEach(() => {
		provider._hardClose();
	});

	/** Phase 1: create a fresh db + module over the shared provider. */
	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	/** Phase 2: a brand-new db + module rehydrates the same provider's catalog. */
	async function reopen(): Promise<Database> {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		const result = await mod.rehydrateCatalog(db);
		expect(result.errors, 're-parsed catalog DDL parses cleanly').to.have.lengthOf(0);
		return db;
	}

	it('table tags persist across reopen (closeAll drains)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, name text) using store`);
		// INSERT persists the table's DDL to the catalog (lazy on first store access),
		// so the catalog-present check in the listener fires on the later SET TAGS.
		await db.exec(`insert into t values (1, 'x')`);
		await db.exec(`alter table t set tags (display_name = 'Widgets', audit = true)`);
		await mod.closeAll(); // unsubscribes + drains the persist queue before close

		const db2 = await reopen();
		expect(db2.schemaManager.getTableTags('t')).to.deep.equal({ display_name: 'Widgets', audit: true });
	});

	it('column tags persist across reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, name text) using store`);
		await db.exec(`insert into t values (1, 'x')`);
		await db.exec(`alter table t alter column name set tags (searchable = true, display_name = 'Name')`);
		await mod.closeAll();

		const db2 = await reopen();
		const col = db2.schemaManager.findTable('t')!.columns.find(c => c.name === 'name')!;
		expect(col.tags).to.deep.equal({ searchable: true, display_name: 'Name' });
	});

	it('named UNIQUE constraint tags persist across reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, email text, constraint uq_email unique (email)) using store`);
		await db.exec(`insert into t values (1, 'a@x')`);
		await db.exec(`alter table t alter constraint uq_email set tags (error_message = 'Email must be unique')`);
		await mod.closeAll();

		const db2 = await reopen();
		const uc = db2.schemaManager.findTable('t')!.uniqueConstraints!.find(c => c.name === 'uq_email')!;
		expect(uc.tags).to.deep.equal({ error_message: 'Email must be unique' });

		// The reopened UNIQUE still enforces (tags are metadata, not a relaxation).
		let rejected = false;
		try {
			await db2.exec(`insert into t values (2, 'a@x')`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'duplicate email still rejected after reopen').to.be.true;
	});

	it('named CHECK constraint tags persist across reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, qty integer, constraint chk_qty check (qty >= 0)) using store`);
		await db.exec(`insert into t values (1, 5)`);
		await db.exec(`alter table t alter constraint chk_qty set tags (error_message = 'Quantity must be non-negative')`);
		await mod.closeAll();

		const db2 = await reopen();
		const cc = db2.schemaManager.findTable('t')!.checkConstraints.find(c => c.name === 'chk_qty')!;
		expect(cc.tags).to.deep.equal({ error_message: 'Quantity must be non-negative' });

		// The reopened CHECK still enforces (tags are metadata, not a relaxation).
		let rejected = false;
		try {
			await db2.exec(`insert into t values (2, -1)`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'CHECK still rejected after reopen').to.be.true;
	});

	it('named FOREIGN KEY constraint tags persist across reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table parent (id integer primary key) using store`);
		await db.exec(`insert into parent values (1)`);
		await db.exec(`create table child (id integer primary key, pid integer, constraint fk_p foreign key (pid) references parent(id)) using store`);
		await db.exec(`insert into child values (1, 1)`);
		await db.exec(`alter table child alter constraint fk_p set tags (error_message = 'Unknown parent')`);
		await mod.closeAll();

		const db2 = await reopen();
		const fk = db2.schemaManager.findTable('child')!.foreignKeys!.find(c => c.name === 'fk_p')!;
		expect(fk.tags).to.deep.equal({ error_message: 'Unknown parent' });
	});

	it('clearing tags (SET TAGS ()) round-trips, and successive swaps serialize in order', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (1)`);
		// Two swaps back-to-back: the queue must apply them in order so the final
		// state after draining is "cleared".
		await db.exec(`alter table t set tags (x = 1)`);
		await db.exec(`alter table t set tags ()`);
		await mod.closeAll();

		const db2 = await reopen();
		expect(db2.schemaManager.getTableTags('t')).to.be.undefined;
	});

	it('re-setting tags to a new value persists the latest value', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (1)`);
		await db.exec(`alter table t set tags (display_name = 'First')`);
		await db.exec(`alter table t set tags (display_name = 'Second')`);
		await mod.closeAll();

		const db2 = await reopen();
		expect(db2.schemaManager.getTableTags('t')).to.deep.equal({ display_name: 'Second' });
	});

	it('persists without an explicit close (whenCatalogPersisted barrier)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (1)`);
		await db.exec(`alter table t set tags (k = 'v')`);

		// In-session, the swap is already live in memory.
		expect(db.schemaManager.getTableTags('t')).to.deep.equal({ k: 'v' });

		// Draining the barrier (no close) makes the catalog current.
		await mod.whenCatalogPersisted();
		const db2 = await reopen();
		expect(db2.schemaManager.getTableTags('t')).to.deep.equal({ k: 'v' });
	});

	it('SET TAGS on a non-store table in the same db leaves the store catalog untouched', async () => {
		const { db, mod } = open();
		// A memory-backed table (default module) alongside a store table.
		await db.exec(`create table mem_t (id integer primary key, name text)`);
		await db.exec(`insert into mem_t values (1, 'm')`);
		await db.exec(`create table store_t (id integer primary key) using store`);
		await db.exec(`insert into store_t values (1)`); // persist store_t DDL

		await db.exec(`alter table mem_t set tags (display_name = 'Mem')`);
		await mod.whenCatalogPersisted();

		const catalog = await provider.getCatalogStore();
		expect(
			await catalog.get(buildCatalogKey('main', 'mem_t')),
			'memory table must NOT be written into the store catalog',
		).to.be.undefined;
		expect(
			await catalog.get(buildCatalogKey('main', 'store_t')),
			'store table catalog entry is present',
		).to.not.be.undefined;
	});

	it('a structural ALTER does not produce a second, differing catalog write', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, name text) using store`);
		await db.exec(`insert into t values (1, 'x')`); // persist DDL (ddlSaved = true)

		// Spy on catalog puts AFTER the initial persistence is done.
		const catalog: KVStore = await provider.getCatalogStore();
		let putCount = 0;
		const origPut = catalog.put.bind(catalog);
		catalog.put = async (key: Uint8Array, value: Uint8Array) => {
			putCount++;
			await origPut(key, value);
		};

		// ADD COLUMN: the store's own alterTable writes the final DDL once; the engine
		// then fires table_modified with the same final schema, so the listener must
		// read identical DDL and skip — no double-write, no clobber.
		await db.exec(`alter table t add column age integer null`);
		await mod.whenCatalogPersisted();

		expect(putCount, 'exactly one catalog write (module); listener skipped identical DDL').to.equal(1);

		const db2 = await reopen();
		const t = db2.schemaManager.findTable('t')!;
		expect(t.columns.map(c => c.name)).to.deep.equal(['id', 'name', 'age']);
	});

	it('after closeAll the listener is detached: a later table_modified does not persist', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (1)`);
		await db.exec(`alter table t set tags (a = 1)`);
		await mod.closeAll(); // unsubscribes the listener

		const catalog = await provider.getCatalogStore();
		const before = await catalog.get(buildCatalogKey('main', 't'));
		expect(before, 'catalog has the table after drain').to.not.be.undefined;

		// The engine catalog still holds 't'; fire another tag swap on db's notifier.
		// The module listener is gone, so nothing should be re-persisted.
		db.schemaManager.setTableTags('t', { a: 2 });
		await Promise.resolve(); // let any stray microtask run

		const after = await catalog.get(buildCatalogKey('main', 't'));
		const dec = new TextDecoder();
		expect(dec.decode(after!), 'catalog DDL unchanged after unsubscribe').to.equal(dec.decode(before!));
	});
});
