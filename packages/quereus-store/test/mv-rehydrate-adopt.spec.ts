/**
 * Adopt-without-refill at catalog rehydrate.
 *
 * The reopen matrix for the durable-backing adopt fast path: under a clean
 * shutdown (attested by the single-use `\x00meta\x00clean_shutdown` catalog
 * marker), a store-hosted maintained table whose backing phase 1 already
 * rehydrated (as a plain table under the MV's own name) is trusted as-is —
 * the MV registers without re-running its body. Any failed gate falls back
 * to the always-correct drop+refill.
 *
 * **Sentinel-divergence probe.** Each scenario plants a sentinel row directly
 * into the backing's physical KV store between sessions — content the body
 * would never produce. A post-reopen `select` of the MV serving the sentinel
 * PROVES the backing was adopted (no refill ran); the sentinel's absence
 * proves a refill. This is the adopt-vs-refill oracle throughout.
 *
 * Provider mirrors `view-mv-persistence.spec.ts`: persistent in-memory byte
 * maps whose `closeStore`/`closeAll` are no-ops, so a logical
 * `StoreModule.closeAll()` (which drains the persist queue and writes the
 * clean-shutdown marker) survives and a fresh module can reopen the same
 * storage. Skipping `StoreModule.closeAll()` therefore simulates a crash.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildDataKey,
	serializeRow,
	buildMetaCatalogKey,
	buildMaterializedViewCatalogKey,
	CLEAN_SHUTDOWN_META_NAME,
	type KVStoreProvider,
	type RehydrationResult,
} from '../src/index.js';

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
		async getStatsStore() {
			return getOrCreate('__stats__');
		},
		async getCatalogStore() {
			return getOrCreate('__catalog__');
		},
		async closeStore() { /* no-op: durable storage survives a logical close */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() { /* no-op: data survives module close, mirroring real disk */ },
		async deleteTableStores(schemaName: string, tableName: string, indexNames: readonly string[]) {
			// A refill's drop must destroy the physical stores (mirrors a real provider).
			stores.delete(`${schemaName}.${tableName}`);
			for (const i of indexNames) stores.delete(`${schemaName}.${tableName}_idx_${i}`);
		},
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	return (await asyncIterableToArray(db.eval(sql))) as Record<string, unknown>[];
}

