/**
 * CREATE-conformance — store leg of the "no silent divergence" contract for the
 * primary-key collation reconciliation performed at table-creation time.
 *
 * Companion to `alter-table-conformance.spec.ts`. The store enforces PRIMARY KEY
 * uniqueness PHYSICALLY under a single fixed table-level key collation K
 * (`StoreTable.encodeOptions`, = `config.collation || 'NOCASE'`), not the
 * per-column declared collation. Without reconciliation a text PK column declared
 * with a collation that diverges from K would report one collation via
 * `table_info()` (e.g. the BINARY default) while its key bytes — uniqueness,
 * point-lookup, ordering — are governed by K (NOCASE): a silent declared≠enforced
 * split. `StoreModule.create` closes that gap by:
 *   - normalizing an IMPLICIT-default divergent text PK column up to K, and
 *   - rejecting an EXPLICITLY-declared divergent text PK collation with a sited
 *     `UNSUPPORTED` (the faithful mirror of the ALTER SET COLLATE guard).
 *
 * Store backing: the in-memory KV provider (same as `alter-table.spec.ts`), so this
 * stays in the fast `yarn test` lane (no LevelDB).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, QuereusError, StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

// ── In-memory KV provider (mirrors alter-table-conformance.spec.ts) ───────────

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(schemaName, tableName) { return get(`${schemaName}.${tableName}`); },
		async getIndexStore(schemaName, tableName, indexName) { return get(`${schemaName}.${tableName}_idx_${indexName}`); },
		async getStatsStore(schemaName, tableName) { return get(`${schemaName}.${tableName}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() { /* no-op */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

// ── Read-back helpers ─────────────────────────────────────────────────────────

async function rows(db: Database, sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql, params)) out.push(r);
	return out;
}

async function collationOf(db: Database, column: string, table = 't'): Promise<string | undefined> {
	const all = await rows(db, `select name, collation from table_info('${table}')`);
	const info = all.find(r => String(r.name).toLowerCase() === column.toLowerCase());
	return info ? String(info.collation).toUpperCase() : undefined;
}

async function tableExists(db: Database, table = 't'): Promise<boolean> {
	// `table_info` throws (not returns empty) when the table is absent, so a thrown
	// "not found" is the negative answer; any other error propagates.
	try {
		return (await rows(db, `select name from table_info('${table}')`)).length > 0;
	} catch (e) {
		if (e instanceof QuereusError && /not found|no such table/i.test(e.message)) return false;
		throw e;
	}
}

