import { expect } from 'chai';
import { Database } from '../../src/index.js';

/**
 * Regression test for the change-log key serializer crashing on a bigint PK.
 *
 * `TransactionManager.serializeKeyTuple` derived the change-log Map key via
 * canonical JSON (`JSON.stringify`), which throws "Do not know how to serialize
 * a BigInt" the moment any DML op inside a transaction touches a row whose PK
 * (or a captured column) is a JS bigint. A PK value beyond
 * `Number.MAX_SAFE_INTEGER` surfaces as a bigint, so a plain INSERT crashed.
 */
describe('TransactionManager: bigint PK does not crash the change log', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	// 2^53 + 1 — the smallest positive integer that cannot be represented
	// exactly as a JS number, so it must survive as a bigint end-to-end.
	const BIG = 9007199254740993n;

	it('inserts a bigint PK inside an explicit transaction without throwing', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('BEGIN');
		await db.exec(`INSERT INTO t VALUES (${BIG.toString()}, 'x')`);
		await db.exec('COMMIT');

		const rows = await db.prepare('SELECT id, v FROM t').all();
		expect(rows).to.have.length(1);
		// Value must round-trip exactly — a number cast would lose the low bit.
		expect(rows[0].id).to.equal(BIG);
		expect(rows[0].v).to.equal('x');
	});

	it('updates and deletes a bigint PK row without throwing', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec(`INSERT INTO t VALUES (${BIG.toString()}, 'a')`);

		await db.exec('BEGIN');
		await db.exec(`UPDATE t SET v = 'b' WHERE id = ${BIG.toString()}`);
		await db.exec('COMMIT');
		expect((await db.prepare('SELECT v FROM t').all())[0].v).to.equal('b');

		await db.exec('BEGIN');
		await db.exec(`DELETE FROM t WHERE id = ${BIG.toString()}`);
		await db.exec('COMMIT');
		expect(await db.prepare('SELECT id FROM t').all()).to.deep.equal([]);
	});

	it('getChangedTuples/getChangedKeyTuples round-trip a bigint PK as a bigint', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('BEGIN');
		await db.exec(`INSERT INTO t VALUES (${BIG.toString()}, 'x')`);

		const keyTuples = db.getChangedKeyTuples('main.t');
		expect(keyTuples).to.have.length(1);
		expect(keyTuples[0][0]).to.equal(BIG); // still a bigint, exact value

		const tuples = db.getChangedTuples('main.t', [0], [0]);
		expect(tuples).to.deep.equal([[BIG]]);

		await db.exec('ROLLBACK');
	});
});
