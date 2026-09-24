import { expect } from 'chai';
import { Database, QuereusError, MisuseError, TransactionActiveError, StatusCode, createScalarFunction, isAbortError } from '../src/index.js';

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

	/** Ids currently in `t`, ascending — the whole-table assertion these tests make. */
	const idsInT = async (): Promise<number[]> => {
		const ids: number[] = [];
		for await (const row of db.eval('select id from t order by id')) {
			ids.push(Number(row.id));
		}
		return ids;
	};

	/** Awaits a call that must reject and hands back the error it rejected with. */
	const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
		try {
			await promise;
		} catch (err) {
			return err;
		}
		return expect.fail('expected the call to reject');
	};

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

	describe("exec({ transaction: true })", () => {
		it('rolls the whole batch back on a mid-batch failure, and the caller queued behind it keeps its row', async () => {
			const atomic = db.exec(
				"insert into t values (3, 'c'); insert into t values (1, 'duplicate');",
				undefined,
				{ transaction: true },
			);
			// Queued in the same tick: `exec` runs synchronously up to the mutex, so this
			// statement is strictly behind the batch with no timer needed. It is the loss
			// this option exists to prevent — before, it ran INSIDE the stranded
			// transaction and vanished with it.
			const queued = db.exec("insert into t values (4, 'd')");

			const err = await rejection(atomic);
			await queued;

			void expect(err).to.be.instanceOf(QuereusError);
			void expect(db.getAutocommit()).to.be.true;
			void expect(await idsInT()).to.deep.equal([1, 2, 4]);
		});

		it('rolls back a failure raised at commit time without rolling back twice', async () => {
			await db.exec('pragma foreign_keys = true');
			await db.exec('create table fk_parent (id integer primary key)');
			await db.exec(`create table fk_child (id integer primary key,
				pid integer null references fk_parent(id) deferrable initially deferred)`);

			// The deferred FK check only fails at COMMIT, and TransactionManager has
			// already rolled every connection back by the time it throws.
			const atomic = db.exec(
				"insert into t values (3, 'c'); insert into fk_child values (10, 99);",
				undefined,
				{ transaction: true },
			);
			const queued = db.exec("insert into t values (4, 'd')");

			const err = await rejection(atomic);
			await queued;

			void expect(err).to.be.instanceOf(QuereusError);
			void expect(db.getAutocommit()).to.be.true;
			void expect(await idsInT()).to.deep.equal([1, 2, 4]);
			void expect(await db.get('select id from fk_child where id = 10')).to.be.undefined;
		});

		it("refuses while another caller's transaction is open, leaving that transaction untouched", async () => {
			await db.exec('begin');
			await db.exec("insert into t values (3, 'c')");

			const err = await rejection(db.exec("insert into t values (4, 'd')", undefined, { transaction: true }));
			void expect(err).to.be.instanceOf(TransactionActiveError);
			void expect((err as QuereusError).code).to.equal(StatusCode.BUSY);

			// Still open, still holding its uncommitted row, still committable by its owner.
			void expect(db.getAutocommit()).to.be.false;
			await db.exec('commit');
			void expect(await idsInT()).to.deep.equal([1, 2, 3]);
		});

		it("refuses against the caller's own open transaction, doing no partial work", async () => {
			await db.beginTransaction();

			const err = await rejection(db.exec("insert into t values (3, 'c')", undefined, { transaction: true }));
			void expect(err).to.be.instanceOf(TransactionActiveError);
			void expect(db.getAutocommit()).to.be.false;

			await db.rollback();
			void expect(await idsInT()).to.deep.equal([1, 2]);
		});

		it('commits the batch atomically as one transaction, binding named parameters across it', async () => {
			let commitBatches = 0;
			const off = db.onTransactionCommit(() => { commitBatches++; });
			try {
				await db.exec(
					`insert into t values (3, :val);
					 insert into t values (4, :val);
					 update t set val = :val where id = 1;`,
					{ val: 'shared' },
					{ transaction: true },
				);
			} finally {
				off();
			}

			const rows: Record<string, unknown>[] = [];
			for await (const row of db.eval('select id, val from t order by id')) {
				rows.push(row);
			}
			void expect(rows).to.deep.equal([
				{ id: 1, val: 'shared' },
				{ id: 2, val: 'b' },
				{ id: 3, val: 'shared' },
				{ id: 4, val: 'shared' },
			]);
			// One transaction, so one commit event for the whole batch — a plain
			// multi-statement `exec` would fire once per statement.
			void expect(commitBatches).to.equal(1);
		});

		it('fires no commit event when the batch fails', async () => {
			let commitBatches = 0;
			const off = db.onTransactionCommit(() => { commitBatches++; });
			try {
				await rejection(db.exec(
					"insert into t values (3, 'c'); insert into t values (1, 'duplicate');",
					undefined,
					{ transaction: true },
				));
			} finally {
				off();
			}
			void expect(commitBatches).to.equal(0);
		});

		it('refuses a batch that spells its own transaction control, changing nothing', async () => {
			for (const sql of [
				"begin; insert into t values (3, 'c');",
				"insert into t values (3, 'c'); commit;",
				"insert into t values (3, 'c'); rollback;",
			]) {
				const err = await rejection(db.exec(sql, undefined, { transaction: true }));
				void expect(err, sql).to.be.instanceOf(MisuseError);
				void expect(db.getAutocommit(), sql).to.be.true;
				void expect(await idsInT(), sql).to.deep.equal([1, 2]);
			}
		});

		it('accepts savepoints inside the batch and still commits', async () => {
			await db.exec(
				`insert into t values (3, 'c');
				 savepoint sp1;
				 insert into t values (4, 'd');
				 rollback to savepoint sp1;
				 insert into t values (5, 'e');`,
				undefined,
				{ transaction: true },
			);

			// `rollback to savepoint` must leave the batch's transaction open, so the
			// statements after it run and the closing commit still fires.
			void expect(await idsInT()).to.deep.equal([1, 2, 3, 5]);
			void expect(db.getAutocommit()).to.be.true;
		});

		it('rolls the whole batch back when OR ROLLBACK ends the transaction from inside a statement', async () => {
			// The one failure shape that ends the batch's transaction BEFORE the batch's
			// own catch runs: `_finalizeImplicitTransaction` honours OR ROLLBACK by rolling
			// back whatever transaction is active, explicit ones included. The catch must
			// notice it is no longer in a transaction and not roll back a second time.
			const err = await rejection(db.exec(
				"insert into t values (3, 'c'); insert or rollback into t values (1, 'duplicate');",
				undefined,
				{ transaction: true },
			));

			void expect(err).to.be.instanceOf(QuereusError);
			void expect(db.getAutocommit()).to.be.true;
			void expect(await idsInT()).to.deep.equal([1, 2]);

			// And the database is immediately reusable — nothing was stranded.
			await db.exec("insert into t values (5, 'e')", undefined, { transaction: true });
			void expect(await idsInT()).to.deep.equal([1, 2, 5]);
		});

		it('accepts savepoint + release inside the batch and still commits everything', async () => {
			// RELEASE of the outermost savepoint merges layers; unlike SQL's standalone
			// RELEASE-commits-the-transaction reading, it must NOT end the batch's
			// transaction, so the statements after it still ride the closing commit.
			await db.exec(
				`savepoint sp1;
				 insert into t values (3, 'c');
				 release sp1;
				 insert into t values (4, 'd');`,
				undefined,
				{ transaction: true },
			);

			void expect(db.getAutocommit()).to.be.true;
			void expect(await idsInT()).to.deep.equal([1, 2, 3, 4]);
		});

		it('rolls the batch back when the signal aborts mid-batch', async () => {
			const controller = new AbortController();
			db.createScalarFunction('trip_abort', { numArgs: 0 }, () => {
				controller.abort();
				return 'c';
			});

			const err = await rejection(db.exec(
				"insert into t values (3, trip_abort()); insert into t values (4, 'd');",
				undefined,
				{ transaction: true, signal: controller.signal },
			));

			void expect(isAbortError(err)).to.be.true;
			void expect(db.getAutocommit()).to.be.true;
			void expect(await idsInT()).to.deep.equal([1, 2]);
		});

		it('rolls back rather than commits when the abort comes from the last statement', async () => {
			const controller = new AbortController();
			db.createScalarFunction('trip_abort_last', { numArgs: 0 }, () => {
				controller.abort();
				return 'c';
			});

			const err = await rejection(db.exec(
				'insert into t values (3, trip_abort_last());',
				undefined,
				{ transaction: true, signal: controller.signal },
			));

			void expect(isAbortError(err)).to.be.true;
			void expect(await idsInT()).to.deep.equal([1, 2]);
		});

		it('opens no transaction when the signal is already aborted', async () => {
			const controller = new AbortController();
			controller.abort();

			const err = await rejection(db.exec("insert into t values (3, 'c')", undefined, {
				transaction: true,
				signal: controller.signal,
			}));

			void expect(isAbortError(err)).to.be.true;
			void expect(db.getAutocommit()).to.be.true;
			void expect(await idsInT()).to.deep.equal([1, 2]);
		});

		it('resolves without opening a transaction for whitespace-only SQL', async () => {
			await db.exec('   \n  ', undefined, { transaction: true });
			void expect(db.getAutocommit()).to.be.true;
			void expect(await idsInT()).to.deep.equal([1, 2]);
		});
	});

	describe('transaction-state checks taken under the mutex', () => {
		/**
		 * Registers an async scalar function that parks the statement calling it until
		 * `release` runs. Without such a gate these races are not testable: `db.exec`
		 * returns to its caller before the implicit transaction is even open, so the
		 * old pre-mutex check saw `isInTransaction() === false` and passed by luck.
		 */
		beforeEach(async () => {
			// One-row source table so the gated write's value expression is pulled from
			// INSIDE the DML executor's drain — i.e. after it has opened the implicit
			// transaction. A `values (...)` list is evaluated before that, which parks
			// the statement in a state these tests are not about.
			await db.exec('create table gate_src (id integer primary key)');
			await db.exec('insert into gate_src values (1)');
		});

		const installGate = (name: string): { started: Promise<void>; release: () => void } => {
			let markStarted!: () => void;
			const started = new Promise<void>(resolve => { markStarted = resolve; });
			let openGate!: () => void;
			const gate = new Promise<void>(resolve => { openGate = resolve; });
			db.registerFunction(createScalarFunction(
				{ name, numArgs: 0, deterministic: false },
				async () => {
					markStarted();
					await gate;
					return 'parked';
				},
			));
			return { started, release: openGate };
		};

		it("beginTransaction() queues behind another caller's in-flight write instead of refusing", async () => {
			const gate = installGate('park_write');
			const write = db.exec('insert into t select 3, park_write() from gate_src');
			await gate.started;

			// The in-flight write holds the mutex with its implicit transaction open —
			// exactly the state the old pre-mutex check mistook for "already active".
			void expect(db.getAutocommit()).to.be.false;
			const begun = db.beginTransaction();

			gate.release();
			await write;
			await begun;

			void expect(db.getAutocommit()).to.be.false;
			await db.rollback();
			void expect(await idsInT()).to.deep.equal([1, 2, 3]);
		});

		it("commit() during another caller's in-flight write reports no transaction instead of silently no-opping", async () => {
			const gate = installGate('park_write2');
			const write = db.exec('insert into t select 3, park_write2() from gate_src');
			await gate.started;

			const attempt = db.commit();
			gate.release();
			await write;

			const err = await rejection(attempt);
			void expect(err).to.be.instanceOf(QuereusError);
			void expect((err as QuereusError).message).to.include('No transaction active');
			// The write's own autocommit stands: commit() never touched it.
			void expect(await idsInT()).to.deep.equal([1, 2, 3]);
		});

		it("rollback() during another caller's in-flight write reports no transaction and leaves its row", async () => {
			const gate = installGate('park_write3');
			const write = db.exec('insert into t select 3, park_write3() from gate_src');
			await gate.started;

			const attempt = db.rollback();
			gate.release();
			await write;

			const err = await rejection(attempt);
			void expect(err).to.be.instanceOf(QuereusError);
			void expect((err as QuereusError).message).to.include('No transaction active');
			void expect(await idsInT()).to.deep.equal([1, 2, 3]);
		});
	});
});
