import { Database } from '../../dist/src/index.js';

/** Collect an async iterable into an array. */
async function collect(iter) {
	const out = [];
	for await (const item of iter) out.push(item);
	return out;
}

/** Build and populate a 10K-row database. */
async function createPopulatedDb() {
	const db = new Database();
	await db.exec(`
		create table bench_t (id integer primary key, val integer, label text);
		create index bench_t_val on bench_t (val);
	`);

	// Insert 10K rows in batches of 500
	for (let batch = 0; batch < 20; batch++) {
		const values = Array.from({ length: 500 }, (_, j) => {
			const id = batch * 500 + j + 1;
			return `(${id}, ${id * 7 % 1000}, 'group_${id % 100}')`;
		}).join(', ');
		await db.exec(`insert into bench_t values ${values}`);
	}

	return db;
}

let db;

export const benchmarks = [
	{
		name: 'full-scan-10k',
		iterations: 10,
		warmup: 2,
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval('select * from bench_t'));
			if (rows.length !== 10000) throw new Error(`Expected 10000 rows, got ${rows.length}`);
		},
	},
	{
		name: 'filtered-scan-index-10k',
		iterations: 10,
		warmup: 2,
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval('select * from bench_t where val = 42'));
			if (rows.length === 0) throw new Error('Expected some rows');
		},
	},
	{
		name: 'group-by-10k',
		iterations: 10,
		warmup: 2,
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(
				db.eval('select label, count(*) as cnt, sum(val) as total from bench_t group by label')
			);
			if (rows.length !== 100) throw new Error(`Expected 100 groups, got ${rows.length}`);
		},
	},
	{
		name: 'order-by-10k',
		iterations: 10,
		warmup: 2,
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(
				db.eval('select * from bench_t order by val desc, id asc')
			);
			if (rows.length !== 10000) throw new Error(`Expected 10000 rows, got ${rows.length}`);
		},
	},
	{
		name: 'join-1kx1k',
		iterations: 10,
		warmup: 2,
		async setup() {
			db = new Database();
			await db.exec(`
				create table left_t (id integer primary key, key_col integer);
				create table right_t (id integer primary key, key_col integer, payload text);
			`);
			const leftVals = Array.from({ length: 1000 }, (_, i) =>
				`(${i + 1}, ${i % 100})`
			).join(', ');
			const rightVals = Array.from({ length: 1000 }, (_, i) =>
				`(${i + 1}, ${i % 100}, 'data_${i}')`
			).join(', ');
			await db.exec(`insert into left_t values ${leftVals}`);
			await db.exec(`insert into right_t values ${rightVals}`);
		},
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(
				db.eval('select l.id, r.payload from left_t l join right_t r on l.key_col = r.key_col where l.id <= 100')
			);
			if (rows.length === 0) throw new Error('Expected join results');
		},
	},
	{
		name: 'correlated-subquery',
		iterations: 10,
		warmup: 2,
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(
				db.eval(`
					select id, val,
						(select count(*) from bench_t b where b.label = a.label) as peer_count
					from bench_t a
					where a.id <= 100
				`)
			);
			if (rows.length !== 100) throw new Error(`Expected 100 rows, got ${rows.length}`);
		},
	},
	{
		// Hand-batched twin of `correlated-subquery`: the identical result via an
		// explicit grouped join — the shape the optimizer should produce when
		// `scalar-agg-decorrelation` fires. The `ratioGuards` entry below compares
		// the two: when decorrelation works the plans are near-identical (ratio ≈
		// 1); if it breaks, the declarative side goes N+1 and the ratio spikes.
		name: 'hand-batched-peer-count',
		iterations: 10,
		warmup: 2,
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(
				db.eval(`
					select a.id, a.val, coalesce(g.cnt, 0) as peer_count
					from bench_t a
					left join (select label, count(*) as cnt from bench_t group by label) g on g.label = a.label
					where a.id <= 100
				`)
			);
			if (rows.length !== 100) throw new Error(`Expected 100 rows, got ${rows.length}`);
		},
	},
];

/**
 * Within-run shape-economy guards. Each guard is a ratio of one benchmark's
 * median to another's, checked inside a single run (independent of any
 * `--baseline` file). `correlated-subquery` relies on `scalar-agg-decorrelation`
 * to become the same grouped-join plan a human writes by hand
 * (`hand-batched-peer-count`); when the rule fires the two are near-identical
 * (ratio ≈ 1). If decorrelation ever breaks, the declarative side re-runs its
 * inner count(*) once per outer row (an "N+1 scan", ~26× in the original
 * post-mortem) and the ratio spikes past `maxRatio`.
 *
 * `maxRatio` is deliberately LOOSE (order-of-magnitude): its job is to trip the
 * 26×-class regression, not order-of-1 warm-up variance on the in-memory vtab.
 * If the twin ever shows high variance near the bound, raise its `iterations`
 * rather than tightening `maxRatio`.
 */
export const ratioGuards = [
	{ name: 'correlated-subquery', baseline: 'hand-batched-peer-count', maxRatio: 10 },
];
