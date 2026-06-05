import { expect } from 'chai';
import * as fc from 'fast-check';
import { Database } from '../src/core/database.js';
import { DEFAULT_TUNING } from '../src/planner/optimizer.js';
import { serializePlanTree } from '../src/planner/debug.js';
import type { SqlValue } from '../src/common/types.js';

/**
 * Equivalence property harness — the soundness backstop for the read-side
 * materialized-view query rewrite. For a corpus of scan-projection-filter queries
 * over a base table with several covering MVs, and random base data (including
 * NULLs and empty results), it asserts:
 *
 *     rewritten(query)  ==  unrewritten(query)         (as multisets)
 *
 * by running each query twice — once with the `materialized-view-rewrite` rule
 * enabled (default) and once with it disabled (`tuning.disabledRules`) — and
 * comparing row-for-row. A false rewrite would surface here as a divergence. This
 * is the harness the aggregate-rollup and join-subsumption phases extend with
 * their shapes (cf. `test/incremental/maintenance-equivalence.spec.ts`).
 */

const REWRITE_OFF = { ...DEFAULT_TUNING, disabledRules: new Set(['materialized-view-rewrite']) };

/** Queries that are answerable from a covering MV (some via a filtered MV that
 *  the cost gate accepts), plus near-misses that must stay row-identical even
 *  though they fall back to the base recompute. NULL-sensitive shapes included. */
const QUERIES: readonly string[] = [
	// Answered by mv_all (full passthrough, no WHERE).
	'select a, b from t order by a',
	'select id, c from t order by id',
	// Answered by mv_pos (a > 0) — residual filtering on top.
	'select a, b from t where a > 0',
	'select a from t where a > 0 and b = 2',
	'select id from t where a > 0 and a < 10',
	// Answered by mv_nn (a is not null) — NULL-skip semantics.
	'select a from t where a is not null',
	'select a, c from t where a is not null and c > 0',
	// Near-misses (no filtered MV covers; fall back to base or a no-win MV).
	'select c from t where a > 0',
	'select b from t where a is null',
	'select a from t where b > 0',
	// Full identity (no-win → cost gate declines, still identical).
	'select id, a, b, c from t',
	// Empty-result and IN / BETWEEN residual shapes.
	'select a from t where a > 0 and b in (1, 2, 3)',
	'select a, b from t where a > 0 and a between 2 and 8',
	'select id from t where a > 1000',
];

/** Queries we additionally assert actually rewrite to a backing scan, so the
 *  harness is not vacuously comparing two identical base recomputes. */
const MUST_REWRITE: readonly string[] = [
	'select a, b from t where a > 0',
	'select a from t where a > 0 and b = 2',
	'select a from t where a is not null',
];

interface RowSpec { id: number; a: number | null; b: number | null; c: number | null }

const valArb = fc.option(fc.integer({ min: -5, max: 12 }), { nil: null });
const rowArb = fc.record({ id: fc.integer({ min: 1, max: 8 }), a: valArb, b: valArb, c: valArb });

function lit(v: number | null): string {
	return v === null ? 'null' : String(v);
}

async function loadRows(db: Database, rows: readonly RowSpec[]): Promise<void> {
	await db.exec('delete from t');
	// Dedup by id (last wins) so the PK insert never conflicts.
	const byId = new Map<number, RowSpec>();
	for (const r of rows) byId.set(r.id, r);
	for (const r of byId.values()) {
		await db.exec(`insert into t (id, a, b, c) values (${r.id}, ${lit(r.a)}, ${lit(r.b)}, ${lit(r.c)})`);
	}
}

