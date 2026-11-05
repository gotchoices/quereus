import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Statement } from '../../src/core/statement.js';
import type { SqlValue } from '../../src/common/types.js';
import { CollectingInstructionTracer } from '../../src/runtime/types.js';
import type { VirtualTableConnection } from '../../src/vtab/connection.js';
import { installCommitStall, settleMacrotasks, type CommitStall } from '../../src/vtab/test-support/commit-stall.js';

/**
 * A statement finalizes its implicit transaction before it releases the execution
 * mutex, on every path, so no other statement can ever commit or roll back that
 * transaction. See docs/sql-txn.md § 8.6 and GitHub issue #38.
 */

const INSERT = 'insert into t values (1)';

class CountingConnection implements VirtualTableConnection {
	readonly connectionId: string;
	readonly tableName = 'counting';
	begins = 0;
	commits = 0;
	rollbacks = 0;
	private readonly commitError?: Error;

	constructor(connectionId: string, commitError?: Error) {
		this.connectionId = connectionId;
		this.commitError = commitError;
	}

	begin(): void { this.begins++; }
	commit(): void {
		this.commits++;
		if (this.commitError) throw this.commitError;
	}
	rollback(): void { this.rollbacks++; }
	createSavepoint(_depth: number): void { /* not asserted */ }
	releaseSavepoint(_depth: number): void { /* not asserted */ }
	rollbackToSavepoint(_depth: number): void { /* not asserted */ }
	disconnect(): void { /* no-op */ }

	resetCounts(): void {
		this.begins = this.commits = this.rollbacks = 0;
	}
}

async function collect(iter: AsyncIterable<Record<string, SqlValue>>): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
}

async function drainPrepared(db: Database, iterate: (stmt: Statement) => AsyncIterable<unknown>): Promise<void> {
	const stmt = db.prepare(INSERT);
	try {
		for await (const _row of iterate(stmt)) { /* drain */ }
	} finally {
		await stmt.finalize();
	}
}

async function rejectionOf(work: Promise<unknown>): Promise<Error> {
	try {
		await work;
	} catch (e) {
		return e as Error;
	}
	throw new Error('expected the statement to reject');
}

const WRITERS: ReadonlyArray<{ name: string; write: (db: Database) => Promise<unknown> }> = [
	{ name: 'db.eval', write: db => collect(db.eval(INSERT)) },
	{ name: 'stmt.all', write: db => drainPrepared(db, stmt => stmt.all()) },
	{ name: 'stmt.iterateRows', write: db => drainPrepared(db, stmt => stmt.iterateRows()) },
	{
		name: 'stmt.iterateRowsWithTrace',
		write: db => drainPrepared(db, stmt => stmt.iterateRowsWithTrace(undefined, new CollectingInstructionTracer())),
	},
];

const BYSTANDERS: ReadonlyArray<{ name: string; act: (db: Database) => Promise<unknown> }> = [
	{ name: 'an already-aborted eval', act: db => collect(db.eval('select 1', undefined, { signal: AbortSignal.abort() })) },
	{ name: 'an eval with a syntax error', act: db => collect(db.eval('select from where')) },
	{ name: 'return() on a never-started eval iterator', act: db => db.eval('select 1').return!() },
];

describe('overlapping statements and the implicit transaction', () => {
	let db: Database;
	let stall: CommitStall;
	let connection: CountingConnection;

	beforeEach(async () => {
		db = new Database();
		// Registered before the stall exists, so its commit is not gated: it counts a
		// commit when one is attempted, and the memory table's connection parks after it.
		connection = new CountingConnection('counting');
		await db.registerConnection(connection);
		stall = installCommitStall(db);
		await db.exec('create table t (id integer primary key)');
		connection.resetCounts();
	});

	afterEach(async () => {
		stall.release();
		await db.close();
	});

	for (const { name, write } of WRITERS) {
		it(`${name}: an overlapping select waits for the commit and does not repeat it`, async () => {
			const entered = stall.arm();
			const writer = write(db);
			await entered;

			let readSettled = false;
			const read = collect(db.eval('select id from t')).finally(() => { readSettled = true; });
			await settleMacrotasks();
			expect(readSettled, 'select finished during the commit').to.equal(false);
			expect(connection.commits).to.equal(1);

			stall.release();
			await writer;
			expect(await read).to.deep.equal([{ id: 1 }]);
			expect(connection.begins).to.equal(1);
			expect(connection.commits).to.equal(1);
		});
	}

	it('a failing commit rejects the writer and not the overlapping select', async () => {
		const failing = new CountingConnection('failing', new Error('commit failed'));
		await db.registerConnection(failing);
		const entered = stall.arm();
		const writer = collect(db.eval(INSERT));
		await entered;

		const read = collect(db.eval('select id from t'));
		await settleMacrotasks();
		stall.release();

		expect((await rejectionOf(writer)).message).to.equal('commit failed');
		await read;
		expect(connection.commits).to.equal(1);
		// Rollback goes to the connection whose commit failed, not to one that already committed.
		expect(connection.rollbacks).to.equal(0);
		expect(failing.rollbacks).to.equal(1);
	});

	for (const { name, act } of BYSTANDERS) {
		it(`${name} leaves a parked commit alone`, async () => {
			const entered = stall.arm();
			const writer = collect(db.eval(INSERT));
			await entered;

			// Whether this statement itself fails is not the subject; the writer's outcome is.
			const bystander = act(db).catch(() => undefined);
			await settleMacrotasks();
			expect(connection.rollbacks).to.equal(0);
			expect(connection.commits).to.equal(1);

			stall.release();
			await Promise.all([writer, bystander]);
			expect(connection.rollbacks).to.equal(0);
			expect(connection.commits).to.equal(1);
			expect(await collect(db.eval('select id from t'))).to.deep.equal([{ id: 1 }]);
		});
	}

	it('a nested trace does not end the enclosing statement\'s transaction', async () => {
		await db.exec('create table u (id integer primary key)');

		// execution_trace yields several rows, so the second insert hits a duplicate key.
		const failure = await rejectionOf(db.exec("insert into u select 1 from execution_trace('select 1')"));
		expect(failure.message).to.match(/unique|constraint/i);

		expect(await collect(db.eval('select id from u'))).to.deep.equal([]);
	});

	it('a nested trace with no enclosing transaction commits its own write', async () => {
		await collect(db.eval("select * from execution_trace('insert into t values (2)')"));

		expect(db._isImplicitTransaction()).to.equal(false);
		expect(connection.commits).to.equal(1);
		expect(await collect(db.eval('select id from t'))).to.deep.equal([{ id: 2 }]);
	});
});
