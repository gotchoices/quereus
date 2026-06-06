import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Plan shape decisions', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function queryPlanOps(sql: string): Promise<string[]> {
		const ops: string[] = [];
		for await (const r of db.eval("SELECT op FROM query_plan(?)", [sql])) {
			ops.push((r as { op: string }).op);
		}
		return ops;
	}

	async function queryPlanDetails(sql: string): Promise<Array<{ op: string; detail: string }>> {
		const rows: Array<{ op: string; detail: string }> = [];
		for await (const r of db.eval("SELECT op, detail FROM query_plan(?)", [sql])) {
			rows.push(r as { op: string; detail: string });
		}
		return rows;
	}

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as T);
		}
		return rows;
	}

	// ── Predicate pushdown ─────────────────────────────────────────────

	describe('Predicate pushdown', () => {
		async function setupJoinTables(): Promise<void> {
			await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, val INTEGER, name TEXT) USING memory");
			await db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, aid INTEGER, label TEXT) USING memory");
			await db.exec("INSERT INTO a VALUES (1, 5, 'lo'), (2, 15, 'mid'), (3, 25, 'hi')");
			await db.exec("INSERT INTO b VALUES (10, 1, 'x'), (20, 2, 'y'), (30, 3, 'z')");
		}

		it('filter on join produces correct results and contains expected plan nodes', async () => {
			await setupJoinTables();
			const q = "SELECT * FROM a JOIN b ON a.id = b.aid WHERE a.val > 10";

			// Correctness: only rows where a.val > 10 should appear
			const results = await allRows<{ id: number; val: number; name: string; label: string }>(q);
			expect(results.length).to.be.greaterThanOrEqual(1);
			for (const row of results) {
				expect(row.val).to.be.greaterThan(10);
			}

			// Plan shape: should contain both a join and a filter node
			const ops = await queryPlanOps(q);
			const hasJoin = ops.some(op => op.includes('JOIN'));
			const hasFilter = ops.includes('FILTER');
			expect(hasJoin).to.equal(true, 'Plan should contain a JOIN node');
			expect(hasFilter).to.equal(true, 'Plan should contain a FILTER node for val > 10');
		});

		it('PK predicate pushed through view eliminates FILTER node', async () => {
			await setupJoinTables();
			await db.exec("CREATE VIEW va AS SELECT id, val, name FROM a");
			const q = "SELECT * FROM va WHERE id = 2";

			// Correctness
			const results = await allRows<{ id: number; val: number; name: string }>(q);
			expect(results).to.have.lengthOf(1);
			expect(results[0].name).to.equal('mid');
			expect(results[0].val).to.equal(15);

			// Plan shape: the PK predicate should be pushed all the way through the
			// view boundary into an INDEXSEEK, with no residual FILTER node.
			const ops = await queryPlanOps(q);
			expect(ops).to.include('INDEXSEEK', 'PK predicate through view should become INDEXSEEK');
			expect(ops).to.not.include('FILTER', 'No residual FILTER after PK pushdown through view');

			await db.exec("DROP VIEW va");
		});

		it('non-PK predicate pushed through view has no ALIAS above FILTER', async () => {
			await setupJoinTables();
			await db.exec("CREATE VIEW va AS SELECT id, val, name FROM a");
			const q = "SELECT * FROM va WHERE val > 10";

			// Correctness
			const results = await allRows<{ id: number; val: number; name: string }>(q);
			expect(results.length).to.be.greaterThanOrEqual(1);
			for (const row of results) {
				expect(row.val).to.be.greaterThan(10);
			}

			// Plan shape: the filter should be pushed through the alias boundary.
			// The ALIAS node should not appear above the FILTER — it should be eliminated.
			const details = await queryPlanDetails(q);
			const aliasIdx = details.findIndex(r => r.op === 'ALIAS');
			expect(aliasIdx).to.equal(-1, 'ALIAS node should be eliminated after predicate pushdown');

			await db.exec("DROP VIEW va");
		});
	});

	// ── CTE materialization decisions ──────────────────────────────────

	describe('CTE materialization decisions', () => {
		async function setupCteTable(): Promise<void> {
			await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
			await db.exec("INSERT INTO items VALUES (1, 10), (2, 20), (3, 30)");
		}

		it('CTE referenced once is inlined (no CACHE node)', async () => {
			await setupCteTable();
			const q = "WITH cte AS (SELECT id, val FROM items WHERE val >= 20) SELECT * FROM cte";

			// Correctness
			const results = await allRows<{ id: number; val: number }>(q);
			expect(results).to.have.lengthOf(2);
			const vals = results.map(r => r.val).sort((a, b) => a - b);
			expect(vals).to.deep.equal([20, 30]);

			// Plan shape: a single-reference simple CTE should be inlined (no CACHE node).
			const ops = await queryPlanOps(q);
			expect(ops).to.include('CTEREFERENCE');
			expect(ops).to.not.include('CACHE', 'Single-use simple CTE should be inlined, not cached');
		});

		it('CTE referenced multiple times produces correct results', async () => {
			await setupCteTable();
			const q = "WITH cte AS (SELECT id, val FROM items) SELECT cte.id, c2.val FROM cte JOIN cte AS c2 ON cte.id = c2.id";

			// Correctness: self-join on id=id produces same rows as the original table
			const results = await allRows<{ id: number; val: number }>(q);
			expect(results).to.have.lengthOf(3);
			const ids = results.map(r => r.id).sort((a, b) => a - b);
			expect(ids).to.deep.equal([1, 2, 3]);

			// Plan shape: should contain multiple CTE references and a join
			const ops = await queryPlanOps(q);
			const cteRefCount = ops.filter(op => op === 'CTEREFERENCE').length;
			expect(cteRefCount).to.equal(2, 'Should have two CTE reference nodes');
			expect(ops.some(op => op.includes('JOIN'))).to.equal(true, 'Should contain a JOIN node');
		});

		it('recursive CTE produces correct sequence', async () => {
			const q = `
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION ALL
					SELECT x + 1 FROM cnt WHERE x < 5
				)
				SELECT x FROM cnt ORDER BY x
			`;

			const results = await allRows<{ x: number }>(q);
			expect(results).to.have.lengthOf(5);
			expect(results.map(r => r.x)).to.deep.equal([1, 2, 3, 4, 5]);

			// Plan shape: should include a RECURSIVECTE node
			const ops = await queryPlanOps(q);
			expect(ops).to.include('RECURSIVECTE', 'Recursive CTE should produce a RECURSIVECTE plan node');
		});
	});

	// ── Limit/Offset behavior ──────────────────────────────────────────

	describe('Limit/Offset behavior', () => {
		async function setupLimitTable(): Promise<void> {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
			await db.exec("INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 40), (5, 50)");
		}

		it('LIMIT preserves ordering from source', async () => {
			await setupLimitTable();
			const q = "SELECT * FROM t ORDER BY id LIMIT 3";

			const results = await allRows<{ id: number; val: number }>(q);
			expect(results).to.have.lengthOf(3);
			expect(results.map(r => r.id)).to.deep.equal([1, 2, 3]);

			// Plan shape: should include a LIMITOFFSET node
			const ops = await queryPlanOps(q);
			expect(ops).to.include('LIMITOFFSET');
		});

		it('LIMIT with OFFSET returns correct window', async () => {
			await setupLimitTable();
			const q = "SELECT * FROM t ORDER BY id LIMIT 2 OFFSET 2";

			const results = await allRows<{ id: number; val: number }>(q);
			expect(results).to.have.lengthOf(2);
			expect(results.map(r => r.id)).to.deep.equal([3, 4]);
		});

		it('LIMIT 0 returns empty result', async () => {
			await setupLimitTable();
			const q = "SELECT * FROM t LIMIT 0";

			const results = await allRows<{ id: number; val: number }>(q);
			expect(results).to.have.lengthOf(0);

			// Plan shape: still produces a LIMITOFFSET node
			const ops = await queryPlanOps(q);
			expect(ops).to.include('LIMITOFFSET');
		});

		it('OFFSET beyond row count returns empty result', async () => {
			await setupLimitTable();
			const q = "SELECT * FROM t ORDER BY id LIMIT 10 OFFSET 1000";

			const results = await allRows<{ id: number; val: number }>(q);
			expect(results).to.have.lengthOf(0);
		});
	});

	// ── Delete node behavior ───────────────────────────────────────────

	describe('Delete node behavior', () => {
		async function setupDeleteTable(): Promise<void> {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
			await db.exec("INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 40)");
		}

		it('DELETE with WHERE removes matching rows only', async () => {
			await setupDeleteTable();
			await db.exec("DELETE FROM t WHERE val > 20");

			const remaining = await allRows<{ id: number; val: number }>("SELECT * FROM t ORDER BY id");
			expect(remaining).to.have.lengthOf(2);
			expect(remaining.map(r => r.id)).to.deep.equal([1, 2]);
			for (const row of remaining) {
				expect(row.val).to.be.at.most(20);
			}

			// Plan shape: DELETE statement plan should contain a DELETE op
			const ops = await queryPlanOps("DELETE FROM t WHERE val > 20");
			expect(ops).to.include('DELETE');
			expect(ops).to.include('FILTER', 'DELETE with WHERE should have a FILTER node');
		});

		it('DELETE all rows empties the table', async () => {
			await setupDeleteTable();
			await db.exec("DELETE FROM t");

			const remaining = await allRows<{ id: number; val: number }>("SELECT * FROM t");
			expect(remaining).to.have.lengthOf(0);
		});
	});

	// ── Table function call ────────────────────────────────────────────

	describe('Table function call', () => {
		it('query_plan() returns non-empty results', async () => {
			const results = await allRows<{ op: string }>("SELECT op FROM query_plan('SELECT 1')");
			expect(results.length).to.be.greaterThan(0);

			// Should contain at least a BLOCK node
			const ops = results.map(r => r.op);
			expect(ops).to.include('BLOCK');
		});

		it('schema() returns non-empty results after table creation', async () => {
			await db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY) USING memory");

			const results = await allRows<{ name: string; type: string }>("SELECT * FROM schema()");
			expect(results.length).to.be.greaterThan(0);

			// Should include the table we just created
			const tableEntries = results.filter(r => r.type === 'table' && r.name === 'probe');
			expect(tableEntries).to.have.lengthOf(1);

			// The plan for a schema() call should include a TABLEFUNCTIONCALL node
			const ops = await queryPlanOps("SELECT * FROM schema()");
			expect(ops).to.include('TABLEFUNCTIONCALL');

			await db.exec("DROP TABLE probe");
		});
	});
});
