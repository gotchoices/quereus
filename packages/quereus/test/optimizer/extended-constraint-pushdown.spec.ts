import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Extended constraint pushdown', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setupTable(): Promise<void> {
		await db.exec(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				category TEXT NULL,
				value REAL NOT NULL
			) USING memory
		`);
		await db.exec(`
			INSERT INTO items VALUES
				(1, 'Alpha', 'A', 10.0),
				(2, 'Beta', 'B', 20.0),
				(3, 'Gamma', NULL, 30.0),
				(4, 'Delta', 'A', 40.0),
				(5, 'Epsilon', NULL, 50.0)
		`);
	}

	// ---- IS NULL / IS NOT NULL ----

	describe('IS NULL on NOT NULL column', () => {
		it('returns empty result for IS NULL on PK column', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT * FROM items WHERE id IS NULL")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(0);
		});

		it('returns empty result for IS NULL on NOT NULL column', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT * FROM items WHERE name IS NULL")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(0);
		});
	});

	describe('IS NOT NULL on NOT NULL column', () => {
		it('returns all rows for IS NOT NULL on PK column', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT * FROM items WHERE id IS NOT NULL")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(5);
		});

		it('returns all rows for IS NOT NULL on NOT NULL column', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT * FROM items WHERE name IS NOT NULL")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(5);
		});
	});

	describe('IS NULL / IS NOT NULL on nullable column', () => {
		it('returns rows where nullable column IS NULL', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE category IS NULL ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(2);
			expect(rows[0].id).to.equal(3);
			expect(rows[1].id).to.equal(5);
		});

		it('returns rows where nullable column IS NOT NULL', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE category IS NOT NULL ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(3);
			expect(rows[0].id).to.equal(1);
			expect(rows[1].id).to.equal(2);
			expect(rows[2].id).to.equal(4);
		});
	});

	// ---- IN ----

	describe('IN constraint on PK', () => {
		it('returns correct rows for IN on PK column', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id, name FROM items WHERE id IN (1, 3, 5) ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(3);
			expect(rows[0].id).to.equal(1);
			expect(rows[0].name).to.equal('Alpha');
			expect(rows[1].id).to.equal(3);
			expect(rows[1].name).to.equal('Gamma');
			expect(rows[2].id).to.equal(5);
			expect(rows[2].name).to.equal('Epsilon');
		});

		it('returns correct rows for single-value IN', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE id IN (2)")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(1);
			expect(rows[0].id).to.equal(2);
		});

		it('returns empty result for IN with no matching values', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT * FROM items WHERE id IN (99, 100)")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(0);
		});
	});

	describe('IN combined with other constraints', () => {
		it('combines IN with additional WHERE clause', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE id IN (1, 2, 3, 4) AND value > 25 ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(2);
			expect(rows[0].id).to.equal(3);
			expect(rows[1].id).to.equal(4);
		});
	});

	// ---- Combined IS NULL + other constraints ----

	describe('IS NULL combined with other constraints', () => {
		it('IS NULL on PK combined with other filter returns empty', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT * FROM items WHERE id IS NULL AND name = 'Alpha'")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(0);
		});

		it('IS NOT NULL on PK with IN still works', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE id IS NOT NULL AND id IN (2, 4) ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(2);
			expect(rows[0].id).to.equal(2);
			expect(rows[1].id).to.equal(4);
		});
	});

	// ---- Plan-level optimization verification ----

	describe('IS NULL index-level optimization', () => {
		async function getPlanNodeTypes(sql: string): Promise<string[]> {
			const planRows: ResultRow[] = [];
			for await (const r of db.eval(`SELECT node_type FROM query_plan('${sql.replace(/'/g, "''")}')`)) {
				planRows.push(r);
			}
			return planRows.map(r => String(r.node_type));
		}

		it('uses EmptyResult node for IS NULL on PK column', async () => {
			await setupTable();
			const nodeTypes = await getPlanNodeTypes('SELECT * FROM items WHERE id IS NULL');
			expect(nodeTypes).to.include('EmptyResult');
			expect(nodeTypes).not.to.include('SeqScan');
		});

		it('uses EmptyResult node for IS NULL on non-PK NOT NULL column', async () => {
			await setupTable();
			const nodeTypes = await getPlanNodeTypes('SELECT * FROM items WHERE name IS NULL');
			expect(nodeTypes).to.include('EmptyResult');
		});

		it('does NOT use EmptyResult for IS NULL on nullable column', async () => {
			await setupTable();
			const nodeTypes = await getPlanNodeTypes('SELECT * FROM items WHERE category IS NULL');
			expect(nodeTypes).not.to.include('EmptyResult');
		});

		it('uses EmptyResult when IS NULL on NOT NULL is combined with AND', async () => {
			await setupTable();
			const nodeTypes = await getPlanNodeTypes('SELECT * FROM items WHERE value IS NULL AND id = 1');
			expect(nodeTypes).to.include('EmptyResult');
		});

		it('IS NOT NULL on NOT NULL column does not produce EmptyResult', async () => {
			await setupTable();
			const nodeTypes = await getPlanNodeTypes('SELECT * FROM items WHERE id IS NOT NULL');
			expect(nodeTypes).not.to.include('EmptyResult');
		});
	});

	// ---- OR predicate support ----

	describe('OR predicates', () => {
		it('returns correct rows for OR of equalities on PK', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE id = 1 OR id = 3 ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(2);
			expect(rows[0].id).to.equal(1);
			expect(rows[1].id).to.equal(3);
		});

		it('returns correct rows for three-way OR of equalities on PK', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE id = 1 OR id = 3 OR id = 5 ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(3);
			expect(rows[0].id).to.equal(1);
			expect(rows[1].id).to.equal(3);
			expect(rows[2].id).to.equal(5);
		});

		it('returns correct rows for OR of equalities on non-PK column', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE category = 'A' OR category = 'B' ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(3);
			expect(rows[0].id).to.equal(1);
			expect(rows[1].id).to.equal(2);
			expect(rows[2].id).to.equal(4);
		});

		it('returns correct rows for OR on different columns (residual filter)', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE id = 1 OR name = 'Beta' ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(2);
			expect(rows[0].id).to.equal(1);
			expect(rows[1].id).to.equal(2);
		});

		it('returns correct rows for OR combined with AND', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE (id = 1 OR id = 3 OR id = 5) AND value > 25 ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(2);
			expect(rows[0].id).to.equal(3);
			expect(rows[1].id).to.equal(5);
		});

		it('handles OR with range predicate as residual correctly', async () => {
			await setupTable();
			const rows: ResultRow[] = [];
			for await (const r of db.eval("SELECT id FROM items WHERE id > 3 OR id < 2 ORDER BY id")) {
				rows.push(r);
			}
			expect(rows).to.have.lengthOf(3);
			expect(rows[0].id).to.equal(1);
			expect(rows[1].id).to.equal(4);
			expect(rows[2].id).to.equal(5);
		});
	});

	// ---- OR plan-level optimization verification ----

	describe('OR plan-level optimization', () => {
		async function getPlanNodeTypes(sql: string): Promise<string[]> {
			const planRows: ResultRow[] = [];
			for await (const r of db.eval(`SELECT node_type FROM query_plan('${sql.replace(/'/g, "''")}')`)) {
				planRows.push(r);
			}
			return planRows.map(r => String(r.node_type));
		}

		it('uses IndexSeek for OR of equalities on PK (normalizer collapses to IN)', async () => {
			await setupTable();
			const nodeTypes = await getPlanNodeTypes('SELECT * FROM items WHERE id = 1 OR id = 3');
			expect(nodeTypes).to.include('IndexSeek');
			expect(nodeTypes).not.to.include('SeqScan');
		});

		it('uses IndexSeek for three-way OR of equalities on PK', async () => {
			await setupTable();
			const nodeTypes = await getPlanNodeTypes('SELECT * FROM items WHERE id = 1 OR id = 3 OR id = 5');
			expect(nodeTypes).to.include('IndexSeek');
			expect(nodeTypes).not.to.include('SeqScan');
		});

		it('does not use IndexSeek for OR on different columns', async () => {
			await setupTable();
			const nodeTypes = await getPlanNodeTypes("SELECT * FROM items WHERE id = 1 OR name = 'Beta'");
			// Should fall back to scan + filter since columns differ
			expect(nodeTypes).not.to.include('IndexSeek');
		});
	});
});
