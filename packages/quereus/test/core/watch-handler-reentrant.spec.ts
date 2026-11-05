/**
 * A `Database.watch` handler may await a statement on the database that fired it.
 * The commit runs the handler's synchronous part but does not wait for its promise;
 * the statement that committed waits after releasing the execution mutex.
 * See docs/change-scope.md § Handler ordering.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { ChangeScope } from '../../src/index.js';
import type { StatementOptions } from '../../src/common/types.js';

function fullWatch(table: string): ChangeScope {
	return {
		watches: [{ table: { schema: 'main', table }, columns: 'all', scope: { kind: 'full' } }],
		nonDeterministicSources: [],
		unboundParameters: [],
	};
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('Database.watch handlers that await statements', () => {
	let db: Database;

	async function countRows(table: string, options?: StatementOptions): Promise<number> {
		let rows = 0;
		for await (const _ of db.eval(`select id from ${table}`, undefined, options)) rows++;
		return rows;
	}

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v text) using memory');
		await db.exec('create table u (id integer primary key) using memory');
	});

	afterEach(async () => {
		await db.close();
	});

	const insertIntoT = "insert into t values (1, 'a')";
	const writers: Array<[string, () => Promise<void>]> = [
		['db.exec', () => db.exec(insertIntoT)],
		['stmt.run', async () => {
			const stmt = db.prepare(insertIntoT);
			await stmt.run();
			await stmt.finalize();
		}],
		['db.eval', async () => {
			for await (const _ of db.eval(insertIntoT)) { /* drain */ }
		}],
		['an explicit commit', async () => {
			await db.exec('begin');
			await db.exec(insertIntoT);
			await db.exec('commit');
		}],
	];

	for (const [name, write] of writers) {
		it(`a handler awaiting a query sees the committed row when fired by ${name}`, async () => {
			const seen: number[] = [];
			db.watch(fullWatch('t'), async () => { seen.push(await countRows('t')); });
			await write();
			expect(seen).to.deep.equal([1]);
		});
	}

	it('a committed read awaited by a handler settles after an explicit commit', async () => {
		const seen: number[] = [];
		db.watch(fullWatch('t'), async () => { seen.push(await countRows('t', { readConcurrency: 'committed' })); });
		await db.exec('begin');
		await db.exec(insertIntoT);
		await db.exec('commit');
		expect(seen).to.deep.equal([1]);
	});

	it('a handler awaiting a query settles when fired by an external row ingest', async () => {
		const seen: number[] = [];
		db.watch(fullWatch('t'), async () => { seen.push(await countRows('t')); });
		await db.ingestExternalRowChanges([{ tableName: 't', change: { op: 'insert', newRow: [1, 'a'] } }]);
		expect(seen).to.have.length(1);
	});

	it('a handler awaiting a write settles through the async watcher on that table', async () => {
		const order: string[] = [];
		db.watch(fullWatch('u'), async () => {
			await delay(0);
			order.push('u handler');
		});
		db.watch(fullWatch('t'), async () => {
			await db.exec('insert into u values (1)');
			order.push('t handler');
		});
		await db.exec(insertIntoT);
		order.push('writer');
		expect(order).to.deep.equal(['u handler', 't handler', 'writer']);
	});

	it('handlers run up to their first await before a statement queued behind the writer', async () => {
		const order: string[] = [];
		db.watch(fullWatch('t'), () => { order.push('sync handler'); });
		db.watch(fullWatch('t'), async () => {
			order.push('async handler start');
			await delay(0);
		});
		const writer = db.exec(insertIntoT);
		const queued = countRows('t').then(() => { order.push('queued read'); });
		await Promise.all([writer, queued]);
		expect(order).to.deep.equal(['sync handler', 'async handler start', 'queued read']);
	});

	it('later statements run while an async handler is pending, and its writer waits for it', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let handlerFinished = false;
		db.watch(fullWatch('t'), async () => {
			await gate;
			handlerFinished = true;
		});

		let writerResolved = false;
		const writer = db.exec(insertIntoT).then(() => { writerResolved = true; });

		expect(await countRows('t')).to.equal(1);
		expect(writerResolved).to.equal(false);

		release();
		await writer;
		expect(handlerFinished).to.equal(true);
	});

	it('a writer waits for the handlers of every commit it made while holding the mutex', async () => {
		let calls = 0;
		const finished: number[] = [];
		db.watch(fullWatch('t'), async () => {
			const call = ++calls;
			await delay(call === 1 ? 10 : 0);
			finished.push(call);
		});
		await db.exec("insert into t values (1, 'a'); insert into t values (2, 'b')");
		expect(finished).to.have.members([1, 2]);
	});

	it('a rejecting async handler does not fail its writer', async () => {
		db.watch(fullWatch('t'), async () => {
			await delay(0);
			throw new Error('handler failed');
		});
		await db.exec(insertIntoT);
		expect(await countRows('t')).to.equal(1);
	});

	it('a handler writing during an external notification leaves later handlers their txnId', async () => {
		const txnIds: string[] = [];
		db.watch(fullWatch('t'), async () => { await db.exec('insert into u values (1)'); });
		db.watch(fullWatch('t'), event => { txnIds.push(event.txnId); });
		await db.notifyExternalChange('t');
		expect(txnIds).to.have.length(1);
		expect(txnIds[0]).to.match(/^txn:\d+$/);
	});
});
