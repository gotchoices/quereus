import { expect } from 'chai';
import { Database, QuereusError } from '../src/index.js';

describe('Transaction API', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, val text)');
		await db.exec("insert into t values (1, 'a'), (2, 'b')");
	});

	afterEach(async () => {
		await db.close();
	});

	describe('beginTransaction()', () => {
		it('starts an explicit transaction', async () => {
			await db.beginTransaction();
			void expect(db.getAutocommit()).to.be.false;
			await db.rollback();
		});

		it('throws when called while already in a transaction', async () => {
			await db.beginTransaction();
			try {
				await db.beginTransaction();
				expect.fail('Should have thrown');
			} catch (err) {
				void expect(err).to.be.instanceOf(QuereusError);
				void expect((err as QuereusError).message).to.include('already active');
			}
			await db.rollback();
		});

		it('getAutocommit() returns false inside transaction', async () => {
			void expect(db.getAutocommit()).to.be.true;
			await db.beginTransaction();
			void expect(db.getAutocommit()).to.be.false;
			await db.rollback();
		});
	});

	describe('commit()', () => {
		it('commits data successfully', async () => {
			await db.beginTransaction();
			await db.exec("insert into t values (3, 'c')");
			await db.commit();

			const row = await db.get('select val from t where id = 3');
			void expect(row).to.exist;
			void expect(row?.val).to.equal('c');
		});

		it('throws when no transaction is active', async () => {
			try {
				await db.commit();
				expect.fail('Should have thrown');
			} catch (err) {
				void expect(err).to.be.instanceOf(QuereusError);
				void expect((err as QuereusError).message).to.include('No transaction active');
			}
		});

		it('getAutocommit() returns true after commit', async () => {
			await db.beginTransaction();
			void expect(db.getAutocommit()).to.be.false;
			await db.commit();
			void expect(db.getAutocommit()).to.be.true;
		});
	});

	describe('rollback()', () => {
		it('rolls back uncommitted changes', async () => {
			await db.beginTransaction();
			await db.exec("insert into t values (3, 'c')");

			const during = await db.get('select val from t where id = 3');
			void expect(during).to.exist;

			await db.rollback();

			const after = await db.get('select val from t where id = 3');
			void expect(after).to.be.undefined;
		});

		it('throws when no transaction is active', async () => {
			try {
				await db.rollback();
				expect.fail('Should have thrown');
			} catch (err) {
				void expect(err).to.be.instanceOf(QuereusError);
				void expect((err as QuereusError).message).to.include('No transaction active');
			}
		});

		it('getAutocommit() returns true after rollback', async () => {
			await db.beginTransaction();
			void expect(db.getAutocommit()).to.be.false;
			await db.rollback();
			void expect(db.getAutocommit()).to.be.true;
		});
	});

	describe('getAutocommit()', () => {
		it('returns true initially', () => {
			void expect(db.getAutocommit()).to.be.true;
		});

		it('returns false during explicit transaction', async () => {
			await db.beginTransaction();
			void expect(db.getAutocommit()).to.be.false;
			await db.rollback();
		});

		it('returns true after commit', async () => {
			await db.beginTransaction();
			await db.commit();
			void expect(db.getAutocommit()).to.be.true;
		});

		it('returns true after rollback', async () => {
			await db.beginTransaction();
			await db.rollback();
			void expect(db.getAutocommit()).to.be.true;
		});
	});

	describe('Transaction isolation', () => {
		it('changes are visible within transaction before commit (read-your-own-writes)', async () => {
			await db.beginTransaction();
			await db.exec("insert into t values (3, 'c')");

			const row = await db.get('select val from t where id = 3');
			void expect(row).to.exist;
			void expect(row?.val).to.equal('c');

			await db.commit();
		});

		it('changes are lost after rollback', async () => {
			await db.beginTransaction();
			await db.exec("insert into t values (3, 'c')");
			await db.exec("update t set val = 'modified' where id = 1");
			await db.exec('delete from t where id = 2');
			await db.rollback();

			const rows: Record<string, unknown>[] = [];
			for await (const row of db.eval('select * from t order by id')) {
				rows.push(row);
			}

			void expect(rows).to.have.length(2);
			void expect(rows[0]).to.deep.equal({ id: 1, val: 'a' });
			void expect(rows[1]).to.deep.equal({ id: 2, val: 'b' });
		});
	});

	describe('Savepoints via SQL', () => {
		it('savepoint creates a savepoint', async () => {
			await db.beginTransaction();
			await db.exec("insert into t values (3, 'c')");
			await db.exec('savepoint sp1');
			await db.exec("insert into t values (4, 'd')");
			await db.commit();

			const rows: Record<string, unknown>[] = [];
			for await (const row of db.eval('select * from t order by id')) {
				rows.push(row);
			}
			void expect(rows).to.have.length(4);
		});

		it('release savepoint merges changes', async () => {
			await db.beginTransaction();
			await db.exec('savepoint sp1');
			await db.exec("insert into t values (3, 'c')");
			await db.exec('release savepoint sp1');
			await db.commit();

			const row = await db.get('select val from t where id = 3');
			void expect(row).to.exist;
			void expect(row?.val).to.equal('c');
		});

		it('rollback to savepoint discards changes but keeps earlier ones', async () => {
			await db.beginTransaction();
			await db.exec("insert into t values (3, 'c')");
			await db.exec('savepoint sp1');
			await db.exec("insert into t values (4, 'd')");
			await db.exec('rollback to savepoint sp1');

			const row3 = await db.get('select val from t where id = 3');
			void expect(row3).to.exist;
			void expect(row3?.val).to.equal('c');

			const row4 = await db.get('select val from t where id = 4');
			void expect(row4).to.be.undefined;

			await db.commit();

			const afterCommit = await db.get('select val from t where id = 3');
			void expect(afterCommit).to.exist;
			void expect(afterCommit?.val).to.equal('c');
		});

		it('nested savepoints work correctly', async () => {
			await db.beginTransaction();
			await db.exec("insert into t values (3, 'c')");

			await db.exec('savepoint outer_sp');
			await db.exec("insert into t values (4, 'd')");

			await db.exec('savepoint inner_sp');
			await db.exec("insert into t values (5, 'e')");
			await db.exec('rollback to savepoint inner_sp');

			const row5 = await db.get('select val from t where id = 5');
			void expect(row5).to.be.undefined;

			const row4 = await db.get('select val from t where id = 4');
			void expect(row4).to.exist;
			void expect(row4?.val).to.equal('d');

			await db.exec('release savepoint outer_sp');
			await db.commit();

			const rows: Record<string, unknown>[] = [];
			for await (const row of db.eval('select * from t order by id')) {
				rows.push(row);
			}
			void expect(rows).to.have.length(4);
			void expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3, 4]);
		});
	});

	describe('Error recovery', () => {
		it('failed DML within explicit transaction does not break the transaction', async () => {
			await db.beginTransaction();
			await db.exec("insert into t values (3, 'c')");

			try {
				await db.exec("insert into t values (1, 'duplicate')");
				expect.fail('Should have thrown');
			} catch {
				// expected: duplicate primary key
			}

			void expect(db.getAutocommit()).to.be.false;

			await db.exec("insert into t values (4, 'd')");
			await db.commit();

			const rows: Record<string, unknown>[] = [];
			for await (const row of db.eval('select * from t order by id')) {
				rows.push(row);
			}
			void expect(rows).to.have.length(4);
			void expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3, 4]);
		});

		it('can continue operations after a caught error', async () => {
			await db.beginTransaction();

			try {
				await db.exec('select * from nonexistent_table');
				expect.fail('Should have thrown');
			} catch {
				// expected: table does not exist
			}

			void expect(db.getAutocommit()).to.be.false;

			await db.exec("insert into t values (3, 'c')");
			await db.commit();

			const row = await db.get('select val from t where id = 3');
			void expect(row).to.exist;
			void expect(row?.val).to.equal('c');
		});
	});
});
