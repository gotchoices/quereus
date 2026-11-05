import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { VirtualTableConnection } from '../../src/vtab/connection.js';
import { installConnectionLifecycleCheck, type ConnectionLifecycleCheck } from '../../src/vtab/test-support/connection-lifecycle-check.js';

/**
 * The connection lifecycle contract (docs/invariants.md TXN-001): the check that
 * detects a breach of it, and the engine paths that have to honour it when a
 * connection's begin or commit rejects.
 */

type Method = 'begin' | 'commit' | 'rollback' | 'createSavepoint' | 'releaseSavepoint' | 'rollbackToSavepoint';
type Step = readonly [method: Method, depth?: number];

class FakeConnection implements VirtualTableConnection {
	readonly tableName = 'main.fake';
	readonly calls: string[] = [];
	/** Methods that reject when called. */
	readonly rejecting = new Set<Method>();
	/** Methods that return a promise the test settles itself. */
	readonly parked = new Map<Method, () => void>();

	constructor(readonly connectionId: string) {}

	private run(method: Method): void | Promise<void> {
		this.calls.push(method);
		if (this.rejecting.has(method)) throw new Error(`${method} failed`);
		if (this.parked.has(method)) {
			return new Promise<void>(resolve => { this.parked.set(method, resolve); });
		}
	}

	begin(): void | Promise<void> { return this.run('begin'); }
	commit(): void | Promise<void> { return this.run('commit'); }
	rollback(): void | Promise<void> { return this.run('rollback'); }
	createSavepoint(_depth: number): void | Promise<void> { return this.run('createSavepoint'); }
	releaseSavepoint(_depth: number): void | Promise<void> { return this.run('releaseSavepoint'); }
	rollbackToSavepoint(_depth: number): void | Promise<void> { return this.run('rollbackToSavepoint'); }
	disconnect(): void { /* no-op */ }

	count(method: Method): number {
		return this.calls.filter(call => call === method).length;
	}
}

function call(connection: FakeConnection, [method, depth]: Step): void | Promise<void> {
	return method.endsWith('Savepoint')
		? connection[method as 'createSavepoint'](depth!)
		: connection[method as 'begin']();
}

async function rejectionOf(work: Promise<unknown>): Promise<Error> {
	try {
		await work;
	} catch (e) {
		return e as Error;
	}
	throw new Error('expected a rejection');
}

describe('connection lifecycle check', () => {
	let db: Database;
	let check: ConnectionLifecycleCheck;
	let connection: FakeConnection;
	let releaseMutex: (() => void) | null;

	beforeEach(async () => {
		db = new Database();
		check = installConnectionLifecycleCheck(db);
		connection = new FakeConnection('fake');
		// Outside a transaction, so registration makes no calls on it.
		await db.registerConnection(connection);
		releaseMutex = await db._acquireExecMutex();
	});

	afterEach(async () => {
		releaseMutex?.();
		await db.close();
	});

	/** Runs `setup` legally, then expects `illegal` to be refused before reaching the connection. */
	async function expectRefused(setup: readonly Step[], illegal: Step): Promise<void> {
		for (const step of setup) await call(connection, step);
		const reached = connection.calls.length;

		expect(() => call(connection, illegal)).to.throw(/Connection lifecycle violation/);
		expect(check.violations).to.have.length(1);
		expect(check.violations[0]).to.include(illegal[0]).and.include("connection 'fake' (table 'main.fake')");
		expect(connection.calls, 'the refused call reached the connection').to.have.length(reached);
	}

	const ILLEGAL: ReadonlyArray<{ name: string; setup: readonly Step[]; illegal: Step }> = [
		{ name: 'commit while idle', setup: [], illegal: ['commit'] },
		{ name: 'rollback while idle', setup: [], illegal: ['rollback'] },
		{ name: 'begin while open', setup: [['begin']], illegal: ['begin'] },
		{ name: 'createSavepoint while idle', setup: [], illegal: ['createSavepoint', 0] },
		{ name: 'releaseSavepoint while idle', setup: [], illegal: ['releaseSavepoint', 0] },
		{ name: 'rollbackToSavepoint while idle', setup: [], illegal: ['rollbackToSavepoint', 0] },
		{ name: 'createSavepoint that skips a depth', setup: [['begin']], illegal: ['createSavepoint', 1] },
		{ name: 'createSavepoint that repeats a depth', setup: [['begin'], ['createSavepoint', 0]], illegal: ['createSavepoint', 0] },
		{ name: 'releaseSavepoint at a depth not held', setup: [['begin'], ['createSavepoint', 0]], illegal: ['releaseSavepoint', 1] },
		{ name: 'rollbackToSavepoint at a depth not held', setup: [['begin'], ['createSavepoint', 0]], illegal: ['rollbackToSavepoint', 1] },
		{ name: 'releaseSavepoint at a depth already released', setup: [['begin'], ['createSavepoint', 0], ['releaseSavepoint', 0]], illegal: ['releaseSavepoint', 0] },
	];

	for (const { name, setup, illegal } of ILLEGAL) {
		it(`refuses ${name}`, async () => {
			await expectRefused(setup, illegal);
		});
	}

	for (const illegal of [['begin'], ['commit'], ['createSavepoint', 0]] as const) {
		it(`refuses ${illegal[0]} after a rejected commit`, async () => {
			await call(connection, ['begin']);
			connection.rejecting.add('commit');
			expect(() => call(connection, ['commit'])).to.throw('commit failed');

			await expectRefused([], illegal);
		});
	}

	it('refuses a call that overlaps an unsettled one', async () => {
		await call(connection, ['begin']);
		connection.parked.set('createSavepoint', () => undefined);
		const pending = call(connection, ['createSavepoint', 0]);

		await expectRefused([], ['commit']);

		connection.parked.get('createSavepoint')!();
		await pending;
	});

	it('refuses a commit made without the execution mutex', async () => {
		await call(connection, ['begin']);
		releaseMutex!();
		releaseMutex = null;

		await expectRefused([], ['commit']);
	});

	it('records nothing for a legal sequence, and returns what the connection returns', async () => {
		const legal: Step[] = [
			['begin'], ['createSavepoint', 0], ['createSavepoint', 1], ['rollbackToSavepoint', 0],
			['createSavepoint', 1], ['releaseSavepoint', 0], ['commit'],
			['begin'], ['commit'],
			['begin'], ['rollback'],
		];
		for (const step of legal) {
			expect(call(connection, step), `${step[0]} is synchronous on this connection`).to.equal(undefined);
		}

		// A rejected commit is followed by rollback, and a rejected begin leaves the connection idle.
		await call(connection, ['begin']);
		connection.rejecting.add('commit');
		expect(() => call(connection, ['commit'])).to.throw('commit failed');
		await call(connection, ['rollback']);
		connection.rejecting.add('begin');
		expect(() => call(connection, ['begin'])).to.throw('begin failed');
		connection.rejecting.clear();
		await call(connection, ['begin']);
		await call(connection, ['commit']);

		expect(check.violations).to.deep.equal([]);
		check.assertClean();
	});

	it('assertClean throws for a connection left open with no statement running', async () => {
		await call(connection, ['begin']);
		check.assertClean();

		releaseMutex!();
		releaseMutex = null;
		expect(() => check.assertClean()).to.throw(/is open at savepoint depth 0 with no statement running/);
	});
});

