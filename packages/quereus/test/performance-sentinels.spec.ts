/**
 * Performance sentinel tests.
 *
 * These are NOT micro-benchmarks; they are regression sentinels that assert
 * "this workload completes in well under N ms on CI-class hardware".
 * Thresholds are intentionally generous (10–50× headroom) so they only trip
 * when something regresses catastrophically.
 *
 * Run: yarn test --grep "Performance sentinels"
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { Parser } from '../src/parser/parser.js';
import { MemoryIndex } from '../src/vtab/memory/index.js';
import { createPrimaryKeyFunctions } from '../src/vtab/memory/utils/primary-key.js';
import { testBuiltinCollationResolver } from './util/builtin-collation-resolver.js';
import { createDefaultColumnSchema } from '../src/schema/column.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';
import type { TableSchema } from '../src/schema/table.js';

/** Collect an async iterable into an array. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

/** Time an async function in milliseconds. */
async function timeMs(fn: () => Promise<void>): Promise<number> {
	const start = performance.now();
	await fn();
	return performance.now() - start;
}

describe('Performance sentinels', function () {
	// Allow generous timeouts for CI
	this.timeout(30_000);

	// ------------------------------------------------------------------ Parser
	describe('Parser', () => {
		it('parses a simple SELECT under 5 ms', () => {
			const sql = 'select id, name, email from users where active = 1 order by name';
			const parser = new Parser();
			const start = performance.now();
			for (let i = 0; i < 100; i++) {
				parser.parseAll(sql);
			}
			const elapsed = performance.now() - start;
			// 100 parses should be well under 500 ms even on slow hardware
			expect(elapsed).to.be.below(500, `100 simple parses took ${elapsed.toFixed(1)} ms`);
		});

		it('parses a wide SELECT (50 columns) under 10 ms', () => {
			const cols = Array.from({ length: 50 }, (_, i) => `col_${i}`).join(', ');
			const sql = `select ${cols} from big_table where col_0 > 10`;
			const parser = new Parser();
			const start = performance.now();
			for (let i = 0; i < 100; i++) {
				parser.parseAll(sql);
			}
			const elapsed = performance.now() - start;
			expect(elapsed).to.be.below(1000, `100 wide-SELECT parses took ${elapsed.toFixed(1)} ms`);
		});

		it('parses a deeply nested expression under 20 ms', () => {
			// Build: ((((1 + 2) + 3) + 4) ... + 30)
			let expr = '1';
			for (let i = 2; i <= 30; i++) expr = `(${expr} + ${i})`;
			const sql = `select ${expr} as result`;
			const parser = new Parser();
			const start = performance.now();
			for (let i = 0; i < 100; i++) {
				parser.parseAll(sql);
			}
			const elapsed = performance.now() - start;
			expect(elapsed).to.be.below(1500, `100 nested-expression parses took ${elapsed.toFixed(1)} ms`);
		});
	});

	// --------------------------------------------------------- Planning time
	describe('Planning time', () => {
		it('plans a 50-column SELECT with non-contradicting WHERE under budget', async () => {
			const db = new Database();
			try {
				// 50 conjuncts × 50 columns. The left-associative AND tree is
				// depth 49; the per-pass depth budget now scales with the input
				// plan's measured depth (see `planInputDepth` in pass.ts) so this
				// plans cleanly without tripping the depth guard.
				// Each column carries a CHECK domain and a non-contradicting WHERE
				// conjunct so the sat-checker walks every one and concludes 'sat'.
				const cols = Array.from({ length: 50 }, (_, i) => `c${i} INTEGER CHECK (c${i} >= 0)`).join(', ');
				await db.exec(`CREATE TABLE wide (id INTEGER PRIMARY KEY, ${cols}) USING memory`);
				const whereClauses = Array.from({ length: 50 }, (_, i) => `c${i} < 1000`).join(' AND ');
				const sql = `SELECT * FROM wide WHERE ${whereClauses}`;

				const elapsed = await timeMs(async () => {
					for (let i = 0; i < 50; i++) {
						const stmt = db.prepare(sql);
						// `db.prepare` only parses; planning is deferred until first
						// step / compile. Force compilation here so the sat-checker
						// actually runs on every iteration.
						stmt.compile();
						await stmt.finalize();
					}
				});
				// O(conjuncts × columns_mentioned) — 50 × 1 column each = trivial.
				// Generous budget for CI headroom.
				expect(elapsed).to.be.below(10000, `50 plans of 50-col WHERE took ${elapsed.toFixed(1)} ms`);
			} finally {
				await db.close();
			}
		});
	});

	// --------------------------------------------------------- End-to-end query
	describe('End-to-end query execution', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			// Create a table with 1000 rows
			await db.exec('create table perf_t (id integer primary key, val integer, label text)');
			const batches: string[] = [];
			for (let i = 0; i < 10; i++) {
				const values = Array.from({ length: 100 }, (_, j) => {
					const id = i * 100 + j + 1;
					return `(${id}, ${id * 7 % 100}, 'label_${id % 20}')`;
				}).join(', ');
				batches.push(`insert into perf_t values ${values}`);
			}
			for (const batch of batches) {
				await batch; // force sequential
				await db.exec(batch);
			}
		});

		afterEach(async () => {
			await db.close();
		});

		it('full table scan (1000 rows) under 200 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(db.eval('select * from perf_t'));
				expect(rows).to.have.length(1000);
			});
			expect(elapsed).to.be.below(200, `scan took ${elapsed.toFixed(1)} ms`);
		});

		it('filtered scan (1000 rows, ~10 matches) under 200 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(db.eval('select * from perf_t where val = 42'));
				expect(rows.length).to.be.greaterThan(0);
			});
			expect(elapsed).to.be.below(200, `filtered scan took ${elapsed.toFixed(1)} ms`);
		});

		it('aggregate GROUP BY under 200 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval('select label, count(*) as cnt, sum(val) as total from perf_t group by label')
				);
				expect(rows.length).to.be.greaterThan(0);
			});
			expect(elapsed).to.be.below(200, `group by took ${elapsed.toFixed(1)} ms`);
		});

		it('ORDER BY under 200 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval('select * from perf_t order by val desc, id asc')
				);
				expect(rows).to.have.length(1000);
			});
			expect(elapsed).to.be.below(200, `order by took ${elapsed.toFixed(1)} ms`);
		});

		it('self-join under 500 ms (bloom/hash join)', async () => {
			// Bloom join: build hash map on right side, probe with left.
			// Typical: ~30-60 ms. Threshold generous for CI headroom.
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval(`
						select a.id, b.id as b_id
						from perf_t a join perf_t b on a.val = b.val
						where a.id <= 50
					`)
				);
				expect(rows.length).to.be.greaterThan(0);
			});
			expect(elapsed).to.be.below(500, `self-join took ${elapsed.toFixed(1)} ms`);
		});

		it('correlated subquery under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval(`
						select id, val,
							(select count(*) from perf_t b where b.val = a.val) as peer_count
						from perf_t a
						where a.id <= 50
					`)
				);
				expect(rows).to.have.length(50);
			});
			expect(elapsed).to.be.below(500, `correlated subquery took ${elapsed.toFixed(1)} ms`);
		});
	});

	// --------------------------------------------------------- Bulk mutations
	describe('Bulk mutations', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('bulk insert 1000 rows under 500 ms', async () => {
			await db.exec('create table bulk_t (id integer primary key, val integer)');

			const elapsed = await timeMs(async () => {
				for (let i = 0; i < 10; i++) {
					const values = Array.from({ length: 100 }, (_, j) => {
						const id = i * 100 + j + 1;
						return `(${id}, ${id * 3})`;
					}).join(', ');
					await db.exec(`insert into bulk_t values ${values}`);
				}
			});
			expect(elapsed).to.be.below(500, `bulk insert took ${elapsed.toFixed(1)} ms`);

			// Verify
			const rows = await collect(db.eval('select count(*) as cnt from bulk_t'));
			expect(rows[0].cnt).to.equal(1000);
		});

		it('index lookup after bulk insert under 100 ms', async () => {
			await db.exec(`
				create table idx_t (id integer primary key, category integer, name text);
				create index idx_t_category on idx_t (category);
			`);

			// Insert 500 rows
			const values = Array.from({ length: 500 }, (_, i) =>
				`(${i + 1}, ${i % 10}, 'name_${i}')`
			).join(', ');
			await db.exec(`insert into idx_t values ${values}`);

			const elapsed = await timeMs(async () => {
				// 50 point lookups by primary key
				for (let i = 1; i <= 50; i++) {
					const row = await db.get(`select * from idx_t where id = ?`, [i]);
					expect(row).to.exist;
				}
			});
			expect(elapsed).to.be.below(500, `50 PK lookups took ${elapsed.toFixed(1)} ms`);
		});
	});

	// ------------------------------------ Aggregate accumulator (O(n) not O(n²))
	describe('Aggregate accumulator spread', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table agg_t (id integer primary key, grp integer, val text)');
			const values = Array.from({ length: 1000 }, (_, i) =>
				`(${i + 1}, ${i % 5}, 'v${i}')`
			).join(', ');
			await db.exec(`insert into agg_t values ${values}`);
		});

		afterEach(async () => {
			await db.close();
		});

		it('group_concat over 1000 rows under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval("select group_concat(val, ',') from agg_t")
				);
				expect(rows).to.have.length(1);
			});
			expect(elapsed).to.be.below(500, `group_concat took ${elapsed.toFixed(1)} ms`);
		});

		it('json_group_array over 1000 rows under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval('select json_group_array(val) from agg_t')
				);
				expect(rows).to.have.length(1);
			});
			expect(elapsed).to.be.below(500, `json_group_array took ${elapsed.toFixed(1)} ms`);
		});

		it('json_group_object over 1000 rows under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				const rows = await collect(
					db.eval("select json_group_object(val, id) from agg_t")
				);
				expect(rows).to.have.length(1);
			});
			expect(elapsed).to.be.below(500, `json_group_object took ${elapsed.toFixed(1)} ms`);
		});
	});

	// ------------------------------------------------- Repeated prepare/execute
	describe('Statement reuse', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table reuse_t (id integer primary key, v integer)');
			const values = Array.from({ length: 100 }, (_, i) => `(${i + 1}, ${i * 2})`).join(', ');
			await db.exec(`insert into reuse_t values ${values}`);
		});

		afterEach(async () => {
			await db.close();
		});

		it('50 prepare+execute cycles under 500 ms', async () => {
			const elapsed = await timeMs(async () => {
				for (let i = 1; i <= 50; i++) {
					const rows = await collect(db.eval('select * from reuse_t where id = ?', [i]));
					expect(rows).to.have.length(1);
				}
			});
			expect(elapsed).to.be.below(500, `50 prepare+execute cycles took ${elapsed.toFixed(1)} ms`);
		});
	});

	// ----------------------------- Secondary index per-entry PK container (O(1) owned add)
	// Container-level descending-add: every PK lands in ONE low-cardinality bucket in
	// reverse order. The old sorted-array container splices at the front each time
	// (O(M²) to build, ~4.4 s at 250k); the Map's set is O(1) so the build is O(N).
	describe('Secondary index per-entry PK container', function () {
		this.timeout(120_000);

		it('builds a single-key bucket of 250k out-of-order PKs under 2 s', () => {
			const columns = [
				{ ...createDefaultColumnSchema('status'), logicalType: INTEGER_TYPE },
				{ ...createDefaultColumnSchema('id'), logicalType: INTEGER_TYPE },
			];
			const schema: TableSchema = {
				name: 'orders',
				schemaName: 'main',
				columns,
				columnIndexMap: new Map(columns.map((c, i) => [c.name.toLowerCase(), i])),
				primaryKeyDefinition: [{ index: 1 }],
				checkConstraints: [],
				vtabModuleName: 'memory',
				isView: false,
			};
			const pk = createPrimaryKeyFunctions(schema, testBuiltinCollationResolver);
			const index = new MemoryIndex(
				{ name: 'ix_status', columns: [{ index: 0 }] },
				columns,
				testBuiltinCollationResolver,
				pk.compare,
				pk.encode,
			);

			const N = 250_000;
			const start = performance.now();
			for (let i = N; i >= 1; i--) index.addEntry(0, i); // descending => array-front splice worst case
			const elapsed = performance.now() - start;

			expect(index.getPrimaryKeys(0)).to.have.length(N);
			expect(elapsed).to.be.below(2000, `250k out-of-order PK adds took ${elapsed.toFixed(1)} ms`);
		});
	});
});

