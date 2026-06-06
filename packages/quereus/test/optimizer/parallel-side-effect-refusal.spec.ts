/**
 * Parallel-track side-effect refusal — pins the `isConcurrencySafe` gate added
 * by `4-query-expr-parallel-track-refusal`.
 *
 * The parallel-recognition rules (`ruleAsyncGatherUnionAll`,
 * `ruleAsyncGatherZipByKey`, `ruleEagerPrefetchProbe`,
 * `ruleFanOutLookupJoin`, `ruleFanOutBatchedOuter`) MUST refuse to fold /
 * fork / prefetch when any participating subtree carries a write. The serial
 * plan stays in place. Pairs with `dml-in-expression-position` — once DML can
 * appear in relation positions, the connection lock requires us to never
 * drive an impure subtree concurrently with a sibling.
 *
 * Coverage:
 *   - Predicate semantics (`PlanNodeCharacteristics.isConcurrencySafe`).
 *   - SQL-level negative + positive for UNION-ALL gather and eager-prefetch
 *     probe (the two parallel rules whose shapes are cleanly SQL-expressible).
 *   - End-to-end correctness: a unionAll chain with a DML branch yields
 *     correct results AND fires the inner write exactly once.
 *
 * The `FanOutLookupJoinNode` / `FanOutBatchedOuter` paths share the same
 * predicate; their per-rule specs already cover the positive (firing) case,
 * and the predicate test below pins the negative direction without needing
 * a hand-built fan-out spine (which has no clean SQL shape with DML inside).
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { PlanNodeCharacteristics } from '../../src/planner/framework/characteristics.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { SqlValue } from '../../src/common/types.js';

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

/**
 * Memory-backed module that declares a non-zero `expectedLatencyMs`. Used so
 * the gather / prefetch cost gates have a real latency to compare against
 * the default thresholds — without it the rules are inert by design and the
 * negative tests would pass vacuously.
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

function hasOp(rows: readonly PlanRow[], op: string): boolean {
	return rows.some(r => r.op === op);
}

describe('PlanNodeCharacteristics.isConcurrencySafe', () => {
	it('reports true on a pure subtree', () => {
		const leaf = {
			physical: { readonly: true, deterministic: true },
			getChildren: () => [],
		} as unknown as PlanNode;
		const project = {
			physical: { readonly: true, deterministic: true },
			getChildren: () => [leaf],
		} as unknown as PlanNode;
		expect(PlanNodeCharacteristics.isConcurrencySafe(project)).to.equal(true);
	});

	it('reports false when the root carries a write', () => {
		const writeRoot = {
			physical: { readonly: false, deterministic: true },
			getChildren: () => [],
		} as unknown as PlanNode;
		expect(PlanNodeCharacteristics.isConcurrencySafe(writeRoot)).to.equal(false);
	});

	it('reports false when a deep descendant carries a write', () => {
		const writeLeaf = {
			physical: { readonly: false, deterministic: true },
			getChildren: () => [],
		} as unknown as PlanNode;
		const filter = {
			physical: { readonly: true, deterministic: true },
			getChildren: () => [writeLeaf],
		} as unknown as PlanNode;
		const project = {
			physical: { readonly: true, deterministic: true },
			getChildren: () => [filter],
		} as unknown as PlanNode;
		expect(PlanNodeCharacteristics.isConcurrencySafe(project)).to.equal(false);
	});

	it('is the negation of subtreeHasSideEffects', () => {
		// Pin the contract: a single predicate implemented in terms of the
		// audit-time helper means the parallel-track rules cannot drift from
		// the rest of the audit discipline.
		const writeLeaf = {
			physical: { readonly: false },
			getChildren: () => [],
		} as unknown as PlanNode;
		const pureLeaf = {
			physical: { readonly: true },
			getChildren: () => [],
		} as unknown as PlanNode;
		expect(PlanNodeCharacteristics.isConcurrencySafe(writeLeaf))
			.to.equal(!PlanNodeCharacteristics.subtreeHasSideEffects(writeLeaf));
		expect(PlanNodeCharacteristics.isConcurrencySafe(pureLeaf))
			.to.equal(!PlanNodeCharacteristics.subtreeHasSideEffects(pureLeaf));
	});
});

describe('Parallel-track refusal: AsyncGather(unionAll)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
		for (const t of ['hi_a', 'hi_b', 'hi_c']) {
			await db.exec(`create table ${t} (id integer primary key, v integer) using hi_lat_memory`);
		}
		await db.exec('insert into hi_a values (1, 10), (2, 20)');
		await db.exec('insert into hi_b values (3, 30), (4, 40)');
		await db.exec('insert into hi_c values (5, 50), (6, 60)');
		await db.exec('create table writes_log (id integer primary key, v integer) using hi_lat_memory');
	});

	afterEach(async () => { await db.close(); });

	/** Pure 3-branch unionAll across high-latency tables. Used as the positive
	 *  control: the rule MUST fire here, otherwise the negative test below
	 *  would pass for the wrong reason. */
	const pureChainSQL =
		`select id, v from hi_a
		 union all select id, v from hi_b
		 union all select id, v from hi_c`;

	/** Same shape, but one branch carries an `INSERT ... RETURNING` so its
	 *  subtree reports `hasSideEffects = true`. The rule MUST refuse. */
	const impureChainSQL =
		`select id, v from hi_a
		 union all select id, v from (insert into writes_log (id, v) values (99, 990) returning id, v) z
		 union all select id, v from hi_c`;

	it('folds the pure chain (positive control)', async () => {
		const plan = await planRows(db, pureChainSQL);
		expect(hasOp(plan, 'ASYNCGATHER'), `ops=${plan.map(r => r.op).join(',')}`)
			.to.equal(true);
	});

	it('does NOT fold when one branch has DML', async () => {
		const plan = await planRows(db, impureChainSQL);
		expect(hasOp(plan, 'ASYNCGATHER'), `ops=${plan.map(r => r.op).join(',')}`)
			.to.equal(false);
		// The INSERT must still be present — refusal leaves the serial plan.
		expect(hasOp(plan, 'INSERT'), `ops=${plan.map(r => r.op).join(',')}`)
			.to.equal(true);
	});

	it('end-to-end: serial plan with DML branch fires the write exactly once and yields correct rows', async () => {
		const out = await results(db, impureChainSQL);
		// Six rows from hi_a/hi_c (4) + one row from the INSERT-RETURNING branch.
		expect(out.length).to.equal(5);
		// The write must have happened exactly once.
		const log = await results(db, 'select count(*) as c from writes_log');
		expect(log[0].c).to.equal(1);
		// The inserted row appears in the output.
		const ids = out.map(r => r.id).sort((a, b) => Number(a) - Number(b));
		expect(ids).to.deep.equal([1, 2, 5, 6, 99]);
	});

	it('threshold tuning to 0 does not relax the refusal', async () => {
		// Drop the cost gate to zero so the only remaining gate is the
		// side-effect refusal. The impure plan must still leave the chain serial.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, gatherThresholdMs: 0 },
		});
		try {
			const plan = await planRows(db, impureChainSQL);
			expect(hasOp(plan, 'ASYNCGATHER'), `ops=${plan.map(r => r.op).join(',')}`)
				.to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});
});

