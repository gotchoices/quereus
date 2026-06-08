/**
 * ALTER-conformance matrix — store leg of the "no silent divergence" contract.
 *
 * Companion to `packages/quereus/test/alter-table-conformance.spec.ts` (memory +
 * no-`alterTable` stub) and `packages/quereus-isolation/test/...` (isolation-
 * wrapped memory). The matrix is split across three packages because
 * `@quereus/quereus` cannot depend on `@quereus/store` / `@quereus/isolation`
 * (they depend on it), and because the quereus leg must import the engine from
 * source while a store/isolation leg imports the built `@quereus/quereus` — so a
 * single shared harness module cannot cleanly serve all three. The harness shape
 * is therefore duplicated, deliberately, per package.
 *
 * Contract (docs/module-authoring.md § "Schema Changes"): each (store × arm) cell
 * must resolve to exactly one of — **honored** (the ALTER applies and a post-ALTER
 * read-back proves it is in force) or **clean reject** (`QuereusError` with the
 * arm's declared code + a sited message). The forbidden third outcome — "succeeds
 * but nothing changed" — is what caught the store PK-collation gap; the honored
 * arms' read-back probes guard against it here.
 *
 * Store backing: the in-memory KV provider from `alter-table.spec.ts`, so this
 * stays in the fast `yarn test` lane (no LevelDB).
 *
 * NOTE on the ADD CHECK cell: the audit matrix marked the store cell as a clean
 * `UNSUPPORTED` reject. That is NOT how the engine behaves today — `ALTER TABLE
 * ADD CONSTRAINT … CHECK` is handled entirely engine-side (runtime/emit/
 * add-constraint.ts `runAddCheck`) and never reaches `module.alterTable`, so it is
 * honored in-session for the store exactly as for memory. The store's own
 * `addConstraint` UNSUPPORTED branch is reachable only by a constraint type that
 * routes to the module and that it does not handle (today: none beyond UNIQUE/FK).
 * Asserted as honored below; the discrepancy is flagged in the review handoff.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, QuereusError, StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

// ── In-memory KV provider (mirrors alter-table.spec.ts) ──────────────────────

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
		async renameTableStores(schemaName, oldName, newName, indexNames) {
			const move = (from: string, to: string) => {
				const s = stores.get(from);
				if (s) { stores.delete(from); stores.set(to, s); }
			};
			move(`${schemaName}.${oldName}`, `${schemaName}.${newName}`);
			for (const indexName of indexNames) {
				move(`${schemaName}.${oldName}_idx_${indexName}`, `${schemaName}.${newName}_idx_${indexName}`);
			}
		},
	};
}

// ── Outcome contract ────────────────────────────────────────────────────────

type Expectation =
	| { kind: 'honored' }
	| { kind: 'reject'; codes: StatusCode[]; site?: RegExp };

interface Arm {
	label: string;
	seed: string[];
	alter: string;
	expect: Expectation;
	confirm: (db: Database, outcome: 'honored' | 'rejected') => Promise<void>;
}

// ── Read-back helpers ─────────────────────────────────────────────────────────

async function rows(db: Database, sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql, params)) out.push(r);
	return out;
}

async function columnNames(db: Database, table = 't'): Promise<string[]> {
	return (await rows(db, `select name from table_info('${table}') order by cid`)).map(r => String(r.name));
}

async function columnInfo(db: Database, column: string, table = 't'): Promise<Record<string, SqlValue> | undefined> {
	const all = await rows(db, `select name, type, notnull, pk, collation, dflt_value from table_info('${table}')`);
	return all.find(r => String(r.name).toLowerCase() === column.toLowerCase());
}

async function pkColumns(db: Database, table = 't'): Promise<string[]> {
	return (await rows(db, `select name from table_info('${table}') where pk > 0 order by pk`)).map(r => String(r.name));
}

async function attemptAlter(db: Database, sql: string): Promise<QuereusError | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		if (e instanceof QuereusError) return e;
		throw e; // a crash is not a clean reject
	}
}

async function expectConstraint(db: Database, sql: string, label: string): Promise<void> {
	const err = await attemptAlter(db, sql);
	expect(err, `${label}: expected forward enforcement to reject "${sql}"`).to.be.instanceOf(QuereusError);
	expect(err!.code, `${label}: enforcement code`).to.equal(StatusCode.CONSTRAINT);
}

// ── The matrix (store column of the audit inventory) ─────────────────────────

const ARMS: Arm[] = [
	{
		label: 'addColumn (nullable)',
		seed: [`create table t (id integer primary key, name text) using store`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t add column note text null`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const names = await columnNames(db);
			if (outcome === 'honored') {
				expect(names).to.include('note');
				expect((await rows(db, `select note from t where id = 1`))[0].note, 'existing row backfilled NULL').to.equal(null);
			} else expect(names).to.not.include('note');
		},
	},
	{
		label: 'addColumn (with literal DEFAULT)',
		seed: [`create table t (id integer primary key, name text) using store`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t add column qty integer default 7`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				expect((await rows(db, `select qty from t order by id`)).map(x => x.qty), 'rows backfilled with DEFAULT').to.deep.equal([7, 7]);
			} else expect(await columnNames(db)).to.not.include('qty');
		},
	},
	{
		label: 'addColumn NOT NULL, no DEFAULT, non-empty → CONSTRAINT',
		seed: [`create table t (id integer primary key, name text) using store`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t add column req text not null`,
		expect: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /\breq\b|not null/i },
		confirm: async (db) => { expect(await columnNames(db), 'column absent after reject').to.not.include('req'); },
	},
	{
		label: 'dropColumn',
		seed: [`create table t (id integer primary key, name text, extra text) using store`, `insert into t values (1, 'a', 'x'), (2, 'b', 'y')`],
		alter: `alter table t drop column extra`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const names = await columnNames(db);
			if (outcome === 'honored') expect(names).to.not.include('extra');
			else expect(names).to.include('extra');
		},
	},
	{
		label: 'renameColumn',
		seed: [`create table t (id integer primary key, name text) using store`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t rename column name to title`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const names = await columnNames(db);
			if (outcome === 'honored') {
				expect(names).to.include('title');
				expect(names).to.not.include('name');
				expect((await rows(db, `select title from t where id = 1`))[0].title, 'data preserved').to.equal('a');
			} else expect(names).to.include('name');
		},
	},
	{
		label: 'alterPrimaryKey (store: in place)',
		seed: [`create table t (id integer primary key, code integer not null) using store`, `insert into t values (1, 100), (2, 200)`],
		alter: `alter table t alter primary key (code)`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				expect(await pkColumns(db), 'PK re-keyed to code').to.deep.equal(['code']);
				expect((await rows(db, `select id from t where code = 100`))[0]?.id, 'point lookup under new PK').to.equal(1);
			} else expect(await pkColumns(db)).to.deep.equal(['id']);
		},
	},
	{
		label: 'addConstraint UNIQUE',
		seed: [`create table t (id integer primary key, email text) using store`, `insert into t values (1, 'a@x'), (2, 'b@x')`],
		alter: `alter table t add constraint u_email unique (email)`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') await expectConstraint(db, `insert into t values (3, 'a@x')`, 'UNIQUE');
			else await db.exec(`insert into t values (3, 'a@x')`);
		},
	},
	{
		label: 'addConstraint FOREIGN KEY',
		seed: [
			`pragma foreign_keys = true`,
			`create table parent (pid integer primary key) using store`,
			`insert into parent values (1), (2)`,
			`create table t (id integer primary key, pa integer) using store`,
			`insert into t values (1, 1), (2, 2)`,
		],
		alter: `alter table t add constraint fk_pa foreign key (pa) references parent(pid)`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') await expectConstraint(db, `insert into t values (3, 99)`, 'FK');
			else await db.exec(`insert into t values (3, 99)`);
		},
	},
	{
		// Engine-side (runAddCheck); honored for store in-session exactly as for memory.
		// See the file header note re: the audit-matrix discrepancy.
		label: 'addConstraint CHECK (engine-side)',
		seed: [`create table t (id integer primary key, v integer) using store`, `insert into t values (1, 5), (2, 9)`],
		alter: `alter table t add constraint pos check (v > 0)`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') await expectConstraint(db, `insert into t values (3, -1)`, 'CHECK');
			else await db.exec(`insert into t values (3, -1)`);
		},
	},
	{
		label: 'dropConstraint',
		seed: [`create table t (id integer primary key, email text, constraint u_email unique (email)) using store`, `insert into t values (1, 'a@x'), (2, 'b@x')`],
		alter: `alter table t drop constraint u_email`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				await db.exec(`insert into t values (3, 'a@x')`);
				expect((await rows(db, `select count(*) as c from t where email = 'a@x'`))[0].c, 'UNIQUE no longer enforced').to.equal(2);
			} else await expectConstraint(db, `insert into t values (3, 'a@x')`, 'dropConstraint-unchanged');
		},
	},
	{
		label: 'renameConstraint',
		seed: [`create table t (id integer primary key, email text, constraint u_email unique (email)) using store`, `insert into t values (1, 'a@x'), (2, 'b@x')`],
		alter: `alter table t rename constraint u_email to u2`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const names = (await rows(db, `select name from unique_constraint_info('t')`)).map(r => String(r.name));
			if (outcome === 'honored') {
				expect(names).to.include('u2');
				expect(names).to.not.include('u_email');
			} else expect(names).to.include('u_email');
		},
	},
	{
		label: 'alterColumn SET NOT NULL (data conforms)',
		seed: [`create table t (id integer primary key, v integer null) using store`, `insert into t values (1, 5), (2, 9)`],
		alter: `alter table t alter column v set not null`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'v');
			if (outcome === 'honored') {
				expect(info?.notnull, 'tightened to NOT NULL').to.equal(1);
				await expectConstraint(db, `insert into t values (3, null)`, 'SET NOT NULL');
			} else expect(info?.notnull).to.equal(0);
		},
	},
	{
		label: 'alterColumn SET NOT NULL (existing NULL) → CONSTRAINT',
		seed: [`create table t (id integer primary key, v integer null) using store`, `insert into t values (1, null), (2, 9)`],
		alter: `alter table t alter column v set not null`,
		expect: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /\bv\b|not null/i },
		confirm: async (db) => { expect((await columnInfo(db, 'v'))?.notnull, 'unchanged after reject').to.equal(0); },
	},
	{
		label: 'alterColumn DROP NOT NULL',
		seed: [`create table t (id integer primary key, v integer not null) using store`, `insert into t values (1, 5)`],
		alter: `alter table t alter column v drop not null`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'v');
			if (outcome === 'honored') {
				expect(info?.notnull, 'relaxed to nullable').to.equal(0);
				await db.exec(`insert into t values (3, null)`);
			} else expect(info?.notnull).to.equal(1);
		},
	},
	{
		label: 'alterColumn SET DATA TYPE (lossy) → MISMATCH',
		seed: [`create table t (id integer primary key, v text) using store`, `insert into t values (1, 'abc'), (2, 'xyz')`],
		alter: `alter table t alter column v set data type integer`,
		expect: { kind: 'reject', codes: [StatusCode.MISMATCH], site: /\bv\b|convert/i },
		confirm: async (db) => {
			expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'type unchanged after lossy reject').to.contain('text');
		},
	},
	{
		label: 'alterColumn SET DEFAULT',
		seed: [`create table t (id integer primary key, v integer null) using store`, `insert into t values (1, 5)`],
		alter: `alter table t alter column v set default 99`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				await db.exec(`insert into t (id) values (2)`);
				expect((await rows(db, `select v from t where id = 2`))[0].v, 'new insert uses SET DEFAULT').to.equal(99);
			}
		},
	},
	{
		label: 'alterColumn SET COLLATE (non-PK UNIQUE, no collision) revalidates',
		seed: [`create table t (id integer primary key, name text, constraint u_name unique (name)) using store`, `insert into t values (1, 'abc'), (2, 'xyz')`],
		alter: `alter table t alter column name set collate nocase`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'name');
			if (outcome === 'honored') {
				expect(String(info?.collation).toUpperCase(), 'collation now NOCASE').to.equal('NOCASE');
				await expectConstraint(db, `insert into t values (3, 'ABC')`, 'SET COLLATE revalidate');
			} else expect(String(info?.collation).toUpperCase()).to.not.equal('NOCASE');
		},
	},
	{
		// PK column, CONSISTENT change: target NOCASE == the store's fixed physical key
		// collation K (default NOCASE). The store applies it schema-only — forward PK
		// uniqueness is already physically correct under NOCASE. 'abc'/'ABD' are distinct
		// under NOCASE keys, so both coexist and order under NOCASE.
		label: 'alterColumn SET COLLATE on PK column (consistent: target == fixed key collation) → honored schema-only',
		seed: [`create table t (name text primary key) using store`, `insert into t values ('abc'), ('ABD')`],
		alter: `alter table t alter column name set collate nocase`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'name');
			if (outcome === 'honored') {
				expect(String(info?.collation).toUpperCase(), 'collation now NOCASE (matches fixed key collation)').to.equal('NOCASE');
				const ordered = (await rows(db, `select name from t order by name`)).map(r => String(r.name).toLowerCase());
				expect(ordered, 'PK rows ordered under NOCASE').to.deep.equal(['abc', 'abd']);
			} else expect(String(info?.collation).toUpperCase()).to.not.equal('NOCASE');
		},
	},
	{
		// PK column, DIVERGENT change: target BINARY != K (NOCASE). The store enforces the
		// PK physically under K and cannot honor a divergent per-column PK collation without
		// a physical re-key, so it throws a sited UNSUPPORTED — the negotiated rejection that
		// closes the former silent-divergence gap. Reach it by declaring the column NOCASE
		// first (so BINARY is a real change, not the BINARY→NOCASE consistent case).
		label: 'alterColumn SET COLLATE on PK column (divergent from fixed key collation) → UNSUPPORTED',
		seed: [`create table t (name text collate nocase primary key) using store`, `insert into t values ('abc'), ('xyz')`],
		alter: `alter table t alter column name set collate binary`,
		expect: { kind: 'reject', codes: [StatusCode.UNSUPPORTED], site: /name|primary key|collat/i },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'name');
			if (outcome === 'rejected') {
				expect(String(info?.collation).toUpperCase(), 'collation unchanged after reject').to.equal('NOCASE');
				// the table is still writable after the failed ALTER
				await db.exec(`insert into t values ('def')`);
				expect((await rows(db, `select count(*) as n from t`))[0].n, 'insert succeeded post-reject').to.equal(3);
			} else expect(String(info?.collation).toUpperCase(), 'unexpected honor of a divergent PK collation').to.equal('NOCASE');
		},
	},
	{
		// PK column, DIVERGENT to a THIRD collation (RTRIM): K is always BINARY/NOCASE
		// (config.collation's type), so an RTRIM (or any non-K) target on a PK column can
		// never equal K and must reject. Guards the general `normalized !== K` branch with a
		// collation outside the {target, K} = {BINARY, NOCASE} pair the other arms exercise.
		label: 'alterColumn SET COLLATE rtrim on PK column (third collation, divergent from K) → UNSUPPORTED',
		seed: [`create table t (name text collate nocase primary key) using store`, `insert into t values ('abc')`],
		alter: `alter table t alter column name set collate rtrim`,
		expect: { kind: 'reject', codes: [StatusCode.UNSUPPORTED], site: /name|primary key|collat/i },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'name');
			expect(String(info?.collation).toUpperCase(), 'collation unchanged after reject').to.equal('NOCASE');
			if (outcome === 'rejected') {
				await db.exec(`insert into t values ('def')`);
				expect((await rows(db, `select count(*) as n from t`))[0].n, 'insert succeeded post-reject').to.equal(2);
			}
		},
	},
	{
		// COMPOSITE PK, single-member divergent change: altering one PK member to a divergent
		// collation must reject — the guard's membership test (`primaryKeyDefinition.some(...)`)
		// fires for any PK column, not just a single-column PK. `a` is a PK member declared
		// NOCASE (== K), so SET COLLATE binary diverges and rejects; `b` is unaffected.
		label: 'alterColumn SET COLLATE on a composite-PK member (divergent) → UNSUPPORTED',
		seed: [`create table t (a text collate nocase, b integer, primary key (a, b)) using store`, `insert into t values ('abc', 1)`],
		alter: `alter table t alter column a set collate binary`,
		expect: { kind: 'reject', codes: [StatusCode.UNSUPPORTED], site: /\ba\b|primary key|collat/i },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'a');
			expect(String(info?.collation).toUpperCase(), 'collation unchanged after reject').to.equal('NOCASE');
			if (outcome === 'rejected') {
				// the table is still writable after the failed ALTER
				await db.exec(`insert into t values ('abc', 2)`);
				expect((await rows(db, `select count(*) as n from t`))[0].n, 'insert succeeded post-reject').to.equal(2);
			}
		},
	},
];

// ── Driver ────────────────────────────────────────────────────────────────────

async function runArm(db: Database, arm: Arm): Promise<void> {
	for (const stmt of arm.seed) await db.exec(stmt);
	const err = await attemptAlter(db, arm.alter);

	if (arm.expect.kind === 'honored') {
		expect(err, `${arm.label}: expected honored, but ALTER threw: ${err?.message}`).to.equal(null);
		await arm.confirm(db, 'honored');
		return;
	}

	expect(
		err,
		`${arm.label}: expected a clean reject, but the ALTER succeeded — "succeeds without taking effect" is the silent-divergence signature this matrix forbids`,
	).to.be.instanceOf(QuereusError);
	expect(arm.expect.codes, `${arm.label}: reject code was ${err!.code} (${err!.message})`).to.include(err!.code);
	expect(err!.message.trim().length, `${arm.label}: reject must carry a sited message`).to.be.greaterThan(0);
	if (arm.expect.site) expect(err!.message, `${arm.label}: reject message should be sited`).to.match(arm.expect.site);
	await arm.confirm(db, 'rejected');
}

describe('ALTER conformance matrix — store module', () => {
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

	for (const arm of ARMS) {
		it(arm.label, async () => {
			await runArm(db, arm);
		});
	}

	// The former DEFERRED cell — ALTER COLUMN SET COLLATE on a PRIMARY KEY column —
	// is now resolved by `store-pk-collate-module-capability` and lives as two live
	// ARMS above: the CONSISTENT case (target == the store's fixed key collation) is
	// honored schema-only, and the DIVERGENT case throws a sited UNSUPPORTED. The
	// store enforces PK uniqueness physically under its fixed table key collation, so
	// it never silently diverges on a per-column PK collation change.
});
