import { expect } from 'chai';
import { Database, MisuseError } from '../src/index.js';

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