describe('materialized-view adopt-without-refill at rehydrate', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => { provider = createPersistentProvider(); });
	afterEach(() => { provider._hardClose(); });

	/** A fresh db + module over the shared provider (first session). */
	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	/** A brand-new db + module rehydrates the same provider's catalog. */
	async function reopen(): Promise<{ db: Database; mod: StoreModule; result: RehydrationResult }> {
		const { db, mod } = open();
		const result = await mod.rehydrateCatalog(db);
		return { db, mod, result };
	}

	/** Plant a sentinel row directly in a backing's physical data store. */
	async function plantSentinel(storeName: string, row: number[]): Promise<void> {
		const s = provider.stores.get(storeName);
		expect(s, `physical store ${storeName} exists`).to.not.be.undefined;
		await s!.put(buildDataKey([row[0]]), serializeRow(row));
	}

	/** True when the catalog currently holds the clean-shutdown marker. */
	async function markerPresent(): Promise<boolean> {
		const catalog = await provider.getCatalogStore();
		return (await catalog.get(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME))) !== undefined;
	}

	/** Standard first session: store source + store-backed MV (+ a plain view so
	 *  every rehydrate phase runs alongside the meta marker), cleanly closed. */
	async function seedSession(): Promise<void> {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10), (2, 20)');
		await db.exec('create materialized view mv using store as select id, v from src');
		await db.exec('create view plain as select id from src');
		await mod.closeAll();
	}

	it('adopts a store backing after a clean shutdown: the sentinel survives and serves', async () => {
		await seedSession();
		expect(await markerPresent(), 'closeAll wrote the marker').to.equal(true);
		await plantSentinel('main.mv', [99, 990]);

		const { db, result } = await reopen();
		expect(result.errors, 'marker + tables + view + MV rehydrate cleanly').to.have.lengthOf(0);
		expect(result.materializedViews).to.deep.equal(['main.mv']);
		expect(await markerPresent(), 'marker consumed (single-use)').to.equal(false);

		// The sentinel is served through the MV — the body was NOT re-run.
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 99, v: 990 }]);

		// Adopted, not just registered: row-time maintenance is live.
		await db.exec('insert into src values (3, 30)');
		await db.exec('delete from src where id = 1');
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 2, v: 20 }, { id: 3, v: 30 }, { id: 99, v: 990 }]);

		const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
		expect(mv.vtabModuleName).to.equal('store');
		expect(mv.derivation.stale ?? false).to.equal(false);
		expect(db.schemaManager.getTable('main', 'mv')!.vtabModuleName).to.equal('store');
	});

	it('the marker is single-use: a second rehydrate without an intervening close refills', async () => {
		await seedSession();
		await plantSentinel('main.mv', [99, 990]);

		// First reopen consumes the marker and adopts (sentinel preserved).
		const r1 = await reopen();
		expect(r1.result.errors).to.have.lengthOf(0);
		expect(await rows(r1.db, 'select id from mv where id = 99')).to.deep.equal([{ id: 99 }]);

		// Second reopen WITHOUT closing r1 (a crash after the first open): no
		// marker, so the adopt gate fails and the backing refills — divergence heals.
		const r2 = await reopen();
		expect(r2.result.errors).to.have.lengthOf(0);
		expect(await rows(r2.db, 'select id, v from mv order by id'), 'refilled from the body')
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

		// A clean close re-arms the fast path for the next open.
		await r2.mod.closeAll();
		await plantSentinel('main.mv', [98, 980]);
		const r3 = await reopen();
		expect(r3.result.errors).to.have.lengthOf(0);
		expect(await rows(r3.db, 'select id from mv where id = 98'), 'adopts again after clean close')
			.to.deep.equal([{ id: 98 }]);
	});

	it('no marker — a skipped closeAll (simulated crash) refills', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv using store as select id, v from src');
		// Flush the MV catalog entry WITHOUT the clean close (no marker written).
		await mod.whenCatalogPersisted();
		expect(await markerPresent(), 'no marker without closeAll').to.equal(false);
		await plantSentinel('main.mv', [99, 990]);

		const { db: db2, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);
		expect(await rows(db2, 'select id, v from mv order by id'), 'sentinel scrubbed by the refill')
			.to.deep.equal([{ id: 1, v: 10 }]);
	});

	it('a source shape change between sessions fails the shape gate: refill matches the new shape', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv using store as select * from src');
		await mod.closeAll();

		// Session 2: widen the source so the `select *` body re-plans wider than
		// the persisted 2-column backing, then close cleanly (marker present —
		// every gate but shape passes on the next open).
		const s2 = await reopen();
		expect(s2.result.errors).to.have.lengthOf(0);
		await s2.db.exec('alter table src add column w integer default 7');
		await s2.mod.closeAll();
		await plantSentinel('main.mv', [99, 990]);

		const { db: db3, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);
		expect(await rows(db3, 'select id, v, w from mv order by id'), 'refilled to the re-planned 3-column shape')
			.to.deep.equal([{ id: 1, v: 10, w: 7 }]);
		expect(await rows(db3, 'select count(*) as n from mv where id = 99')).to.deep.equal([{ n: 0 }]);
	});

	it('a table-form IMPLICIT MV reshapes on reopen after a source widening (live-create channel)', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		// The IMPLICIT `create table … maintained as` form (no rename-list clause):
		// records derivation.columns = undefined, so its `select *` body reshapes its
		// source on reopen — the table-form analogue of the sugar `select *` test above,
		// authored through the LIVE-create channel this ticket fixed.
		await db.exec('create table mv (id integer primary key, v integer) using store maintained as select * from src');
		await mod.closeAll();

		// Session 2: widen the source so the `select *` body re-plans wider than the
		// persisted 2-column backing, then close cleanly (marker present).
		const s2 = await reopen();
		expect(s2.result.errors).to.have.lengthOf(0);
		await s2.db.exec('alter table src add column w integer default 7');
		await s2.mod.closeAll();
		await plantSentinel('main.mv', [99, 990]);

		const { db: db3, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);
		expect(await rows(db3, 'select id, v, w from mv order by id'), 'refilled to the re-planned 3-column shape')
			.to.deep.equal([{ id: 1, v: 10, w: 7 }]);
		expect(await rows(db3, 'select count(*) as n from mv where id = 99')).to.deep.equal([{ n: 0 }]);
	});

	it('a declared-column arity mismatch under trust errors per-entry without dropping the backing', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv (a, b) using store as select * from src');
		await mod.closeAll();

		// Session 2: widen the source so the `select *` body produces three columns
		// under the two-column declared list — the entry can never materialize.
		const s2 = await reopen();
		expect(s2.result.errors).to.have.lengthOf(0);
		await s2.db.exec('alter table src add column w integer default 7');
		await s2.mod.closeAll();
		await plantSentinel('main.mv', [99, 990]);

		// The `alter table src` marked mv stale, so closeAll's marker names it —
		// which would force the *refill* path (drop-then-rebuild, covered by the
		// stale-at-close tests). Re-arm full trust here to isolate the *adopt* path's
		// handling of a body that can never materialize: its arity check fires BEFORE
		// any drop (`tryAdoptPreExistingBacking`), so the durable backing survives as a
		// plain table for a later DDL fix instead of being destroyed for nothing.
		const catalog = await provider.getCatalogStore();
		await catalog.put(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME), new TextEncoder().encode('[]'));

		const { db: db3, result } = await reopen();
		expect(result.errors, 'one per-entry error').to.have.lengthOf(1);
		expect(result.errors[0].error.message).to.match(/2 declared columns but body produces 3/i);
		expect(db3.schemaManager.getMaintainedTable('main', 'mv'), 'no MV record').to.be.undefined;
		// The durable backing was NOT dropped first (the refill arm would have
		// destroyed the rows before raising the same error): it stays a plain table.
		expect(db3.schemaManager.getTable('main', 'mv'), 'backing still registered').to.not.be.undefined;
		expect(await provider.stores.get('main.mv')!.get(buildDataKey([99])), 'sentinel row preserved').to.not.be.undefined;
	});

	it('refill-path twin: a declared-column arity mismatch errors per-entry without dropping the backing', async () => {
		// Guards assertDeclaredColumnArity's placement ABOVE the adopt/refill branch in
		// importMaterializedView. Unlike the adopt-path twin above (which manually re-arms
		// `[]` to force trust), this test does NOT re-arm the marker — the `alter table src`
		// in session 2 marks mv stale-at-close, so closeAll writes a marker naming it and
		// session 3 takes the REFILL path. The arity guard fires BEFORE the DROP, so the
		// durable backing is preserved as a plain table instead of being destroyed for nothing.
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv (a, b) using store as select * from src');
		await mod.closeAll();

		// Session 2: widen the source so the `select *` body produces 3 columns under
		// the 2-column declared list — the entry can never materialize. The alter marks
		// mv stale-at-close; closeAll writes a marker naming it (no re-arm needed).
		const s2 = await reopen();
		expect(s2.result.errors).to.have.lengthOf(0);
		await s2.db.exec('alter table src add column w integer default 7');
		await s2.mod.closeAll();
		// Do NOT re-arm `[]` — stale-at-close set already names mv, forcing the REFILL path.
		await plantSentinel('main.mv', [99, 990]);

		const { db: db3, result } = await reopen();
		expect(result.errors, 'one per-entry error').to.have.lengthOf(1);
		expect(result.errors[0].error.message).to.match(/2 declared columns but body produces 3/i);
		expect(db3.schemaManager.getMaintainedTable('main', 'mv'), 'no MV record').to.be.undefined;
		// The durable backing was NOT dropped before the error: assertDeclaredColumnArity fires
		// above the drop in importMaterializedView, so rows survive for a later DDL fix.
		expect(db3.schemaManager.getTable('main', 'mv'), 'backing still registered').to.not.be.undefined;
		expect(await provider.stores.get('main.mv')!.get(buildDataKey([99])), 'sentinel row preserved').to.not.be.undefined;
	});

	it('a memory source fails the same-module gate: refill every reopen', async () => {
		const { db, mod } = open();
		// An anchor store table establishes persistence; the source is MEMORY.
		await db.exec('create table anchor (id integer primary key) using store');
		await db.exec('create table memsrc (id integer primary key, v integer)');
		await db.exec('insert into memsrc values (1, 10)');
		await db.exec('create materialized view mv using store as select id, v from memsrc');
		await mod.closeAll();
		await plantSentinel('main.mv', [99, 990]);

		// The memory source does not persist — recreate it (fresh content) BEFORE
		// rehydrating, so the body plans; the cross-module gate still forces refill
		// (the persisted backing rows are stale relative to the just-recreated source).
		const { db: db2, mod: mod2 } = open();
		await db2.exec('create table memsrc (id integer primary key, v integer)');
		await db2.exec('insert into memsrc values (1, 11), (2, 22)');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors).to.have.lengthOf(0);
		expect(await rows(db2, 'select id, v from mv order by id'), 'refilled from the fresh memory source')
			.to.deep.equal([{ id: 1, v: 11 }, { id: 2, v: 22 }]);
	});

	describe('MV-over-MV', () => {
		it('both store-backed adopt under a clean shutdown (trust composes across fixpoint rounds)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			// `amv` reads `zmv` but sorts FIRST by catalog key order. zmv's plain
			// table pre-exists from phase 1, so amv's body PLANS — the ordering gate
			// defers it (zmv's own MV entry is still pending) — and the adopt must
			// survive the deferred round (backing NOT dropped) and compose via the
			// adopt ledger in round 2.
			await db.exec('create materialized view zmv using store as select id, v from src');
			await db.exec('create materialized view amv using store as select id, v from zmv');
			await mod.closeAll();
			await plantSentinel('main.zmv', [98, 980]);
			await plantSentinel('main.amv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(result.materializedViews).to.have.members(['main.zmv', 'main.amv']);
			expect(await rows(db2, 'select id from zmv where id >= 90'), 'upstream adopted')
				.to.deep.equal([{ id: 98 }]);
			// 99 present (amv's own rows kept) and 98 ABSENT (a refill from the
			// adopted zmv would have copied 98 in and dropped 99).
			expect(await rows(db2, 'select id from amv where id >= 90'), 'dependent adopted, not refilled')
				.to.deep.equal([{ id: 99 }]);
		});

		it('a refilled upstream forces the dependent to refill (adopt-ledger gate)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10)');
			await db.exec('create materialized view zmv using store as select * from src');
			await db.exec('create materialized view amv using store as select id, v from zmv');
			await mod.closeAll();

			// Perturb the UPSTREAM's shape only: zmv (`select *`) refills next open;
			// amv's own gates (shape `id, v`, store sources, marker) all still pass.
			const s2 = await reopen();
			expect(s2.result.errors).to.have.lengthOf(0);
			await s2.db.exec('alter table src add column w integer default 7');
			await s2.mod.closeAll();
			await plantSentinel('main.zmv', [98, 980]);
			await plantSentinel('main.amv', [99, 990]);

			const { db: db3, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db3, 'select id, v, w from zmv order by id'), 'upstream refilled to the new shape')
				.to.deep.equal([{ id: 1, v: 10, w: 7 }]);
			expect(await rows(db3, 'select id, v from amv order by id'), 'dependent refilled despite its own gates passing')
				.to.deep.equal([{ id: 1, v: 10 }]);
		});

		it('a memory upstream forces the store dependent to refill (module gate)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10)');
			await db.exec('create materialized view mv1 as select id, v from src');
			await db.exec('create materialized view mv2 using store as select id, v from mv1');
			await mod.closeAll();
			await plantSentinel('main.mv2', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// mv1's memory backing was itself just recomputed; mv2 must follow it.
			expect(await rows(db2, 'select id, v from mv2 order by id'), 'dependent over a memory upstream refilled')
				.to.deep.equal([{ id: 1, v: 10 }]);
		});
	});

	it('adopt followed by a registration failure leaves the backing as a plain table (rows preserved)', async () => {
		await seedSession();
		// Hand-edit the persisted MV body: shape-identical (same projection, keys
		// preserved through the filter) so every adopt gate passes, but the
		// non-deterministic filter trips the row-time gate inside
		// registerMaterializedView — AFTER the adopt path has registered the backing.
		const catalog = await provider.getCatalogStore();
		await catalog.put(
			buildMaterializedViewCatalogKey('main', 'mv'),
			new TextEncoder().encode('create materialized view main.mv using store as select id, v from src where random() is not null'),
		);
		await plantSentinel('main.mv', [99, 990]);

		const { db, result } = await reopen();
		expect(result.errors, 'one per-entry error').to.have.lengthOf(1);
		expect(result.errors[0].error.message).to.match(/non-deterministic/i);
		expect(db.schemaManager.getMaintainedTable('main', 'mv'), 'no MV record').to.be.undefined;
		// The durable backing was NOT dropped: it reverts to a plain table and the
		// rows (sentinel included) survive for a later retry to adopt.
		expect(db.schemaManager.getTable('main', 'mv'), 'backing still registered').to.not.be.undefined;
		const backingStore = provider.stores.get('main.mv')!;
		expect(await backingStore.get(buildDataKey([99])), 'sentinel row preserved').to.not.be.undefined;
	});

	it('catalog fixed point: bytes after an adopt session equal bytes after a refill session', async () => {
		await seedSession();

		const snapshot = async (): Promise<Array<[string, string]>> => {
			const catalog = await provider.getCatalogStore();
			const dec = new TextDecoder();
			const out: Array<[string, string]> = [];
			for await (const e of catalog.iterate({ gte: new Uint8Array(0), lt: new Uint8Array([0xff]) })) {
				out.push([Array.from(e.key).join(','), dec.decode(e.value)]);
			}
			return out;
		};

		// Adopt session: marker present → adopt; clean close.
		const adoptSession = await reopen();
		expect(adoptSession.result.errors).to.have.lengthOf(0);
		await adoptSession.mod.closeAll();
		const afterAdopt = await snapshot();

		// Refill session: consume the marker without closing (simulated crash),
		// then reopen again — no marker → refill; clean close.
		await reopen();
		const refillSession = await reopen();
		expect(refillSession.result.errors).to.have.lengthOf(0);
		await refillSession.mod.closeAll();
		const afterRefill = await snapshot();

		expect(afterAdopt, 'an adopted and a refilled MV leave identical catalog bytes').to.deep.equal(afterRefill);
	});

	describe('stale-at-close exclusion', () => {
		/** Read the raw clean-shutdown marker value, or undefined when absent. */
		async function markerValue(): Promise<string | undefined> {
			const catalog = await provider.getCatalogStore();
			const raw = await catalog.get(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME));
			return raw ? new TextDecoder().decode(raw) : undefined;
		}

		it('a stale-at-close MV refills even under a clean shutdown (create index + post-stale DML)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv using store as select id, v from src');
			// `create index` fires `table_modified` on src ⇒ mv goes stale and its
			// row-time maintenance detaches. Pin the trigger.
			await db.exec('create index i on src(v)');
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale, 'create index marked the MV stale')
				.to.equal(true);
			// NOT propagated to the backing (maintenance detached) — the divergence.
			await db.exec('insert into src values (3, 30)');
			await mod.closeAll();
			expect(await markerValue(), 'marker names the stale MV').to.equal('["main.mv"]');
			await plantSentinel('main.mv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors, 'rehydrate clean').to.have.lengthOf(0);
			// Refilled: the post-stale row is present and both the sentinel and the
			// behind-backing are scrubbed. A stale adopt would have served [1,2,99].
			expect(await rows(db2, 'select id, v from mv order by id'), 'refilled to current source content')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }]);
			expect(db2.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale ?? false, 'refill cleared staleness')
				.to.equal(false);
			// Re-armed, not merely flag-cleared: a post-reopen source write now reaches
			// the refilled backing (the very maintenance that was detached at close).
			await db2.exec('insert into src values (4, 40)');
			expect(await rows(db2, 'select id, v from mv order by id'), 'live maintenance re-armed after refill')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }, { id: 4, v: 40 }]);
		});

		it('a stale-then-refreshed MV adopts (refresh clears the flag before close)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv using store as select id, v from src');
			await db.exec('create index i on src(v)');
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);
			// refresh re-materializes and re-arms maintenance, clearing `stale`.
			await db.exec('refresh materialized view mv');
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale ?? false, 'refresh cleared staleness')
				.to.equal(false);
			// Post-refresh DML now propagates to the backing again.
			await db.exec('insert into src values (3, 30)');
			await mod.closeAll();
			expect(await markerValue(), 'nothing stale at close').to.equal('[]');
			await plantSentinel('main.mv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// Adopted: the sentinel survives and serves (a refill would scrub it).
			expect(await rows(db2, 'select id, v from mv order by id'), 'adopted (not stale at close)')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }, { id: 99, v: 990 }]);
		});

		it('fine-grained: only the stale-at-close MV refills, the live one adopts', async () => {
			const { db, mod } = open();
			await db.exec('create table a (id integer primary key, v integer) using store');
			await db.exec('create table b (id integer primary key, v integer) using store');
			await db.exec('insert into a values (1, 10)');
			await db.exec('insert into b values (1, 100)');
			await db.exec('create materialized view amv using store as select id, v from a');
			await db.exec('create materialized view bmv using store as select id, v from b');
			// Only `a` is altered ⇒ only amv goes stale; bmv stays live.
			await db.exec('create index ia on a(v)');
			expect(db.schemaManager.getMaintainedTable('main', 'amv')!.derivation.stale, 'amv stale').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'bmv')!.derivation.stale ?? false, 'bmv live').to.equal(false);
			await mod.closeAll();
			expect(await markerValue(), 'marker names only the stale MV').to.equal('["main.amv"]');
			await plantSentinel('main.amv', [99, 990]);
			await plantSentinel('main.bmv', [98, 980]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db2, 'select id from amv where id = 99'), 'stale amv refilled — sentinel scrubbed')
				.to.deep.equal([]);
			expect(await rows(db2, 'select id from bmv where id = 98'), 'live bmv adopted — sentinel survives')
				.to.deep.equal([{ id: 98 }]);
		});

		it('MV-over-MV: a stale upstream cascades, both refill', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv1 using store as select id, v from src');
			await db.exec('create materialized view mv2 using store as select id, v from mv1');
			// Index on mv1's source marks mv1 stale; the backing-invalidation cascade
			// (synthetic `table_modified` on `mv1`) marks mv2 stale too.
			await db.exec('create index i on src(v)');
			expect(db.schemaManager.getMaintainedTable('main', 'mv1')!.derivation.stale, 'mv1 stale').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'mv2')!.derivation.stale, 'mv2 stale (cascade)').to.equal(true);
			await mod.closeAll();
			expect(JSON.parse((await markerValue())!), 'both MVs in the stale set')
				.to.have.members(['main.mv1', 'main.mv2']);
			await plantSentinel('main.mv1', [98, 980]);
			await plantSentinel('main.mv2', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// Both refilled end-to-end: sentinels scrubbed, content correct.
			expect(await rows(db2, 'select id, v from mv1 order by id'), 'upstream refilled')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			expect(await rows(db2, 'select id, v from mv2 order by id'), 'dependent refilled')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		});

		it('a close with no subscribed db writes an empty stale set (next session adopts)', async () => {
			// Session 1: seed + clean close.
			await seedSession();
			await plantSentinel('main.mv', [99, 990]);

			// Session 2: a module that never rehydrates and never touches a store table.
			// Its closeAll has no `subscribedDb` ⇒ writes an empty stale set, re-arming
			// the fast path rather than skipping the marker or writing garbage.
			const { mod: mod2 } = open();
			await mod2.closeAll();
			expect(await markerValue(), 'no-subscribed-db close writes an empty stale set').to.equal('[]');

			// Session 3: adopts (empty stale set ⇒ full trust) — the sentinel survives.
			const { db: db3, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db3, 'select id from mv where id = 99'), 'adopted under empty stale set')
				.to.deep.equal([{ id: 99 }]);
		});

		it('a garbage (legacy bare-flag) marker payload degrades to refill', async () => {
			await seedSession();
			// Overwrite the JSON marker with the legacy bare '1' (pre-payload format):
			// parses to a number, not a string array ⇒ conservative parse ⇒ refill all.
			const catalog = await provider.getCatalogStore();
			await catalog.put(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME), new TextEncoder().encode('1'));
			await plantSentinel('main.mv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db2, 'select id from mv where id = 99'), 'garbage payload ⇒ refill (sentinel scrubbed)')
				.to.deep.equal([]);
		});
	});

	describe('engine importCatalog arm (no rehydrateCatalog)', () => {
		/** Replays the persisted catalog through importCatalog by hand: phase-1 the
		 *  table bundles, then the MV entry with the given options. */
		async function manualImport(options?: { trustBackings?: boolean; adoptedBackings?: Set<string> }): Promise<Database> {
			const { db, mod } = open();
			const ddls = await mod.loadAllDDL();
			// The meta marker is filtered out of loadAllDDL — only DDL remains.
			expect(ddls.every(d => /^create/i.test(d)), 'loadAllDDL returns only DDL').to.equal(true);
			// A maintained table persists as the canonical `create table … maintained as`
			// form (the unified model), so the MV arm matches that clause as well as the
			// `create materialized view` sugar; the real rehydrateCatalog classifies by
			// catalog key prefix (loadAllDDL discards the keys this hand-replay lacks).
			const isMv = (d: string): boolean => /^create materialized view/i.test(d) || /\bmaintained\s+as\b/i.test(d);
			const isView = (d: string): boolean => /^create view/i.test(d);
			await db.schemaManager.importCatalog(ddls.filter(d => !isMv(d) && !isView(d)));
			await db.schemaManager.importCatalog(ddls.filter(isView));
			await db.schemaManager.importCatalog(ddls.filter(isMv), options);
			return db;
		}

		it('without options, a pre-existing backing refills even when every other gate passes', async () => {
			await seedSession();
			expect(await markerPresent(), 'marker present but irrelevant to the engine').to.equal(true);
			await plantSentinel('main.mv', [99, 990]);

			const db = await manualImport(/* no options */);
			expect(await rows(db, 'select id, v from mv order by id'), 'default is the always-correct refill')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		});

		it('with trustBackings, the engine adopts (gate check without the store wrapper)', async () => {
			await seedSession();
			await plantSentinel('main.mv', [99, 990]);

			const db = await manualImport({ trustBackings: true, adoptedBackings: new Set() });
			expect(await rows(db, 'select id from mv where id = 99')).to.deep.equal([{ id: 99 }]);
		});

		it('trustBackings does not bypass the other-module CONSTRAINT arm', async () => {
			const { db } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			// A MEMORY table squatting on the MV's own name: not ours to adopt OR
			// drop, trust notwithstanding.
			await db.exec('create table mv (id integer primary key, v integer)');
			let message = '';
			try {
				await db.schemaManager.importCatalog(
					['create materialized view main.mv using store as select id, v from src'],
					{ trustBackings: true, adoptedBackings: new Set() },
				);
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).to.match(/already exists in module 'memory', not the MV's backing module 'store'/i);
			expect(db.schemaManager.getTable('main', 'mv')!.vtabModuleName, 'squatter untouched').to.equal('memory');
		});
	});
});