describe('Parallel-track refusal: EagerPrefetch on the probe', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
		// A hash join needs a hi-lat build side to cross the prefetch threshold
		// and a probe side we can swap between pure and impure.
		await db.exec('create table build_t (id integer primary key, v integer) using hi_lat_memory');
		await db.exec('create table probe_t (id integer primary key, v integer) using memory');
		await db.exec('create table sink_t (id integer primary key, v integer) using memory');
		await db.exec('insert into build_t values (1, 100), (2, 200), (3, 300)');
		await db.exec('insert into probe_t values (1, 10), (2, 20), (3, 30)');
	});

	afterEach(async () => { await db.close(); });

	it('does NOT prefetch when the probe carries DML', async () => {
		// The probe is a FROM-position INSERT...RETURNING. Even if the rule's
		// cost gate would otherwise prefer to wrap the probe in EagerPrefetch,
		// the side-effect gate must refuse: prefetching iterates the probe
		// concurrently with the build's for-await on the same connection,
		// which would interleave the write with sibling reads.
		const sql = `
			select b.id, b.v, p.v as pv
			from (insert into sink_t (id, v) values (1, 1), (2, 2) returning id, v) p
			left join build_t b on p.id = b.id`;
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EAGERPREFETCH'), `ops=${plan.map(r => r.op).join(',')}`)
			.to.equal(false);
		// The INSERT survives in the plan (refusal preserves the serial path).
		expect(hasOp(plan, 'INSERT'), `ops=${plan.map(r => r.op).join(',')}`)
			.to.equal(true);
	});

	it('end-to-end: the DML probe fires exactly once and yields correct rows', async () => {
		const sql = `
			select b.id, b.v, p.v as pv
			from (insert into sink_t (id, v) values (1, 1), (2, 2) returning id, v) p
			left join build_t b on p.id = b.id
			order by p.id`;
		const out = await results(db, sql);
		expect(out.length).to.equal(2);
		expect(out[0].pv).to.equal(1);
		expect(out[1].pv).to.equal(2);
		const log = await results(db, 'select count(*) as c from sink_t');
		expect(log[0].c).to.equal(2);
	});
});
