import { expect } from 'chai';
import { Database } from '../src/index.js';
import { CollectingInstructionTracer } from '../src/runtime/types.js';

async function collectRows<T>(rows: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const row of rows) out.push(row);
	return out;
}

describe('Runtime scheduler modes', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('is behaviorally equivalent across optimized/tracing/metrics modes', async () => {
		await db.exec('create table t (id integer primary key, v integer);');
		await db.exec('insert into t values (1, 10), (2, 20), (3, 30), (4, 40), (5, 50);');

		let tickCalls = 0;
		db.createScalarFunction(
			'tick',
			{ numArgs: 0, deterministic: false },
			() => {
				tickCalls++;
				return 1;
			}
		);

		const sql = 'select sum(tick()) as s from t';

		const runOptimized = async () => {
			tickCalls = 0;
			db.setOption('runtime_metrics', false);
			db.setInstructionTracer(undefined);

			const stmt = db.prepare(sql);
			const rows = await collectRows(stmt.iterateRows());
			await stmt.finalize();
			return { rows, tickCalls };
		};

		const runTracing = async () => {
			tickCalls = 0;
			db.setOption('runtime_metrics', false);
			db.setInstructionTracer(undefined);

			const tracer = new CollectingInstructionTracer();
			const stmt = db.prepare(sql);
			const rows = await collectRows(stmt.iterateRowsWithTrace(undefined, tracer));
			await stmt.finalize();

			void expect(tracer.getTraceEvents().length).to.be.greaterThan(0);
			return { rows, tickCalls };
		};

		const runMetrics = async () => {
			tickCalls = 0;
			db.setInstructionTracer(undefined);
			db.setOption('runtime_metrics', true);

			try {
				const stmt = db.prepare(sql);
				const rows = await collectRows(stmt.iterateRows());
				await stmt.finalize();
				return { rows, tickCalls };
			} finally {
				db.setOption('runtime_metrics', false);
			}
		};

		const optimized = await runOptimized();
		const tracing = await runTracing();
		const metrics = await runMetrics();

		void expect(optimized.rows).to.deep.equal([[5]]);
		void expect(tracing.rows).to.deep.equal(optimized.rows);
		void expect(metrics.rows).to.deep.equal(optimized.rows);

		void expect(optimized.tickCalls).to.equal(5);
		void expect(tracing.tickCalls).to.equal(5);
		void expect(metrics.tickCalls).to.equal(5);
	});
});

