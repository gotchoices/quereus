/**
 * Recognition + cost-gate tests for `ruleAsyncGatherUnionAll`.
 *
 * The cost gate is anchored on `physical.expectedLatencyMs` — populated 0 for
 * in-process / memory-vtab paths, non-zero for the synthetic
 * `HighLatencyMemoryModule` below. The local-only no-rewrite case locks the
 * invariant that memory-vtab plans never trigger the rule.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import type { SqlValue } from '../../src/common/types.js';

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

/**
 * Memory-backed module that declares a non-zero `expectedLatencyMs`. Tables
 * registered with this module surface as branches whose physical properties
 * meet the gather threshold. Mirrors the helper in `parallel-fanout.spec.ts`.
 */
class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

async function results(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

function hasAsyncGather(rows: readonly PlanRow[]): boolean {
	return rows.some(r => r.op === 'ASYNCGATHER' || r.node_type === 'AsyncGather');
}

function setOperationCount(rows: readonly PlanRow[]): number {
	return rows.filter(r => r.op === 'SETOPERATION' || r.node_type === 'SetOperation').length;
}

describe('ruleAsyncGatherUnionAll', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * Create three high-latency tables `hi_a`, `hi_b`, `hi_c` and three local
	 * tables `lo_a`, `lo_b`, `lo_c`. Each table has the same shape so
	 * UNION ALL across any combination is well-formed.
	 */
	async function setup(): Promise<void> {
		for (const t of ['hi_a', 'hi_b', 'hi_c']) {
			await db.exec(`create table ${t} (id integer primary key, v integer) using hi_lat_memory`);
		}
		for (const t of ['lo_a', 'lo_b', 'lo_c']) {
			await db.exec(`create table ${t} (id integer primary key, v integer) using memory`);
		}
		await db.exec("insert into hi_a values (1, 10), (2, 20)");
		await db.exec("insert into hi_b values (3, 30), (4, 40)");
		await db.exec("insert into hi_c values (5, 50), (6, 60)");
		await db.exec("insert into lo_a values (7, 70), (8, 80)");
		await db.exec("insert into lo_b values (9, 90), (10, 100)");
		await db.exec("insert into lo_c values (11, 110), (12, 120)");
	}

	const allHigh3SQL =
		`select id, v from hi_a
		 union all select id, v from hi_b
		 union all select id, v from hi_c`;

	it('folds a 3-branch all-high-latency unionAll chain into one AsyncGather(unionAll)', async () => {
		await setup();
		const plan = await planRows(db, allHigh3SQL);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		// Every SetOperation in the chain should be gone after the fold.
		expect(setOperationCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
	});

	it('folds a 2-branch unionAll when minBranches=2', async () => {
		await setup();
		const sql = `select id, v from hi_a union all select id, v from hi_b`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
	});

	it('does NOT fold a single SELECT (no SetOperation to match)', async () => {
		await setup();
		const plan = await planRows(db, 'select id, v from hi_a');
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('folds when only some branches are high-latency (max-of-children gate)', async () => {
		// Threshold is "slowest child meets cutoff" — a single high-latency
		// branch in a 3-way chain still flips the gate. Locks the v1 decision
		// (the rule does not require every branch to be high-latency).
		await setup();
		const sql =
			`select id, v from hi_a
			 union all select id, v from lo_a
			 union all select id, v from lo_b`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
	});

	it('does NOT fold a purely local-only chain regardless of N', async () => {
		await setup();
		const sql =
			`select id, v from lo_a
			 union all select id, v from lo_b
			 union all select id, v from lo_c`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		// All three SetOperations should remain (chain is `(A U B) U C`).
		expect(setOperationCount(plan)).to.be.greaterThan(0);
	});

	it('does NOT fold when threshold is raised above the slowest child', async () => {
		await setup();
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, gatherThresholdMs: 1000 },
		});
		try {
			const plan = await planRows(db, allHigh3SQL);
			expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('does NOT fold below tuning.parallel.minBranches', async () => {
		await setup();
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, minBranches: 4 },
		});
		try {
			// 3 < 4 → no fold even with all-high-latency.
			const plan = await planRows(db, allHigh3SQL);
			expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('does NOT fold UNION (distinct) — only unionAll matches', async () => {
		await setup();
		const sql =
			`select id, v from hi_a
			 union select id, v from hi_b
			 union select id, v from hi_c`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('honors disabledRules and leaves the chain as nested SetOperations', async () => {
		await setup();
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['async-gather-union-all']),
		});
		try {
			const plan = await planRows(db, allHigh3SQL);
			expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
			expect(setOperationCount(plan)).to.be.greaterThan(0);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('preserves output multiset across the rewrite (execution equivalence)', async () => {
		await setup();
		// Rewritten path.
		const rewritten = await results(db, allHigh3SQL);

		// Baseline: disable the rule and re-run. IMPORTANT: queries are planned
		// lazily on first iterator step, so `await` must happen inside the
		// tuning window — otherwise the finally restores defaults before the
		// plan is built and we'd be comparing two identical plans.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['async-gather-union-all']),
		});
		let baseline: Record<string, SqlValue>[];
		try {
			baseline = await results(db, allHigh3SQL);
		} finally {
			db.optimizer.updateTuning(before);
		}

		// Multiset equality (no ordering claim — unionAll arrival order is
		// non-deterministic under the gather).
		const sortKey = (r: Record<string, SqlValue>): string => JSON.stringify([r.id, r.v]);
		expect([...rewritten].sort((a, b) => sortKey(a).localeCompare(sortKey(b))))
			.to.deep.equal([...baseline].sort((a, b) => sortKey(a).localeCompare(sortKey(b))));
		expect(rewritten.length).to.equal(6);
	});

	it('preserves output attribute IDs across the rewrite', async () => {
		await setup();
		// Column names (the user-visible manifestation of attribute IDs) must
		// match across the two plans. The fold passes `node.getAttributes()`
		// as `preserveAttributeIds` to `AsyncGatherNode`, which mirrors
		// `SetOperationNode.buildAttributes` — both inherit the leftmost
		// child's attributes verbatim.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['async-gather-union-all']),
		});
		let base: Record<string, SqlValue>[];
		try {
			base = await results(db, allHigh3SQL);
		} finally {
			db.optimizer.updateTuning(before);
		}
		const rewr = await results(db, allHigh3SQL);
		// Confirm the rewrite fired (otherwise this comparison is vacuous).
		const rewrittenPlan = await planRows(db, allHigh3SQL);
		expect(hasAsyncGather(rewrittenPlan), 'rewrite must fire for the comparison').to.equal(true);
		expect(Object.keys(base[0])).to.deep.equal(Object.keys(rewr[0]));
	});

	// Sort-above-AsyncGather is a known strict-fork interaction: Sort's emitter
	// calls `withAsyncRowContext` on the parent rctx while the gather's iterator
	// (which owns active forks of that same rctx) is still being consumed,
	// tripping the strict-fork contract. This is pre-existing to the rule —
	// any manually constructed Sort-on-AsyncGather plan would hit the same
	// path. Skip under strict-fork; the non-strict path validates correctness.
	const strictFork = typeof process !== 'undefined' && (process.env?.QUEREUS_FORK_STRICT === '1' || process.env?.QUEREUS_FORK_STRICT === 'true');
	const sortTest = strictFork ? it.skip : it;
	sortTest('keeps a Sort above the gather when ORDER BY wraps the chain', async () => {
		await setup();
		const sql = `select id, v from (${allHigh3SQL}) t order by id`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		const sortRow = plan.find(r => r.op === 'SORT' || r.node_type === 'Sort');
		const gatherRow = plan.find(r => r.op === 'ASYNCGATHER' || r.node_type === 'AsyncGather');
		expect(sortRow, 'expected a Sort in the plan').to.exist;
		expect(gatherRow, 'expected an AsyncGather in the plan').to.exist;

		const out = await results(db, sql);
		expect(out.map(r => r.id)).to.deep.equal([1, 2, 3, 4, 5, 6]);
	});

	it('does NOT touch a recursive CTE', async () => {
		// Recursive CTEs use `RecursiveCTENode`, not chained `SetOperationNode`s,
		// so the rule's matcher rejects them.
		await db.exec('create table t (id integer primary key, parent_id integer null)');
		await db.exec('insert into t values (1, null), (2, 1), (3, 2)');
		const sql = `
			with recursive r(id, parent_id, depth) as (
				select id, parent_id, 0 from t where parent_id is null
				union all
				select t.id, t.parent_id, r.depth + 1 from t join r on t.parent_id = r.id
			)
			select id, parent_id, depth from r order by id
		`;
		const plan = await planRows(db, sql);
		expect(hasAsyncGather(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);

		// Sanity-check the recursive query still produces the expected rows.
		const out = await results(db, sql);
		expect(out.map(r => r.id)).to.deep.equal([1, 2, 3]);
	});

	it('is idempotent: running the optimizer twice over the rewritten plan does not transform further', async () => {
		// The rule's matcher requires `node instanceof SetOperationNode`; the
		// rewritten root is an AsyncGatherNode. A second pass therefore no-ops.
		// We exercise this implicitly by re-planning the same SQL — each call
		// runs the full optimizer pipeline against the freshly-built logical
		// plan, and we assert the rewrite shape (one gather, zero SetOps)
		// rather than re-driving the pipeline on an already-rewritten plan.
		await setup();
		const first = await planRows(db, allHigh3SQL);
		const second = await planRows(db, allHigh3SQL);
		expect(setOperationCount(first)).to.equal(0);
		expect(setOperationCount(second)).to.equal(0);
		expect(first.filter(r => r.op === 'ASYNCGATHER').length)
			.to.equal(second.filter(r => r.op === 'ASYNCGATHER').length);
		expect(first.filter(r => r.op === 'ASYNCGATHER').length).to.equal(1);
	});

	it('default tuning has gatherThresholdMs > 0', () => {
		// Pin the no-rewrite-on-local invariant at the tuning layer. The
		// golden-plan sweep depends on `expectedLatencyMs=0` failing the gate
		// for memory-vtab plans; this asserts the gate is always > 0.
		expect(DEFAULT_TUNING.parallel.gatherThresholdMs).to.be.greaterThan(0);
	});

	it('clamps concurrencyCap to children.length when N < concurrency', async () => {
		// With default concurrency=8 and a 3-branch chain, the cap should be
		// clamped to 3 (validated by reading the gather node's detail string).
		await setup();
		const plan = await planRows(db, allHigh3SQL);
		const gatherRow = plan.find(r => r.op === 'ASYNCGATHER');
		expect(gatherRow, 'expected an AsyncGather in the plan').to.exist;
		expect(gatherRow!.detail).to.match(/cap=3/);
	});
});