describe('connection lifecycle when a begin or commit rejects', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('a rejected begin rolls back the connections already begun and leaves autocommit', async () => {
		const first = new FakeConnection('first');
		const second = new FakeConnection('second');
		second.rejecting.add('begin');
		await db.registerConnection(first);
		await db.registerConnection(second);

		expect((await rejectionOf(db.beginTransaction())).message).to.equal('begin failed');

		expect(first.calls).to.deep.equal(['begin', 'rollback']);
		expect(second.calls).to.deep.equal(['begin']);
		expect(db.getAutocommit()).to.equal(true);
	});

	it('a connection whose begin rejects on registration is not left registered', async () => {
		const failing = new FakeConnection('failing');
		failing.rejecting.add('begin');
		await db.beginTransaction();

		expect((await rejectionOf(db.registerConnection(failing))).message).to.equal('begin failed');

		expect(db.getConnection('failing')).to.equal(undefined);
		await db.rollback();
	});

	it('a rejected early commit rolls the whole transaction back', async () => {
		const bystander = new FakeConnection('bystander');
		const early = new FakeConnection('early');
		early.rejecting.add('commit');
		await db.beginTransaction();
		await db.registerConnection(bystander);
		await db.registerConnection(early);

		let committed = false;
		const work = db._commitConnectionEarly(early, () => { committed = true; });
		expect((await rejectionOf(work)).message).to.equal('commit failed');

		expect(committed, 'the commit never resolved').to.equal(false);
		expect(bystander.calls).to.deep.equal(['begin', 'rollback']);
		expect(early.calls).to.deep.equal(['begin', 'commit', 'rollback']);
		expect(db.getAutocommit()).to.equal(true);
	});

	it('a rejected re-begin after an early commit still reports the commit as made', async () => {
		const bystander = new FakeConnection('bystander');
		const early = new FakeConnection('early');
		await db.beginTransaction();
		await db.registerConnection(bystander);
		await db.registerConnection(early);
		early.rejecting.add('begin');

		let committed = false;
		const work = db._commitConnectionEarly(early, () => { committed = true; });
		expect((await rejectionOf(work)).message).to.equal('begin failed');

		// The rows are committed, so the caller must not undo what it built on them;
		// the connection is idle and gets no rollback.
		expect(committed).to.equal(true);
		expect(bystander.calls).to.deep.equal(['begin', 'rollback']);
		expect(early.calls).to.deep.equal(['begin', 'commit', 'begin']);
		expect(db.getAutocommit()).to.equal(true);
	});
});
