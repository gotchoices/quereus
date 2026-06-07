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
});