async function attempt(db: Database, sql: string): Promise<QuereusError | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		if (e instanceof QuereusError) return e;
		throw e; // a crash is not a clean reject
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CREATE conformance — store PK collation reconciliation', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('implicit-default text PK reports the fixed key collation K (NOCASE), not BINARY', async () => {
		await db.exec(`create table t (x text primary key) using store`);
		expect(await collationOf(db, 'x'), 'declared collation == enforced K').to.equal('NOCASE');

		// Enforcement under K: 'a' and 'A' collide on a NOCASE key. With declaration
		// now == enforcement this is no longer a silent divergence.
		await db.exec(`insert into t values ('a')`);
		const err = await attempt(db, `insert into t values ('A')`);
		expect(err, `expected a NOCASE PK collision`).to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);
	});

	it('explicit collate NOCASE on a text PK (== K) is honored', async () => {
		await db.exec(`create table t (x text collate nocase primary key) using store`);
		expect(await collationOf(db, 'x')).to.equal('NOCASE');
		expect(await tableExists(db)).to.equal(true);
	});

	it('explicit collate BINARY on a text PK (≠ K) is rejected with a sited UNSUPPORTED', async () => {
		const err = await attempt(db, `create table t (x text collate binary primary key) using store`);
		expect(err, 'expected a clean reject, not a silent declared≠enforced create').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.UNSUPPORTED);
		expect(err!.message, 'reject message should be sited').to.match(/\bx\b|primary key|collat/i);
		expect(await tableExists(db), 'table must not be created on reject').to.equal(false);

		// The provider/connection is still usable: a consistent create succeeds afterward.
		await db.exec(`create table t (x text primary key) using store`);
		expect(await collationOf(db, 'x')).to.equal('NOCASE');
	});

	it('explicit collate RTRIM on a text PK (third collation, ≠ K) is rejected', async () => {
		const err = await attempt(db, `create table t (x text collate rtrim primary key) using store`);
		expect(err).to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.UNSUPPORTED);
		expect(await tableExists(db)).to.equal(false);
	});

	it('composite PK: explicit-divergent text member is rejected', async () => {
		const err = await attempt(
			db,
			`create table t (a text collate binary, b integer, primary key (a, b)) using store`,
		);
		expect(err).to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.UNSUPPORTED);
		expect(err!.message).to.match(/\ba\b|primary key|collat/i);
		expect(await tableExists(db)).to.equal(false);
	});

	it('composite PK: implicit text member is normalized to K; integer member unaffected', async () => {
		await db.exec(`create table t (a text, b integer, primary key (a, b)) using store`);
		expect(await collationOf(db, 'a'), 'text PK member normalized to K').to.equal('NOCASE');
		// `b` is an integer PK member: collation is not meaningful for it, so it keeps
		// the BINARY default — the negative guard against over-normalizing non-text PKs.
		expect(await collationOf(db, 'b')).to.equal('BINARY');
	});

	it('integer PK keeps declared BINARY (negative guard against over-normalizing non-text PKs)', async () => {
		await db.exec(`create table t (id integer primary key) using store`);
		expect(await collationOf(db, 'id')).to.equal('BINARY');
	});

	it('non-PK text column is untouched (keeps BINARY default)', async () => {
		await db.exec(`create table t (id integer primary key, name text) using store`);
		expect(await collationOf(db, 'name'), 'only PK columns are reconciled').to.equal('BINARY');
	});

	it('after a default text-PK create, SET COLLATE binary is now a genuine divergent change and rejects', async () => {
		// Post-fix the default text PK declares NOCASE (== K), so SET COLLATE binary is a
		// real divergent change caught by the existing ALTER guard — no perpetuated
		// divergence, no need for a `set collate nocase` "repair".
		await db.exec(`create table t (x text primary key) using store`);
		const err = await attempt(db, `alter table t alter column x set collate binary`);
		expect(err, 'divergent PK SET COLLATE should reject').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.UNSUPPORTED);
		expect(await collationOf(db, 'x'), 'collation unchanged after reject').to.equal('NOCASE');
	});

	// ── K-parameterization: reconciliation tracks `config.collation`, not a hardcoded
	// NOCASE. With K = BINARY the roles invert — the implicit BINARY default is now the
	// consistent case, and an explicit `collate nocase` PK is the divergent one. These
	// guard against the reconciler being silently pinned to the default K. ──────────

	it('K=BINARY: implicit-default text PK is consistent and stays BINARY (no spurious normalize)', async () => {
		await db.exec(`create table t (x text primary key) using store (collation = 'binary')`);
		expect(await collationOf(db, 'x'), 'declared BINARY == enforced K=BINARY').to.equal('BINARY');
		expect(await tableExists(db)).to.equal(true);
	});

	it('K=BINARY: explicit collate nocase on a text PK (≠ K) is rejected with a sited UNSUPPORTED', async () => {
		const err = await attempt(db, `create table t (x text collate nocase primary key) using store (collation = 'binary')`);
		expect(err, 'explicit divergence from K=BINARY must reject').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.UNSUPPORTED);
		expect(err!.message, 'reject message names K').to.match(/binary/i);
		expect(await tableExists(db)).to.equal(false);
	});

	it('K=BINARY: explicit collate binary on a text PK (== K) is honored', async () => {
		await db.exec(`create table t (x text collate binary primary key) using store (collation = 'binary')`);
		expect(await collationOf(db, 'x')).to.equal('BINARY');
		expect(await tableExists(db)).to.equal(true);
	});
});
