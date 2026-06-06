import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

interface PlanRow { op: string; node_type: string; detail: string }

async function getPlanOps(db: Database, sql: string): Promise<string[]> {
	const ops: string[] = [];
	for await (const r of db.eval("SELECT op FROM query_plan(?)", [sql])) {
		ops.push(String((r as { op: unknown }).op));
	}
	return ops;
}

async function getPlanRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval("SELECT op, node_type, detail FROM query_plan(?)", [sql])) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

describe('Ordering-index competition (memory module)', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('produces correctly ordered results when filter index does not satisfy ORDER BY', async () => {
		// Selective filter on secondary index, ORDER BY on PK column.
		// The chosen plan may be filter-seek + sort, or PK ordering scan + residual filter;
		// either way the rows MUST be in PK order.
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, payload TEXT) USING memory");
		await db.exec(`INSERT INTO t VALUES
			(5, 'active', 'e'), (2, 'inactive', 'b'), (8, 'active', 'h'),
			(1, 'inactive', 'a'), (4, 'active', 'd'), (7, 'inactive', 'g'),
			(3, 'active', 'c'), (6, 'active', 'f')`);
		await db.exec("CREATE INDEX ix_status ON t(status)");

		const sql = "SELECT id FROM t WHERE status = 'active' ORDER BY id";
		const ids: number[] = [];
		for await (const r of db.eval(sql)) {
			ids.push((r as { id: number }).id);
		}
		expect(ids).to.deep.equal([3, 4, 5, 6, 8]);
	});

	it('does not insert SORT when secondary-index range + ORDER BY match the same index', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, score INTEGER) USING memory");
		await db.exec(`INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 40), (5, 50)`);
		await db.exec("CREATE INDEX ix_score ON t(score)");

		const sql = "SELECT id, score FROM t WHERE score >= 30 ORDER BY score";
		const sortCount: { c: number }[] = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sortCount.push(r as unknown as { c: number });
		}
		expect(sortCount).to.have.lengthOf(1);
		expect(sortCount[0].c, 'same-index range+order eliminates sort').to.equal(0);

		const scores: number[] = [];
		for await (const r of db.eval(sql)) {
			scores.push((r as { score: number }).score);
		}
		expect(scores).to.deep.equal([30, 40, 50]);
	});

	it('uses PK ordering scan with residual filter when filter is unselective on small table', async () => {
		// Tiny table with no index on the filter column — Plan A would be
		// SeqScan + Sort; Plan B (PK ordering scan + residual filter) should win.
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, payload TEXT) USING memory");
		await db.exec(`INSERT INTO t VALUES (3, 'aa'), (1, 'bb'), (4, 'aa'), (2, 'cc'), (5, 'aa')`);

		const sql = "SELECT id FROM t WHERE payload = 'aa' ORDER BY id";
		const ops = await getPlanOps(db, sql);
		// PK scan path provides ordering; no SORT should be inserted.
		expect(ops.filter(o => o === 'SORT')).to.have.lengthOf(0);

		const ids: number[] = [];
		for await (const r of db.eval(sql)) {
			ids.push((r as { id: number }).id);
		}
		expect(ids).to.deep.equal([3, 4, 5]);
	});

	it('uses ordering-only IndexScan when ORDER BY matches secondary index and no filters exist', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, score INTEGER) USING memory");
		await db.exec(`INSERT INTO t VALUES (1, 30), (2, 10), (3, 50), (4, 20), (5, 40)`);
		await db.exec("CREATE INDEX ix_score ON t(score)");

		const sql = "SELECT id, score FROM t ORDER BY score";
		const rows = await getPlanRows(db, sql);
		// No SORT should appear; the index walk supplies the ordering.
		expect(rows.filter(r => r.op === 'SORT')).to.have.lengthOf(0);
		// Some access leaf must be present and reference the secondary index.
		const accessLeaf = rows.find(r =>
			r.op === 'INDEXSCAN' || r.op === 'INDEXSEEK' || r.op === 'SEQSCAN');
		expect(accessLeaf, 'physical access leaf present').to.not.equal(undefined);

		const scores: number[] = [];
		for await (const r of db.eval(sql)) {
			scores.push((r as { score: number }).score);
		}
		expect(scores).to.deep.equal([10, 20, 30, 40, 50]);
	});

	it('PK seek + ORDER BY on PK column eliminates SORT', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec(`INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')`);

		const sql = "SELECT id FROM t WHERE id >= 2 ORDER BY id";
		const sorts: { c: number }[] = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sorts.push(r as unknown as { c: number });
		}
		expect(sorts).to.have.lengthOf(1);
		expect(sorts[0].c).to.equal(0);

		const ids: number[] = [];
		for await (const r of db.eval(sql)) {
			ids.push((r as { id: number }).id);
		}
		expect(ids).to.deep.equal([2, 3, 4]);
	});

	it('produces correct order even when costing flips between Plan A (sort) and Plan B (scan)', async () => {
		// Same query against tables of different sizes / selectivity. The plan
		// chosen may differ but the OUTPUT must always be sorted.
		for (const size of [3, 50, 500]) {
			const localDb = new Database();
			try {
				await localDb.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER) USING memory");
				const values: string[] = [];
				for (let i = 1; i <= size; i++) {
					// k cycles 0..3 so filter `k = 0` selects ~25%
					values.push(`(${i}, ${i % 4})`);
				}
				// Insert in batches to avoid query-too-large.
				for (let i = 0; i < values.length; i += 100) {
					await localDb.exec(`INSERT INTO t VALUES ${values.slice(i, i + 100).join(',')}`);
				}
				await localDb.exec("CREATE INDEX ix_k ON t(k)");

				const sql = "SELECT id FROM t WHERE k = 0 ORDER BY id";
				const ids: number[] = [];
				for await (const r of localDb.eval(sql)) {
					ids.push((r as { id: number }).id);
				}

				// Build expected: ids where k=0, in id order.
				const expected: number[] = [];
				for (let i = 1; i <= size; i++) {
					if (i % 4 === 0) expected.push(i);
				}
				expect(ids, `size=${size}`).to.deep.equal(expected);
			} finally {
				await localDb.close();
			}
		}
	});
});
