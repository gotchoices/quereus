import { expect } from 'chai';
import { Database, MemoryTableModule, MisuseError, type VirtualTableConnection } from '../src/index.js';
import { settleMacrotasks } from '../src/vtab/test-support/commit-stall.js';

async function rejectionOf(work: Promise<unknown>): Promise<Error> {
	try {
		await work;
	} catch (e) {
		return e as Error;
	}
	throw new Error('expected a rejection');
}

/** A connection whose commit waits until `open()`, recording the order of commit and disconnect. */
function gatedConnection(events: string[]) {
	let open!: () => void;
	const gate = new Promise<void>(resolve => { open = resolve; });
	let entered!: () => void;
	const commitEntered = new Promise<void>(resolve => { entered = resolve; });
	const connection: VirtualTableConnection = {
		connectionId: 'gated',
		tableName: 'gated',
		begin() { /* nothing to begin */ },
		async commit() {
			entered();
			await gate;
			events.push('commit returned');
		},
		rollback() { /* nothing to undo */ },
		createSavepoint() { /* not asserted */ },
		releaseSavepoint() { /* not asserted */ },
		rollbackToSavepoint() { /* not asserted */ },
		disconnect() { events.push('disconnect'); },
	};
	return { connection, commitEntered, open };
}

describe('Database Lifecycle', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, val text)');
		await db.exec("insert into t values (1, 'a'), (2, 'b')");
	});

	afterEach(async () => {
		// close() is idempotent, safe even if test already closed
		await db.close();
	});

	it('close() is idempotent', async () => {
		await db.close();
		await db.close(); // second call should not throw
	});

	it('close() finalizes outstanding statements', async () => {
		const stmt = db.prepare('select * from t');
		await db.close();

		// Statement should now be finalized; operations should fail
		try {
			await stmt.run();
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
		}
	});

	it('exec() throws after close()', async () => {
		await db.close();
		try {
			await db.exec('select 1');
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
			expect((err as MisuseError).message).to.include('closed');
		}
	});

	it('prepare() throws after close()', async () => {
		await db.close();
		try {
			db.prepare('select 1');
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
			expect((err as MisuseError).message).to.include('closed');
		}
	});

	it('get() throws after close()', async () => {
		await db.close();
		try {
			await db.get('select 1');
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
			expect((err as MisuseError).message).to.include('closed');
		}
	});

	it('eval() throws after close()', async () => {
		await db.close();
		try {
			// eval() returns an iterator; the check happens when the generator starts
			const iter = db.eval('select 1');
			await iter.next();
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
			expect((err as MisuseError).message).to.include('closed');
		}
	});

	describe('while work is running', () => {
		it('an iterator pulled once does not hold close() up, and rejects its next pull', async () => {
			const it = db.eval('select * from t');
			expect((await it.next()).done).to.equal(false);

			await db.close();

			const err = await rejectionOf(it.next());
			expect(err).to.be.instanceOf(MisuseError);
			expect(err.message).to.equal('Database is closed');
		});

		it('close() waits for a commit in progress before disconnecting and clearing the catalog', async () => {
			const events: string[] = [];
			const { connection, commitEntered, open } = gatedConnection(events);
			await db.registerConnection(connection);
			const write = db.exec("insert into t values (3, 'c')");
			await commitEntered;

			let closed = false;
			const closing = db.close().then(() => { closed = true; });
			await settleMacrotasks();
			expect(closed, 'close() resolved during the commit').to.equal(false);

			open();
			await write;
			await closing;
			expect(events).to.deep.equal(['commit returned', 'disconnect']);
			expect([...db.schemaManager.getSchema('main')!.getAllTables()]).to.deep.equal([]);
		});

		it('a module hook may start close() without awaiting it: the statement rejects and close() completes', async () => {
			let closing: Promise<void> | undefined;
			let armed = false;
			class ClosingModule extends MemoryTableModule {
				override connect(...args: Parameters<MemoryTableModule['connect']>) {
					if (armed) closing ??= db.close();
					return super.connect(...args);
				}
			}
			db.registerModule('closing', new ClosingModule());
			await db.exec('create table s (id integer primary key) using closing');
			await db.exec('insert into s values (1), (2)');
			armed = true;

			const err = await rejectionOf(db.exec('select * from s'));

			expect(err.message).to.equal('Database is closed');
			expect(closing, 'the hook ran').to.not.equal(undefined);
			await closing;
		});
	});

	it('statement prepared before close() rejects operations', async () => {
		const stmt = db.prepare('select * from t where id = ?');
		await db.close();

		const operations = [
			() => stmt.run([1]),
			() => stmt.get([1]),
			() => stmt.all([1]).next(),
		];

		for (const op of operations) {
			try {
				await op();
				expect.fail('Should have thrown');
			} catch (err) {
				expect(err).to.be.instanceOf(MisuseError);
			}
		}
	});
});

describe('Statement Lifecycle', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, val text)');
		await db.exec("insert into t values (1, 'a'), (2, 'b')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('finalize() is idempotent', async () => {
		const stmt = db.prepare('select * from t');
		await stmt.finalize();
		await stmt.finalize(); // second call should not throw
	});

	it('run() throws after finalize()', async () => {
		const stmt = db.prepare("insert into t values (3, 'c')");
		await stmt.finalize();
		try {
			await stmt.run();
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
			expect((err as MisuseError).message).to.include('finalized');
		}
	});

	it('get() throws after finalize()', async () => {
		const stmt = db.prepare('select * from t where id = 1');
		await stmt.finalize();
		try {
			await stmt.get();
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
			expect((err as MisuseError).message).to.include('finalized');
		}
	});

	it('all() throws after finalize()', async () => {
		const stmt = db.prepare('select * from t');
		await stmt.finalize();
		try {
			stmt.all();
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
			expect((err as MisuseError).message).to.include('finalized');
		}
	});

	it('iterateRows() throws after finalize()', async () => {
		const stmt = db.prepare('select * from t');
		await stmt.finalize();
		try {
			// iterateRows wraps a generator; validation fires on first next()
			const iter = stmt.iterateRows();
			await iter.next();
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
			expect((err as MisuseError).message).to.include('finalized');
		}
	});

	it('bind() throws after finalize()', async () => {
		const stmt = db.prepare('select * from t where id = ?');
		await stmt.finalize();
		try {
			stmt.bind(1, 1);
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).to.be.instanceOf(MisuseError);
		}
	});

	it('statement can be reused after error via reset()', async () => {
		const stmt = db.prepare('insert into t values (?, ?)');

		// First run succeeds
		await stmt.run([3, 'c']);

		// Second run fails (duplicate key)
		try {
			await stmt.run([3, 'duplicate']);
			expect.fail('Should have thrown');
		} catch {
			// expected
		}

		// Reset and retry with different values should work
		await stmt.reset();
		await stmt.run([4, 'd']);

		const row = await db.get('select val from t where id = 4');
		expect(row?.val).to.equal('d');

		await stmt.finalize();
	});

	it('finalized statement is removed from database statements set', async () => {
		const stmt = db.prepare('select 1');
		// The statement should be tracked; after finalize it should not deadlock close
		await stmt.finalize();
		// If it wasn't removed, close would try to finalize an already-finalized statement
		// which should still work because finalize is idempotent
		await db.close();
	});
});
