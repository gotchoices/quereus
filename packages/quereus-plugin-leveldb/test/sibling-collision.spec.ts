/**
 * Regression: store-name prefix collision between a table `t` and a sibling
 * table literally named `t_idx_<x>`.
 *
 * Index stores are named `{schema}/{table}_idx_{index}` on disk, so a sibling
 * table `t_idx_archive` has data directory `main/t_idx_archive`, which shares the
 * `main/t_idx_` prefix of table `t`'s index directories. The old prefix-scan
 * discovery (readdir + `startsWith('t_idx_')`) treated the sibling's directory as
 * an index of `t` and silently moved it (RENAME) or deleted it (DROP).
 *
 * `StoreModule` now hands the provider the authoritative index-name list from the
 * schema, so only `t`'s real index directories are touched. These tests wire a
 * real `Database` + `StoreModule` over a `LevelDBProvider` rooted at a temp dir
 * and assert both the on-disk directories and the engine-visible rows.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';
import { createLevelDBProvider, type LevelDBProvider } from '../src/provider.js';

describe('LevelDB sibling-table prefix collision', () => {
	let testDir: string;
	let db: Database;
	let provider: LevelDBProvider;
	let mod: StoreModule;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `quereus-sibling-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(testDir, { recursive: true });
		db = new Database();
		provider = createLevelDBProvider({ basePath: testDir });
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
	});

	afterEach(async () => {
		try {
			await mod.closeAll();
		} catch {
			/* may already be closed */
		}
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	async function rows(sql: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(sql)) as Record<string, SqlValue>[];
	}

	const dataDir = (table: string) => path.join(testDir, 'main', table);
	const indexDir = (table: string, index: string) => path.join(testDir, 'main', `${table}_idx_${index}`);

	/** Sorted list of directory entries under `main/` — for stray-dir assertions. */
	const mainDirs = (): string[] => {
		const root = path.join(testDir, 'main');
		return fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
	};

	async function attempt(sql: string): Promise<Error | null> {
		try {
			await db.exec(sql);
			return null;
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
	}

	it('RENAME t leaves a sibling table t_idx_archive intact on disk and in the engine', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`insert into "t_idx_archive" values (1, 100), (2, 200)`);

		// Pre-condition: sibling data dir + t's real index dir both materialized.
		expect(fs.existsSync(dataDir('t_idx_archive')), 'sibling data dir exists').to.be.true;
		expect(fs.existsSync(indexDir('t', 'ix_b')), 't real index dir exists').to.be.true;

		await db.exec(`alter table t rename to t2`);

		// Sibling untouched: its directory keeps its name (NOT moved to
		// main/t2_idx_archive) and its rows remain reachable.
		expect(fs.existsSync(dataDir('t_idx_archive')), 'sibling dir kept its name').to.be.true;
		expect(fs.existsSync(indexDir('t2', 'archive')), 'sibling NOT mis-moved under t2').to.be.false;
		expect(await rows(`select v from "t_idx_archive" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);

		// t's REAL index relocated under the new name; t2 is fully usable.
		expect(fs.existsSync(indexDir('t', 'ix_b')), 'old real index dir gone').to.be.false;
		expect(fs.existsSync(indexDir('t2', 'ix_b')), 'real index dir relocated').to.be.true;
		expect(await rows(`select id from t2 where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('DROP t leaves a sibling table t_idx_archive intact on disk and in the engine', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		await db.exec(`insert into "t_idx_archive" values (1, 100), (2, 200)`);

		expect(fs.existsSync(dataDir('t_idx_archive'))).to.be.true;
		expect(fs.existsSync(indexDir('t', 'ix_b'))).to.be.true;

		await db.exec(`drop table t`);

		// t and its real index dir are gone; the sibling's dir and rows survive.
		expect(fs.existsSync(dataDir('t')), 't data dir gone').to.be.false;
		expect(fs.existsSync(indexDir('t', 'ix_b')), 't real index dir gone').to.be.false;
		expect(fs.existsSync(dataDir('t_idx_archive')), 'sibling dir intact').to.be.true;
		expect(await rows(`select v from "t_idx_archive" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);
	});

	// ── CREATE-time collision rejection (persistent companion) ──────────────────

	it('rejects CREATE INDEX colliding with a sibling table data store; sibling rows + dirs intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`insert into "t_idx_archive" values (1, 100), (2, 200)`);

		expect(fs.existsSync(dataDir('t_idx_archive')), 'sibling data dir exists').to.be.true;
		const before = mainDirs();

		// index `archive` on t → main/t_idx_archive == sibling table's data dir.
		const err = await attempt(`create index archive on t (b)`);
		expect(err, 'colliding CREATE INDEX must reject').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/main\.t_idx_archive/);

		// No-op reject: directory set is unchanged and the sibling's rows are intact
		// (the index build never wrote into the sibling's data store).
		expect(mainDirs(), 'rejected op created no stray directory').to.deep.equal(before);
		expect(await rows(`select v from "t_idx_archive" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);

		// Connection still usable afterward.
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`create index ix_b on t (b)`);
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('rejects CREATE TABLE colliding with an existing index store; index dir + rows intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index archive on t (b)`); // index dir main/t_idx_archive
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		expect(fs.existsSync(indexDir('t', 'archive')), 't index dir exists').to.be.true;
		const before = mainDirs();

		// New table `t_idx_archive` data dir → main/t_idx_archive == t's index dir.
		const err = await attempt(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		expect(err, 'colliding CREATE TABLE must reject').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/main\.t_idx_archive/);

		// No stray dir, and t's index-backed lookup still returns the row (index store
		// was never overwritten by the rejected table's data store).
		expect(mainDirs(), 'rejected op created no stray directory').to.deep.equal(before);
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(`select id from t order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it('rejects RENAME relocating an index onto a sibling table data store; no directory moved', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index x on t (b)`); // index dir main/t_idx_x
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`create table "u_idx_x" (id integer primary key, v integer) using store`);
		await db.exec(`insert into "u_idx_x" values (1, 100), (2, 200)`);

		expect(fs.existsSync(indexDir('t', 'x')), 't real index dir exists').to.be.true;
		expect(fs.existsSync(dataDir('u_idx_x')), 'sibling data dir exists').to.be.true;
		const before = mainDirs();

		// Rename t → u: the new data dir main/u is free, but relocating t's index x
		// would land on main/u_idx_x — the sibling table's data dir.
		const err = await attempt(`alter table t rename to u`);
		expect(err, 'rename relocating an index onto a sibling data store must reject').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/main\.u_idx_x/);

		// Atomic reject: NO directory moved — the StoreModule guard fires before the
		// provider relocation, and the provider's own all-destinations pre-scan is
		// the backstop (no half-renamed table even when called directly).
		expect(mainDirs(), 'directory set unchanged on reject').to.deep.equal(before);

		// Both tables remain fully usable without recovery.
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(`select v from "u_idx_x" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);
	});
});
