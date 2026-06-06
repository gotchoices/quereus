import { Database } from '../../dist/src/index.js';

let db;

const simpleScan = 'select id, val from bench_t where val > 50';
const joinPlan = 'select a.id, b.val from bench_t a join bench_t2 b on a.id = b.ref_id';
const aggregatePlan = 'select label, count(*) as cnt, sum(val) as total from bench_t group by label';
const subqueryPlan = 'select id, (select max(val) from bench_t2 b where b.ref_id = a.id) as max_val from bench_t a where a.id <= 100';

async function setup() {
	db = new Database();
	await db.exec(`
		create table bench_t (id integer primary key, val integer, label text);
		create table bench_t2 (id integer primary key, ref_id integer, val integer);
	`);
}

async function teardown() {
	await db.close();
	db = null;
}

export const benchmarks = [
	{
		name: 'simple-scan-plan',
		iterations: 30,
		warmup: 3,
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(simpleScan);
			await stmt.finalize();
		},
	},
	{
		name: 'join-plan',
		iterations: 30,
		warmup: 3,
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(joinPlan);
			await stmt.finalize();
		},
	},
	{
		name: 'aggregate-plan',
		iterations: 30,
		warmup: 3,
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(aggregatePlan);
			await stmt.finalize();
		},
	},
	{
		name: 'subquery-plan',
		iterations: 30,
		warmup: 3,
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(subqueryPlan);
			await stmt.finalize();
		},
	},
];
