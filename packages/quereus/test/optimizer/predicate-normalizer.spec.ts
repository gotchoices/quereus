import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Predicate normalizer', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER NULL, b INTEGER NULL, c TEXT NULL) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 10, 20, 'x'), (2, 20, 10, 'y'), (3, 30, 30, 'z'), (4, 40, null, null), (5, null, 50, 'w')");
	});

	afterEach(async () => {
		await db.close();
	});

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as T);
		}
		return rows;
	}

	// --- De Morgan's law ---

	it('De Morgan AND: NOT (a > 10 AND b > 10) returns correct rows', async () => {
		// NOT (a > 10 AND b > 10) should become (a <= 10 OR b <= 10)
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT (a > 10 AND b > 10) ORDER BY id"
		);
		// Row 1: a=10 (<=10), b=20 → true (a<=10 satisfied)
		// Row 2: a=20, b=10 (<=10) → true (b<=10 satisfied)
		// Row 3: a=30, b=30 → false (both >10)
		// Row 4: a=40, b=null → null OR null → null (excluded)
		// Row 5: a=null, b=50 → null OR false → null (excluded)
		expect(rows.map(r => r.id)).to.deep.equal([1, 2]);
	});

	it('De Morgan OR: NOT (a = 10 OR a = 20) returns correct rows', async () => {
		// NOT (a = 10 OR a = 20) should become (a != 10 AND a != 20)
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT (a = 10 OR a = 20) ORDER BY id"
		);
		// Row 3: a=30 → yes
		// Row 4: a=40 → yes
		// Row 5: a=null → null (excluded)
		expect(rows.map(r => r.id)).to.deep.equal([3, 4]);
	});

	// --- Double negation elimination ---

	it('double negation: NOT NOT (a > 10) equals a > 10', async () => {
		const direct = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE a > 10 ORDER BY id"
		);
		const doubleNot = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT NOT (a > 10) ORDER BY id"
		);
		expect(doubleNot).to.deep.equal(direct);
		expect(direct.map(r => r.id)).to.deep.equal([2, 3, 4]);
	});

	// --- NOT pushdown on comparisons ---

	it('NOT (a > 10) inverts to a <= 10', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT (a > 10) ORDER BY id"
		);
		// a <= 10: row 1 (a=10). Row 5 (a=null) excluded by three-valued logic
		expect(rows.map(r => r.id)).to.deep.equal([1]);
	});

	it('NOT (a >= 20) inverts to a < 20', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT (a >= 20) ORDER BY id"
		);
		// a < 20: row 1 (a=10)
		expect(rows.map(r => r.id)).to.deep.equal([1]);
	});

	it('NOT (a < 30) inverts to a >= 30', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT (a < 30) ORDER BY id"
		);
		// a >= 30: row 3 (a=30), row 4 (a=40)
		expect(rows.map(r => r.id)).to.deep.equal([3, 4]);
	});

	it('NOT (a <= 10) inverts to a > 10', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT (a <= 10) ORDER BY id"
		);
		// a > 10: row 2 (a=20), row 3 (a=30), row 4 (a=40)
		expect(rows.map(r => r.id)).to.deep.equal([2, 3, 4]);
	});

	// --- OR flattening ---

	it('OR flattening: (a = 10 OR a = 20) OR a = 30', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE (a = 10 OR a = 20) OR a = 30 ORDER BY id"
		);
		expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3]);
	});

	// --- OR-to-IN collapse ---

	it('OR-to-IN collapse: a = 10 OR a = 20 OR a = 30 returns correct results', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE a = 10 OR a = 20 OR a = 30 ORDER BY id"
		);
		expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3]);
	});

	it('OR-to-IN collapse: plan uses IN rather than multiple OR filters', async () => {
		const q = "SELECT id FROM t WHERE a = 10 OR a = 20 OR a = 30";
		const planRows = await allRows<{ op: string; detail: string }>(
			`SELECT op, detail FROM query_plan('${q}')`
		);
		// After OR-to-IN collapse, there should be no standalone OR node in the plan.
		// We expect an IN-based filter or index seek instead of separate equality checks.
		const ops = planRows.map(r => r.op);
		const hasOr = ops.some(op => op === 'OR');
		expect(hasOr).to.be.false;
	});

	// --- AND flattening ---

	it('AND flattening: nested ANDs produce correct results', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE (a > 5 AND b > 5) AND a < 35 ORDER BY id"
		);
		// a > 5 AND b > 5 AND a < 35:
		// Row 1: a=10>5, b=20>5, a=10<35 → yes
		// Row 2: a=20>5, b=10>5, a=20<35 → yes
		// Row 3: a=30>5, b=30>5, a=30<35 → yes
		// Row 4: a=40>5, b=null, a=40 not <35 → no
		expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3]);
	});

	// --- NOT BETWEEN ---

	it('NOT BETWEEN returns rows outside range', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT (a BETWEEN 20 AND 30) ORDER BY id"
		);
		// a NOT BETWEEN 20 AND 30 → a < 20 OR a > 30
		// Row 1: a=10 → yes
		// Row 4: a=40 → yes
		// Row 5: a=null → excluded
		expect(rows.map(r => r.id)).to.deep.equal([1, 4]);
	});

	// --- Deeply nested De Morgan ---

	it('deeply nested De Morgan: NOT (NOT (a > 10) AND NOT (b > 10)) simplifies to a > 10 OR b > 10', async () => {
		const nested = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT (NOT (a > 10) AND NOT (b > 10)) ORDER BY id"
		);
		const direct = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE a > 10 OR b > 10 ORDER BY id"
		);
		expect(nested).to.deep.equal(direct);
		// a > 10 OR b > 10:
		// Row 1: a=10 (no), b=20 (yes) → yes
		// Row 2: a=20 (yes) → yes
		// Row 3: a=30 (yes) → yes
		// Row 4: a=40 (yes), b=null → yes (a>10 is true)
		// Row 5: a=null, b=50 (yes) → yes
		expect(direct.map(r => r.id)).to.deep.equal([1, 2, 3, 4, 5]);
	});

	// --- NULL handling ---

	it('NOT (a IS NULL) returns only non-null rows', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE NOT (a IS NULL) ORDER BY id"
		);
		// Rows with non-null a: 1, 2, 3, 4
		expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3, 4]);
	});

	// --- Edge cases with three-valued logic ---

	it('tautology-like: a > 10 OR NOT (a > 10) excludes NULLs due to three-valued logic', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE a > 10 OR NOT (a > 10) ORDER BY id"
		);
		// For non-null a: always true. For null a: NULL OR NULL → NULL (excluded)
		expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3, 4]);
	});

	it('contradiction-like: a > 10 AND NOT (a > 10) returns empty', async () => {
		const rows = await allRows<{ id: number }>(
			"SELECT id FROM t WHERE a > 10 AND NOT (a > 10) ORDER BY id"
		);
		expect(rows).to.have.lengthOf(0);
	});
});
