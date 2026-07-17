import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Statement } from '../../src/core/statement.js';
import { CountingMemoryModule } from './_counting-memory-module.js';
import type { OptimizerTuning } from '../../src/planner/optimizer-tuning.js';

/**
 * Runtime execution-count checks for the uncorrelated IN-subquery cache.
 *
 * `ruleInSubqueryCache` wraps an uncorrelated `x IN (subquery)` source in an
 * EAGER CacheNode so the subquery runs once and later outer rows replay from the
 * buffer. Before the eager fix, `emitIn` returned on the first matching row,
 * which aborted the streaming cache build mid-drain so `cachedResult` was never
 * committed — every outer row re-opened the subquery source from scratch. When
 * every outer row matches (the worst case), that was one source scan per outer
 * row. Eager mode drains + commits the buffer before yielding, so the first-match
 * short-circuit can no longer defeat the cache.
 *
 * These tests assert on `scanCounts.get('counting')` — the number of `query()`
 * opens on the subquery source table.
 */
describe('IN-subquery cache: scan count', () => {
	let db: Database;
	let module: CountingMemoryModule;

	beforeEach(async () => {
		db = new Database();
		module = new CountingMemoryModule();
		db.registerModule('countmem', module);
		// Subquery source table.
		await db.exec("CREATE TABLE counting (k INTEGER PRIMARY KEY) USING countmem()");
		await db.exec("INSERT INTO counting VALUES (1), (2), (3)");
		// Outer / probe relation that drives per-row IN evaluation. `x` is nullable
		// so the null-condition variant can exercise a NULL IN-expression.
		await db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, x INTEGER NULL) USING countmem()");
	});

	afterEach(async () => {
		await db.close();
	});

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) rows.push(r as T);
		return rows;
	}

	it('scans the subquery source exactly once when every outer row matches', async () => {
		// Every probe.x ∈ {1,2,3} matches counting {1,2,3}, so IN short-circuits
		// on the first match for every outer row — the exact case that defeated the
		// streaming cache before the eager fix.
		await db.exec("INSERT INTO probe VALUES (1, 1), (2, 2), (3, 3)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe where x in (select k from counting) order by id'
		);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(module.scanCounts.get('counting'),
			'eager cache must build once and replay; a match-heavy outer relation must not re-scan the source'
		).to.equal(1);
	});

	it('still scans once when a leading NULL-condition outer row precedes matches', async () => {
		// A NULL IN-expression makes emitIn return NULL WITHOUT iterating the source,
		// so that eval drives no scan; the cache builds lazily on the first eval that
		// actually iterates. Total scans stay 1 regardless of row order.
		await db.exec("INSERT INTO probe VALUES (1, NULL), (2, 2), (3, 3)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe where x in (select k from counting) order by id'
		);
		// The NULL row yields NULL (excluded by WHERE); the two matches survive.
		expect(rows).to.deep.equal([{ id: 2 }, { id: 3 }]);
		expect(module.scanCounts.get('counting'),
			'a null-condition leading row drives no scan; the cache still builds exactly once'
		).to.equal(1);
	});

	it('re-scans per outer row when the source exceeds the cache threshold', async () => {
		// Force the CacheNode threshold below the source size: eager buffers up to
		// the threshold, then abandons and streams the remainder through. An
		// abandoned cache streams fresh on every subsequent eval, so the scan count
		// intentionally rises to N (one per outer row). This documents that the
		// memory bound — not caching — wins past the threshold.
		const base = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...base,
			cte: { ...base.cte, maxCacheThreshold: 2 },
		} as OptimizerTuning);

		await db.exec("INSERT INTO probe VALUES (1, 1), (2, 2), (3, 3)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe where x in (select k from counting) order by id'
		);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
		// counting has 3 rows > threshold 2 → cache abandoned → one scan per outer row.
		expect(module.scanCounts.get('counting'),
			'over-threshold source is not cached; each of the 3 outer rows re-scans'
		).to.equal(3);
	});

	it('re-materializes per execution of a prepared statement (once each run, never zero)', async () => {
		await db.exec("INSERT INTO probe VALUES (1, 1), (2, 2), (3, 3)");
		const stmt: Statement = db.prepare(
			'select id from probe where x in (select k from counting) order by id'
		);
		try {
			module.scanCounts.clear();
			const run1: Record<string, unknown>[] = [];
			for await (const row of stmt.all()) run1.push(row);
			expect(run1).to.have.lengthOf(3);
			expect(module.scanCounts.get('counting'), 'first execution scans once').to.equal(1);

			// A fresh RuntimeContext per execution means a fresh eager build — not a
			// stale replay of run 1, and not zero scans.
			module.scanCounts.clear();
			const run2: Record<string, unknown>[] = [];
			for await (const row of stmt.all()) run2.push(row);
			expect(run2).to.have.lengthOf(3);
			expect(module.scanCounts.get('counting'), 'second execution re-builds the cache once').to.equal(1);
		} finally {
			await stmt.finalize();
		}
	});
});
