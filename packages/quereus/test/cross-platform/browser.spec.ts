/**
 * Browser environment smoke test — verifies that core engine operations work
 * without Node.js-specific globals.
 *
 * Approach: temporarily remove Node.js globals (process, Buffer, __dirname, etc.)
 * from globalThis, run core CRUD operations, then restore them. This simulates
 * a browser environment and catches accidental Node.js API usage in the hot path.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/index.js';

/** Node.js globals that do not exist in browser environments. */
const NODE_ONLY_GLOBALS = ['__dirname', '__filename'] as const;

/**
 * Stash and remove Node.js-specific globals so the engine runs in a
 * browser-like environment.  `process` is set to `undefined` so that
 * `typeof process` evaluates to `'undefined'`, matching browsers exactly.
 */
function stubNodeGlobals(): Map<string, unknown> {
	const saved = new Map<string, unknown>();

	for (const name of NODE_ONLY_GLOBALS) {
		if (name in globalThis) {
			saved.set(name, (globalThis as any)[name]);
			delete (globalThis as any)[name];
		}
	}

	// process → undefined (typeof process === 'undefined' in browsers)
	saved.set('process', globalThis.process);
	(globalThis as any).process = undefined;

	// Buffer → undefined (browsers use Uint8Array)
	if (typeof Buffer !== 'undefined') {
		saved.set('Buffer', (globalThis as any).Buffer);
		(globalThis as any).Buffer = undefined;
	}

	return saved;
}

function restoreNodeGlobals(saved: Map<string, unknown>): void {
	for (const [name, value] of saved) {
		(globalThis as any)[name] = value;
	}
}

async function collectRows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(row);
	}
	return rows;
}

describe('Browser Environment Smoke Test', () => {
	let db: Database;
	let saved: Map<string, unknown>;

	beforeEach(() => {
		saved = stubNodeGlobals();
		db = new Database();
	});

	afterEach(async () => {
		try {
			await db.close();
		} finally {
			restoreNodeGlobals(saved);
		}
	});

	it('should create a database instance', () => {
		void expect(db).to.be.instanceOf(Database);
	});

	it('should create a table and verify via schema()', async () => {
		await db.exec('create table t (id integer primary key, name text, value real)');

		const rows = await collectRows(db, "select name from schema() where type = 'table' and name = 't'");
		void expect(rows).to.have.length(1);
		void expect(rows[0].name).to.equal('t');
	});

	it('should insert and select rows', async () => {
		await db.exec('create table items (id integer primary key, label text)');
		await db.exec("insert into items values (1, 'alpha'), (2, 'beta'), (3, 'gamma')");

		const rows = await collectRows(db, 'select * from items order by id');
		void expect(rows).to.have.length(3);
		void expect(rows[0]).to.deep.include({ id: 1, label: 'alpha' });
		void expect(rows[2]).to.deep.include({ id: 3, label: 'gamma' });
	});

	it('should update rows', async () => {
		await db.exec('create table data (k text primary key, v integer)');
		await db.exec("insert into data values ('x', 10), ('y', 20)");
		await db.exec("update data set v = 99 where k = 'x'");

		const rows = await collectRows(db, "select v from data where k = 'x'");
		void expect(rows).to.have.length(1);
		void expect(rows[0].v).to.equal(99);
	});

	it('should delete rows', async () => {
		await db.exec('create table tmp (id integer primary key)');
		await db.exec('insert into tmp values (1), (2), (3)');
		await db.exec('delete from tmp where id = 2');

		const rows = await collectRows(db, 'select id from tmp order by id');
		void expect(rows).to.have.length(2);
		void expect(rows.map(r => r.id)).to.deep.equal([1, 3]);
	});

	it('should handle aggregation queries', async () => {
		await db.exec('create table nums (val integer)');
		await db.exec('insert into nums values (10), (20), (30)');

		const rows = await collectRows(db, 'select sum(val) as total, count(*) as cnt from nums');
		void expect(rows).to.have.length(1);
		void expect(rows[0].total).to.equal(60);
		void expect(rows[0].cnt).to.equal(3);
	});

	it('should handle joins', async () => {
		await db.exec('create table users (id integer primary key, name text)');
		await db.exec('create table orders (id integer primary key, user_id integer, item text)');
		await db.exec("insert into users values (1, 'Alice'), (2, 'Bob')");
		await db.exec(
			"insert into orders values (1, 1, 'Widget'), (2, 1, 'Gadget'), (3, 2, 'Gizmo')",
		);

		const rows = await collectRows(db,
			'select u.name, o.item from users u join orders o on u.id = o.user_id order by o.id',
		);
		void expect(rows).to.have.length(3);
		void expect(rows[0]).to.deep.include({ name: 'Alice', item: 'Widget' });
		void expect(rows[2]).to.deep.include({ name: 'Bob', item: 'Gizmo' });
	});

	it('should handle subqueries', async () => {
		await db.exec('create table scores (player text, points integer)');
		await db.exec(
			"insert into scores values ('a', 100), ('b', 200), ('a', 150), ('b', 300)",
		);

		const rows = await collectRows(db,
			'select player, total from (select player, sum(points) as total from scores group by player) sub order by total desc',
		);
		void expect(rows).to.have.length(2);
		void expect(rows[0]).to.deep.include({ player: 'b', total: 500 });
		void expect(rows[1]).to.deep.include({ player: 'a', total: 250 });
	});
});
