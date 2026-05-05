import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Ordering propagation', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')");
	}

	it('Project remaps ordering column indices through projection reordering', async () => {
		await setup();

		const sql = "SELECT v, id FROM (SELECT id, v FROM t ORDER BY id) s";
		const rows: Array<{ physical: string | null; detail: string }> = [];
		for await (const r of db.eval("SELECT physical, detail FROM query_plan(?) WHERE op = 'PROJECT'", [sql])) {
			rows.push(r as unknown as { physical: string | null; detail: string });
		}

		const outer = rows.find(r => String(r.detail).includes('SELECT v, id'));
		expect(outer, 'expected outer PROJECT node to be present').to.not.equal(undefined);
		expect(outer!.physical).to.be.a('string');

		const physical = JSON.parse(String(outer!.physical));
		expect(physical).to.have.property('ordering');
		expect(physical.ordering).to.deep.equal([{ column: 1, desc: false }]);
	});

	it('NULLS ordering is preserved in sort plan node', async () => {
		await db.exec("CREATE TABLE tn (id INTEGER PRIMARY KEY, v INTEGER NULL) USING memory");
		await db.exec("INSERT INTO tn VALUES (1, NULL),(2, 3),(3, 1),(4, NULL),(5, 2)");

		// Verify NULLS LAST shows in plan detail
		const sql = "SELECT v FROM tn ORDER BY v NULLS LAST";
		const sortDetails: string[] = [];
		for await (const r of db.eval("SELECT detail FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sortDetails.push(String((r as { detail?: unknown }).detail));
		}
		expect(sortDetails).to.have.lengthOf(1);
		expect(sortDetails[0]).to.include('NULLS LAST');

		// Verify results: non-null sorted ASC, then NULLs at end
		const rows: Array<{ v: number | null }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { v: number | null });
		}
		expect(rows.map(r => r.v)).to.deep.equal([1, 2, 3, null, null]);
	});

	it('NULLS ordering round-trips through plan attributes', async () => {
		await db.exec("CREATE TABLE tn2 (id INTEGER PRIMARY KEY, v INTEGER NULL) USING memory");

		const sql = "SELECT v FROM tn2 ORDER BY v DESC NULLS FIRST";
		const props: string[] = [];
		for await (const r of db.eval("SELECT properties FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			props.push(String((r as { properties?: unknown }).properties));
		}
		expect(props).to.have.lengthOf(1);
		const logical = JSON.parse(props[0]);
		expect(logical.sortKeys).to.be.an('array').with.lengthOf(1);
		expect(logical.sortKeys[0].direction).to.equal('desc');
		expect(logical.sortKeys[0].nulls).to.equal('first');
	});

	it('Streaming aggregate does not insert redundant sort when source already ordered by grouping keys', async () => {
		await setup();

		const sql = "SELECT id, count(*) AS c FROM (SELECT * FROM t ORDER BY id LIMIT ?) s GROUP BY id";
		const sorts: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sorts.push(r as unknown as { c: number });
		}

		const streamAggs: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'STREAMAGGREGATE'", [sql])) {
			streamAggs.push(r as unknown as { c: number });
		}

		expect(streamAggs).to.have.lengthOf(1);
		expect(streamAggs[0].c).to.equal(1);

		expect(sorts).to.have.lengthOf(1);
		expect(sorts[0].c).to.equal(0);
	});
});