async function readMultiset(db: Database, sql: string): Promise<string[]> {
	const out: string[] = [];
	for await (const row of db.eval(sql)) {
		out.push(JSON.stringify(Object.values(row) as SqlValue[], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
	}
	return out.sort();
}

describe('Materialized-view query rewrite — equivalence (rewritten == unrewritten)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table t (id integer primary key, a integer null, b integer null, c integer null);
			create materialized view mv_all as select id, a, b, c from t;
			create materialized view mv_pos as select id, a, b from t where a > 0;
			create materialized view mv_nn as select id, a, c from t where a is not null;
		`);
	});
	afterEach(async () => { await db.close(); });

	it('every covering / near-miss query returns identical rows with the rewrite on vs off', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(rowArb, { minLength: 0, maxLength: 8 }),
			async (rows) => {
				await loadRows(db, rows);
				for (const q of QUERIES) {
					db.optimizer.updateTuning(DEFAULT_TUNING);
					const on = await readMultiset(db, q);
					db.optimizer.updateTuning(REWRITE_OFF);
					const off = await readMultiset(db, q);
					db.optimizer.updateTuning(DEFAULT_TUNING);
					expect(on, `rewrite changed rows for: ${q}`).to.deep.equal(off);
				}
			},
		), { numRuns: 30 });
	});

	it('the harness is non-vacuous: the rewritable queries actually rewrite', () => {
		for (const q of MUST_REWRITE) {
			const plan = serializePlanTree(db.getPlan(q));
			expect(plan, `expected a backing rewrite for: ${q}`).to.match(/_mv_/);
		}
	});
});

/* ── Aggregate-rollup equivalence ────────────────────────────────────────────
 * Extends the harness with the aggregate arm: a grouped MV over (k, j) answering
 * exact-key, rollup-to-k, and global-scalar aggregate queries. The aggregated
 * column `x` is nullable, and the row count starts at 0, so every run exercises the
 * load-bearing NULL/empty cases the rollup recombine must preserve exactly:
 *   - sum over zero rows / all-NULL groups ⇒ NULL (not 0)
 *   - count over zero rows ⇒ 0 (not NULL — the coalesce in the count recombine)
 *   - avg over zero rows / all-NULL ⇒ NULL; otherwise sum/count real division
 * The group key (k, j) is NOT NULL so the backing PK is well-formed; the interesting
 * NULL semantics live in `x`. */

interface AggRow { id: number; k: number; j: number; x: number | null }

const aggValArb = fc.option(fc.integer({ min: -3, max: 6 }), { nil: null });
const aggRowArb = fc.record({
	id: fc.integer({ min: 1, max: 8 }),
	k: fc.integer({ min: -1, max: 2 }),
	j: fc.integer({ min: 0, max: 2 }),
	x: aggValArb,
});

/** Aggregate queries answerable from `amv_kj`: exact-key, rollup-to-k, and global. */
const AGG_QUERIES: readonly string[] = [
	// Exact-key (query key == MV key == {k, j}).
	'select k, j, sum(x) from t group by k, j',
	'select k, j, count(*), count(x) from t group by k, j',
	'select k, j, min(x), max(x), avg(x) from t group by k, j',
	// Exact-key with a range residual on a group-key column (safe: no re-aggregation).
	'select k, j, sum(x) from t where k >= 0 group by k, j',
	// Rollup to the coarser key {k}.
	'select k, sum(x) from t group by k',
	'select k, count(*), count(x) from t group by k',
	'select k, avg(x), min(x), max(x) from t group by k',
	// Global-scalar rollup (the empty/zero-row cases live here).
	'select sum(x) from t',
	'select count(*) from t',
	'select count(x) from t',
	'select avg(x) from t',
	'select min(x), max(x) from t',
];

/** Aggregate queries that must actually rewrite (non-vacuous harness). */
const AGG_MUST_REWRITE: readonly string[] = [
	'select k, j, sum(x) from t group by k, j',
	'select k, sum(x) from t group by k',
	'select sum(x) from t',
	'select count(*) from t',
	'select avg(x) from t',
];

async function loadAggRows(db: Database, rows: readonly AggRow[]): Promise<void> {
	await db.exec('delete from t');
	const byId = new Map<number, AggRow>();
	for (const r of rows) byId.set(r.id, r);
	for (const r of byId.values()) {
		await db.exec(`insert into t (id, k, j, x) values (${r.id}, ${r.k}, ${r.j}, ${lit(r.x)})`);
	}
}

describe('Materialized-view query rewrite — aggregate-rollup equivalence (rewritten == unrewritten)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table t (id integer primary key, k integer not null, j integer not null, x integer null);
			create materialized view amv_kj as
				select k, j, sum(x) as sx, count(*) as c, count(x) as cx, min(x) as mn, max(x) as mx, avg(x) as av
				from t group by k, j;
		`);
	});
	afterEach(async () => { await db.close(); });

	it('every exact-key / rollup / global query returns identical rows with the rewrite on vs off', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(aggRowArb, { minLength: 0, maxLength: 8 }),
			async (rows) => {
				await loadAggRows(db, rows);
				for (const q of AGG_QUERIES) {
					db.optimizer.updateTuning(DEFAULT_TUNING);
					const on = await readMultiset(db, q);
					db.optimizer.updateTuning(REWRITE_OFF);
					const off = await readMultiset(db, q);
					db.optimizer.updateTuning(DEFAULT_TUNING);
					expect(on, `rewrite changed rows for: ${q}`).to.deep.equal(off);
				}
			},
		), { numRuns: 40 });
	});

	it('the harness is non-vacuous: the rewritable aggregate queries actually rewrite', () => {
		for (const q of AGG_MUST_REWRITE) {
			const plan = serializePlanTree(db.getPlan(q));
			expect(plan, `expected a backing rewrite for: ${q}`).to.match(/_mv_/);
		}
	});

	/* The property corpus only emits bare `group by … agg(…)` queries. These deterministic
	 * cases pin the shapes that wrap or nest the rewritten Aggregate — a HAVING / ORDER BY
	 * parent, a computed-over-aggregate top Project, and a subquery wrapper — where the rule
	 * fires on the inner Aggregate and must leave the parent's output (and order) intact. */
	const WRAPPED_QUERIES: readonly string[] = [
		'select k, sum(x) as s from t group by k having sum(x) > 2',          // HAVING over a rollup
		'select k, j, sum(x) as s from t group by k, j having count(*) > 1',  // HAVING over exact-key
		'select k, sum(x) + 1, count(*) * 2 from t group by k',               // computed-over-aggregate parent (rollup)
		'select sum(x) + 100, avg(x), count(*) from t',                       // computed-over-aggregate parent (global)
		'select * from (select k, sum(x) as s from t group by k) z where s is not null', // nested in a subquery
	];

	it('wrapped / nested aggregate fragments stay row-identical with the rewrite on vs off', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(aggRowArb, { minLength: 0, maxLength: 8 }),
			async (rows) => {
				await loadAggRows(db, rows);
				for (const q of WRAPPED_QUERIES) {
					db.optimizer.updateTuning(DEFAULT_TUNING);
					const on = await readMultiset(db, q);
					db.optimizer.updateTuning(REWRITE_OFF);
					const off = await readMultiset(db, q);
					db.optimizer.updateTuning(DEFAULT_TUNING);
					expect(on, `rewrite changed rows for: ${q}`).to.deep.equal(off);
				}
			},
		), { numRuns: 25 });
	});

	it('an ORDER BY over a rollup preserves row order with the rewrite on vs off', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(aggRowArb, { minLength: 0, maxLength: 8 }),
			async (rows) => {
				await loadAggRows(db, rows);
				const q = 'select k, sum(x) as s from t group by k order by k desc';
				db.optimizer.updateTuning(DEFAULT_TUNING);
				const on: string[] = [];
				for await (const row of db.eval(q)) on.push(JSON.stringify(Object.values(row) as SqlValue[]));
				db.optimizer.updateTuning(REWRITE_OFF);
				const off: string[] = [];
				for await (const row of db.eval(q)) off.push(JSON.stringify(Object.values(row) as SqlValue[]));
				db.optimizer.updateTuning(DEFAULT_TUNING);
				expect(on, 'ordered rollup diverged').to.deep.equal(off); // ordered compare (NOT sorted)
			},
		), { numRuns: 25 });
	});
});
