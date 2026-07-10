/**
 * Row-validating DDL (`create unique index`, `alter table … add constraint … unique`)
 * must see the rows the issuing transaction wrote but has not yet committed, and the
 * constraint it declares must stay enforced for the rest of that transaction.
 *
 * See docs/memory-table.md § DDL and transactions.
 */
import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';
import { QuereusError } from '../src/common/errors.js';
import type { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../src/vtab/memory/layer/manager.js';

function getManager(db: Database, tableName: string): MemoryTableManager {
	const mod = db._getVtabModule('memory')?.module as MemoryTableModule | undefined;
	if (!mod) throw new Error('memory module not registered');
	const manager = mod.tables.get(`main.${tableName}`.toLowerCase());
	if (!manager) throw new Error(`no memory manager for table '${tableName}'`);
	return manager;
}

/** First column of the first row, or undefined when the query returns nothing. */
async function scalar(db: Database, sql: string): Promise<SqlValue | undefined> {
	for await (const row of db.eval(sql)) {
		return Object.values(row)[0];
	}
	return undefined;
}

const rowCount = (db: Database, table: string): Promise<SqlValue | undefined> =>
	scalar(db, `select count(*) as c from ${table}`);

async function expectError(fn: () => Promise<unknown>, code: StatusCode, match: RegExp): Promise<void> {
	let caught: unknown;
	try {
		await fn();
	} catch (e) {
		caught = e;
	}
	expect(caught, 'expected an error to be thrown').to.be.instanceOf(QuereusError);
	const err = caught as QuereusError;
	expect(err.code, `expected code ${code}, got ${err.code}: ${err.message}`).to.equal(code);
	expect(err.message).to.match(match);
}

describe('row-validating DDL inside an open transaction (memory backend)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('validation sees the transaction\'s own uncommitted rows', () => {
		it('create unique index rejects a duplicate that only exists in the pending layer', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('create unique index rejects a committed row colliding with a pending row', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 'a')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			await db.exec(`rollback`);
		});

		it('add constraint … unique rejects a duplicate that only exists in the pending layer', async () => {
			await db.exec(`create table t2 (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t2 values (1, 'a'), (2, 'a')`);

			await expectError(
				() => db.exec(`alter table t2 add constraint u2 unique (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			await db.exec(`rollback`);
		});

		it('honors NULL semantics — multiple NULLs in the pending layer are not duplicates', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, null), (2, null)`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(2);
		});

		it('honors a partial index predicate over pending rows', async () => {
			await db.exec(`create table t (id integer primary key, v text, active integer)`);
			await db.exec(`begin`);
			// Only the two active rows are in scope; they do not collide.
			await db.exec(`insert into t values (1, 'a', 1), (2, 'b', 1), (3, 'a', 0)`);
			await db.exec(`create unique index ix on t (v) where active = 1`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(3);
		});

		it('honors a partial index predicate that DOES collide over pending rows', async () => {
			await db.exec(`create table t (id integer primary key, v text, active integer)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a', 1), (2, 'a', 1), (3, 'b', 0)`);

			await expectError(
				() => db.exec(`create unique index ix on t (v) where active = 1`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('detects a duplicate that only collides under the index collation', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'A')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v collate nocase)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('sees a pending DELETE — a committed duplicate removed in-transaction does not block the build', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);
			await db.exec(`begin`);
			await db.exec(`delete from t where id = 2`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(1);
		});

		it('a failed create unique index leaves the schema and the table untouched', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);
			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			// The transaction is still usable and the index never appeared.
			await db.exec(`insert into t values (3, 'b')`);
			expect(await rowCount(db, 't')).to.equal(3);
			await db.exec(`commit`);

			const manager = getManager(db, 't');
			expect(manager.tableSchema.indexes?.some(i => i.name === 'ix') ?? false).to.equal(false);
			expect(manager.tableSchema.uniqueConstraints ?? []).to.have.length(0);
			expect(await rowCount(db, 't')).to.equal(3);
		});
	});

	describe('the new constraint is enforced for the rest of the transaction', () => {
		it('create unique index rejects a later colliding insert in the same transaction', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`create unique index ix on t (v)`);

			await expectError(
				() => db.exec(`insert into t values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			await db.exec(`insert into t values (3, 'b')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
		});

		it('create unique index rejects a later insert colliding with a COMMITTED row', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`begin`);
			await db.exec(`create unique index ix on t (v)`);

			await expectError(
				() => db.exec(`insert into t values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('add constraint … unique rejects a later colliding insert in the same transaction', async () => {
			await db.exec(`create table t2 (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t2 values (1, 'a')`);
			await db.exec(`alter table t2 add constraint u2 unique (v)`);

			await expectError(
				() => db.exec(`insert into t2 values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`commit`);
			expect(await rowCount(db, 't2')).to.equal(1);
		});

		it('add constraint … unique that REUSES an existing unique index still enforces afterwards', async () => {
			await db.exec(`create table t2 (id integer primary key, v text)`);
			await db.exec(`create unique index ix on t2 (v)`);
			await db.exec(`begin`);
			await db.exec(`insert into t2 values (1, 'a')`);
			// Reuse path: the existing unique index already covers (v).
			await db.exec(`alter table t2 add constraint u2 unique (v)`);

			await expectError(
				() => db.exec(`insert into t2 values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`commit`);

			const manager = getManager(db, 't2');
			expect((manager.tableSchema.uniqueConstraints ?? []).some(uc => uc.name === 'u2')).to.equal(true);
			expect(await rowCount(db, 't2')).to.equal(1);
		});

		it('a non-unique create index in a transaction leaves later inserts unconstrained', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`create index ix on t (v)`);
			await db.exec(`insert into t values (2, 'a')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
			// The index must still resolve every row.
			expect(await scalar(db, `select count(*) as c from t where v = 'a'`)).to.equal(2);
		});

		it('a pending UPDATE onto the new index key is rejected', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'b')`);
			await db.exec(`create unique index ix on t (v)`);

			await expectError(
				() => db.exec(`update t set v = 'a' where id = 2`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});
	});

	describe('rollback', () => {
		it('discards the pending rows; the committed base index holds exactly the committed rows', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'x')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 'a')`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`rollback`);

			expect(await rowCount(db, 't')).to.equal(1);
			// The previously-pending value is free again, and the surviving index accepts it.
			await db.exec(`insert into t values (3, 'a')`);
			expect(await rowCount(db, 't')).to.equal(2);
			// …but the index it left behind still enforces uniqueness.
			await expectError(
				() => db.exec(`insert into t values (4, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
		});
	});

	describe('savepoints', () => {
		it('create unique index sees rows written after a savepoint', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('create unique index sees rows written before AND after a savepoint', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values (2, 'a')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('DDL after an eager savepoint does not lose the pre-savepoint rows on commit', async () => {
			// `savepoint` with a pending layer swaps that layer into `readLayer` and clears
			// `pendingTransactionLayer`. The schema change must leave that read view alone —
			// re-pointing it at the base would silently drop row 1 at commit.
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(1);
			await expectError(
				() => db.exec(`insert into t values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
		});

		it('create unique index rejects a duplicate held only in an eager savepoint snapshot', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);
			await db.exec(`savepoint s`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('DDL after a RELEASED eager savepoint does not lose the pre-savepoint rows', async () => {
			// `release` pops the savepoint entry but leaves its snapshot installed as
			// `readLayer`, still holding uncommitted rows. `hasOpenWork` must keep reporting
			// them, or the schema change re-points the read view at the base and drops row 1.
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`release s`);
			await db.exec(`create index ix on t (v)`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(1);
		});

		it('create unique index sees a duplicate held only in a RELEASED savepoint snapshot', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`release s`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('after rollback to savepoint the adopted schema still enforces the new constraint', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values (2, 'b')`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`rollback to s`);

			// Row 2 is gone; row 1 survives; the constraint declared after the savepoint
			// must still be enforced against row 1.
			expect(await rowCount(db, 't')).to.equal(1);
			await expectError(
				() => db.exec(`insert into t values (3, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`insert into t values (4, 'b')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
		});
	});

	describe('other connections', () => {
		it('raises BUSY when a sibling connection holds uncommitted writes', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			const manager = getManager(db, 't');

			// A second connection to the same manager with its own pending layer. Its rows
			// are invisible to the DDL's transaction, so the schema change cannot be
			// validated against them and its layer cannot be re-pointed at the new schema.
			const sibling = manager.connect();
			sibling.begin();
			await manager.performMutation(sibling, 'insert', [9, 'z']);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.BUSY,
				/uncommitted|transaction/i,
			);

			sibling.rollback();
			// Once the sibling is done, the DDL proceeds.
			await db.exec(`create unique index ix on t (v)`);
			expect(manager.tableSchema.indexes?.some(i => i.name === 'ix') ?? false).to.equal(true);
		});
	});
});
