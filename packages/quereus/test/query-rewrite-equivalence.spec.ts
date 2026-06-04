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
