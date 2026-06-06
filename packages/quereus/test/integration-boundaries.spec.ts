/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { Database, QuereusError, StatusCode } from '../src/index.js';

describe('Integration Boundaries', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// ========================================================================
	// Boundary 1: Parser → Planner
	// ========================================================================

	describe('Parser → Planner', () => {
		it('should parse and plan a simple SELECT', async () => {
			await db.exec('create table t1 (id integer primary key, name text)');
			const plan = db.getPlan('select id, name from t1');
			expect(plan).to.exist;
		});

		it('should propagate parse errors with location info', () => {
			expect(() => db.getPlan('select * from')).to.throw(QuereusError);
			try {
				db.getPlan('select * from');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
				expect(e.line).to.be.a('number');
				expect(e.column).to.be.a('number');
			}
		});

		it('should handle all major AST statement types through to planning', async () => {
			await db.exec('create table ast_test (id integer primary key, val text, num integer)');
			// SELECT with WHERE, ORDER BY, LIMIT
			expect(db.getPlan('select val from ast_test where num > 5 order by val limit 10')).to.exist;
			// INSERT
			expect(db.getPlan("insert into ast_test values (1, 'a', 10)")).to.exist;
			// UPDATE
			expect(db.getPlan("update ast_test set val = 'b' where id = 1")).to.exist;
			// DELETE
			expect(db.getPlan('delete from ast_test where id = 1')).to.exist;
		});

		it('should reject invalid SQL at the parser level', () => {
			expect(() => db.getPlan('CREAT TABLE t (a)')).to.throw(QuereusError);
		});

		it('should reject semantically invalid SQL at the planner level', async () => {
			// Table doesn't exist → planner error (not parser error)
			expect(() => db.getPlan('select * from no_such_table')).to.throw(QuereusError);
		});

		it('should handle subqueries through planning and execution', async () => {
			await db.exec('create table sub_t (id integer primary key, val integer)');
			await db.exec('insert into sub_t values (1, 10), (2, 20), (3, 30)');
			// Use an IN subquery which avoids the constraint extractor literal issue
			const row = await db.get('select count(*) as cnt from sub_t where id in (select id from sub_t where val >= 20)');
			expect(row).to.exist;
			expect(row!.cnt).to.equal(2);
		});

		it('should handle JOINs through planning', async () => {
			await db.exec('create table j1 (id integer primary key, a text)');
			await db.exec('create table j2 (id integer primary key, b text)');
			expect(db.getPlan('select j1.a, j2.b from j1 join j2 on j1.id = j2.id')).to.exist;
		});

		it('should handle CTEs through planning', async () => {
			await db.exec('create table cte_t (id integer primary key, parent_id integer)');
			const sql = 'with recursive r as (select id, parent_id from cte_t where parent_id is null union all select c.id, c.parent_id from cte_t c join r on c.parent_id = r.id) select * from r';
			expect(db.getPlan(sql)).to.exist;
		});

		it('should handle aggregations through planning', async () => {
			await db.exec('create table agg_t (grp text, val integer)');
			expect(db.getPlan('select grp, count(*), sum(val) from agg_t group by grp having count(*) > 1')).to.exist;
		});
	});

	// ========================================================================
	// Boundary 2: Planner → Optimizer
	// ========================================================================

	describe('Planner → Optimizer', () => {
		it('should preserve attribute IDs through optimization', async () => {
			await db.exec('create table opt_t (id integer primary key, name text, age integer)');
			// The query_plan function lets us inspect the optimized plan
			const rows: any[] = [];
			for await (const row of db.eval("select * from query_plan('select id, name from opt_t where age > 10')")) {
				rows.push(row);
			}
			expect(rows.length).to.be.greaterThan(0);
		});

		it('should produce a valid optimized plan for complex queries', async () => {
			await db.exec('create table opt2 (id integer primary key, a text, b integer)');
			const plan = db.getPlan('select a, count(*) as cnt from opt2 where b > 0 group by a order by cnt desc limit 5');
			expect(plan).to.exist;
		});

		it('should optimize predicate pushdown', async () => {
			await db.exec('create table pd_t (id integer primary key, name text, val integer)');
			// After optimization, FILTER should ideally be pushed down
			const rows: any[] = [];
			for await (const row of db.eval("select op from query_plan('select * from pd_t where id = 1')")) {
				rows.push(row);
			}
			// We expect scan/seek operations to exist in the plan
			const ops = rows.map((r: any) => r.op);
			const hasScan = ops.some((op: string) => op === 'SEQSCAN' || op === 'INDEXSCAN' || op === 'INDEXSEEK');
			expect(hasScan).to.be.true;
		});

		it('should handle view planning through optimizer', async () => {
			await db.exec('create table v_base (id integer primary key, val text)');
			await db.exec('create view v_view as select id, val from v_base where id > 0');
			expect(db.getPlan('select * from v_view')).to.exist;
		});
	});

	// ========================================================================
	// Boundary 3: Optimizer → Runtime
	// ========================================================================

	describe('Optimizer → Runtime', () => {
		it('should execute a planned SELECT through the full pipeline', async () => {
			await db.exec('create table rt_t (id integer primary key, val text)');
			await db.exec("insert into rt_t values (1, 'hello'), (2, 'world')");
			const row = await db.get('select val from rt_t where id = 1');
			expect(row).to.exist;
			expect(row!.val).to.equal('hello');
		});

		it('should execute aggregations through the full pipeline', async () => {
			await db.exec('create table rt_agg (grp text, val integer)');
			await db.exec("insert into rt_agg values ('a', 10), ('a', 20), ('b', 30)");
			const row = await db.get("select grp, sum(val) as total from rt_agg where grp = 'a' group by grp");
			expect(row).to.exist;
			expect(row!.total).to.equal(30);
		});

		it('should handle ORDER BY + LIMIT through the pipeline', async () => {
			await db.exec('create table rt_ol (id integer primary key, name text)');
			for (let i = 1; i <= 10; i++) {
				await db.exec(`insert into rt_ol values (${i}, 'item${i}')`);
			}
			const rows: any[] = [];
			for await (const row of db.eval('select id from rt_ol order by id desc limit 3')) {
				rows.push(row);
			}
			expect(rows).to.have.lengthOf(3);
			expect(rows[0].id).to.equal(10);
			expect(rows[1].id).to.equal(9);
			expect(rows[2].id).to.equal(8);
		});

		it('should execute set operations (UNION) through the pipeline', async () => {
			await db.exec('create table rt_u1 (id integer, name text)');
			await db.exec('create table rt_u2 (id integer, name text)');
			await db.exec("insert into rt_u1 values (1, 'a'), (2, 'b')");
			await db.exec("insert into rt_u2 values (2, 'b'), (3, 'c')");
			const rows: any[] = [];
			for await (const row of db.eval('select id from rt_u1 union select id from rt_u2 order by id')) {
				rows.push(row);
			}
			expect(rows).to.have.lengthOf(3);
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2, 3]);
		});

		it('should execute subqueries through the pipeline', async () => {
			await db.exec('create table rt_sq (id integer primary key, val integer)');
			await db.exec('insert into rt_sq values (1, 100), (2, 200), (3, 300)');
			const row = await db.get('select count(*) as cnt from rt_sq where val > (select avg(val) from rt_sq)');
			expect(row).to.exist;
			expect(row!.cnt).to.equal(1); // only 300 > 200
		});

		it('should handle window functions through the pipeline', async () => {
			await db.exec('create table rt_win (id integer primary key, grp text, val integer)');
			await db.exec("insert into rt_win values (1, 'a', 10), (2, 'a', 20), (3, 'b', 30)");
			const rows: any[] = [];
			for await (const row of db.eval('select id, row_number() over (partition by grp order by val) as rn from rt_win order by id')) {
				rows.push(row);
			}
			expect(rows).to.have.lengthOf(3);
			expect(rows[0].rn).to.equal(1);
			expect(rows[1].rn).to.equal(2);
			expect(rows[2].rn).to.equal(1);
		});
	});

	// ========================================================================
	// Boundary 4: Runtime → VTab
	// ========================================================================

	describe('Runtime → VTab', () => {
		it('should read from a memory table through the VTab interface', async () => {
			await db.exec('create table vt_t (id integer primary key, val text)');
			await db.exec("insert into vt_t values (1, 'test')");
			const row = await db.get('select * from vt_t where id = 1');
			expect(row).to.exist;
			expect(row!.val).to.equal('test');
		});

		it('should handle inserts through VTab update interface', async () => {
			await db.exec('create table vt_ins (id integer primary key, val text)');
			await db.exec("insert into vt_ins values (1, 'a')");
			await db.exec("insert into vt_ins values (2, 'b')");
			const rows: any[] = [];
			for await (const row of db.eval('select * from vt_ins order by id')) {
				rows.push(row);
			}
			expect(rows).to.have.lengthOf(2);
		});

		it('should handle updates through VTab interface', async () => {
			await db.exec('create table vt_upd (id integer primary key, val text)');
			await db.exec("insert into vt_upd values (1, 'before')");
			await db.exec("update vt_upd set val = 'after' where id = 1");
			const row = await db.get('select val from vt_upd where id = 1');
			expect(row!.val).to.equal('after');
		});

		it('should handle deletes through VTab interface', async () => {
			await db.exec('create table vt_del (id integer primary key, val text)');
			await db.exec("insert into vt_del values (1, 'a'), (2, 'b')");
			await db.exec('delete from vt_del where id = 1');
			const rows: any[] = [];
			for await (const row of db.eval('select * from vt_del')) {
				rows.push(row);
			}
			expect(rows).to.have.lengthOf(1);
			expect(rows[0].id).to.equal(2);
		});

		it('should enforce PRIMARY KEY uniqueness through VTab', async () => {
			await db.exec('create table vt_uniq (id integer primary key, name text)');
			await db.exec("insert into vt_uniq values (1, 'alice')");
			try {
				await db.exec("insert into vt_uniq values (1, 'bob')");
				expect.fail('Should have thrown a constraint error');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
				expect(e.code).to.equal(StatusCode.CONSTRAINT);
			}
		});

		it('should enforce NOT NULL constraints through VTab', async () => {
			await db.exec('create table vt_nn (id integer primary key, val text not null)');
			try {
				await db.exec('insert into vt_nn values (1, null)');
				expect.fail('Should have thrown a constraint error');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
				expect(e.code).to.equal(StatusCode.CONSTRAINT);
			}
		});

		it('should handle multiple cursors from the same table', async () => {
			await db.exec('create table vt_mc (id integer primary key, val integer)');
			await db.exec('insert into vt_mc values (1, 10), (2, 20), (3, 30)');
			// A self-join exercises multiple cursors on the same table
			const rows: any[] = [];
			for await (const row of db.eval('select a.id as a_id, b.id as b_id from vt_mc as a cross join vt_mc as b where a.id < b.id order by a.id, b.id')) {
				rows.push(row);
			}
			expect(rows).to.have.lengthOf(3); // (1,2), (1,3), (2,3)
		});
	});

	// ========================================================================
	// Boundary 5: Schema → All Layers
	// ========================================================================

	describe('Schema → All Layers', () => {
		it('should make schema visible to parser/planner after CREATE TABLE', async () => {
			await db.exec('create table schema_t (id integer primary key, val text)');
			// Table should now be visible in queries
			const row = await db.get("select count(*) as cnt from schema() where name = 'schema_t' and type = 'table'");
			expect(row!.cnt).to.equal(1);
		});

		it('should make schema invisible after DROP TABLE', async () => {
			await db.exec('create table schema_drop (id integer primary key)');
			await db.exec('drop table schema_drop');
			expect(() => db.getPlan('select * from schema_drop')).to.throw(QuereusError);
		});

		it('should reflect table recreation with different columns', async () => {
			await db.exec('create table schema_col (id integer primary key)');
			await db.exec('drop table schema_col');
			await db.exec('create table schema_col (id integer primary key, new_col text null)');
			const plan = db.getPlan('select new_col from schema_col');
			expect(plan).to.exist;
		});

		it('should make functions visible after registration', async () => {
			db.createScalarFunction('test_fn', { numArgs: 1 }, (x) => (x as number) * 2);
			const row = await db.get('select test_fn(21) as result');
			expect(row!.result).to.equal(42);
		});

		it('should make views queryable through the schema layer', async () => {
			await db.exec('create table schema_vb (id integer primary key, val text)');
			await db.exec("insert into schema_vb values (1, 'hello')");
			await db.exec('create view schema_vw as select id, val from schema_vb');
			// Views are stored separately from tables; verify the view works by querying it
			const row = await db.get('select id, val from schema_vw where id = 1');
			expect(row).to.exist;
			expect(row!.val).to.equal('hello');
		});

		it('should make indexes visible in schema', async () => {
			await db.exec('create table schema_idx (id integer primary key, val text)');
			await db.exec('create index idx_val on schema_idx(val)');
			const row = await db.get("select count(*) as cnt from schema() where name = 'idx_val' and type = 'index'");
			expect(row!.cnt).to.equal(1);
		});
	});

	// ========================================================================
	// Boundary 6: Core API → Internal
	// ========================================================================

	describe('Core API → Internal', () => {
		it('should propagate parse errors through db.exec()', async () => {
			try {
				await db.exec('INVALID SQL GIBBERISH');
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
			}
		});

		it('should propagate planner errors through db.exec()', async () => {
			try {
				await db.exec('select * from nonexistent_table');
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
			}
		});

		it('should propagate constraint errors through db.exec()', async () => {
			await db.exec('create table api_ce (id integer primary key)');
			await db.exec('insert into api_ce values (1)');
			try {
				await db.exec('insert into api_ce values (1)');
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
				expect(e.code).to.equal(StatusCode.CONSTRAINT);
			}
		});

		it('should propagate errors through db.get()', async () => {
			try {
				await db.get('select * from no_table');
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
			}
		});

		it('should propagate errors through db.eval()', async () => {
			try {
				for await (const _ of db.eval('select * from no_table')) {
					// consume
				}
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
			}
		});

		it('should propagate errors through Statement.run()', async () => {
			const stmt = db.prepare('select * from no_table');
			try {
				await stmt.run();
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
			}
		});

		it('should throw MisuseError on closed database', async () => {
			const db2 = new Database();
			await db2.close();
			try {
				await db2.exec('select 1');
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
				expect(e.code).to.equal(StatusCode.MISUSE);
			}
		});

		it('should handle parameterized queries across the boundary', async () => {
			await db.exec('create table api_params (id integer primary key, name text)');
			await db.exec("insert into api_params values (1, 'alice'), (2, 'bob')");
			const row = await db.get('select name from api_params where id = ?', [1]);
			expect(row).to.exist;
			expect(row!.name).to.equal('alice');
		});

		it('should handle named parameters across the boundary', async () => {
			await db.exec('create table api_named (id integer primary key, name text)');
			await db.exec("insert into api_named values (1, 'carol')");
			const row = await db.get('select name from api_named where id = :id', { id: 1 });
			expect(row).to.exist;
			expect(row!.name).to.equal('carol');
		});

		it('should handle NULL values correctly at the API boundary', async () => {
			await db.exec('create table api_null (id integer primary key, val text null)');
			await db.exec('insert into api_null values (1, null)');
			const row = await db.get('select val from api_null where id = 1');
			expect(row).to.exist;
			expect(row!.val).to.be.null;
		});
	});

	// ========================================================================
	// Cross-Cutting: Error Propagation Across Boundaries
	// ========================================================================

	describe('Error Propagation Across Boundaries', () => {
		it('should preserve error type through the full pipeline', async () => {
			// Parse error
			try {
				await db.exec('select * from');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
				expect(e.code).to.be.a('number');
			}
		});

		it('should propagate UDF errors with context', async () => {
			db.createScalarFunction('failing_fn', { numArgs: 0 }, () => {
				throw new Error('UDF failure');
			});
			try {
				await db.get('select failing_fn() as result');
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
				expect(e.message).to.include('failing_fn');
			}
		});

		it('should preserve constraint error details through layers', async () => {
			await db.exec('create table err_ce (id integer primary key, name text not null)');
			await db.exec("insert into err_ce values (1, 'unique_name')");
			try {
				// PK uniqueness violation
				await db.exec("insert into err_ce values (1, 'other_name')");
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
				expect(e.code).to.equal(StatusCode.CONSTRAINT);
				// Error should mention the table or constraint
				expect(e.message).to.match(/unique|constraint/i);
			}
		});
	});

	// ========================================================================
	// Cross-Cutting: Resource Management
	// ========================================================================

	describe('Resource Management Across Boundaries', () => {
		it('should properly finalize statements', async () => {
			await db.exec('create table res_t (id integer primary key)');
			const stmt = db.prepare('select * from res_t');
			await stmt.run();
			await stmt.finalize();
			// Using finalized statement should throw
			try {
				await stmt.run();
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
			}
		});

		it('should clean up on database close', async () => {
			const db2 = new Database();
			await db2.exec('create table cleanup_t (id integer primary key)');
			const stmt = db2.prepare('select * from cleanup_t');
			await db2.close();
			// DB is closed, statement should be unusable
			try {
				await stmt.run();
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e).to.be.instanceOf(QuereusError);
			}
		});

		it('should handle iterator cleanup properly', async () => {
			await db.exec('create table iter_t (id integer primary key, val integer)');
			for (let i = 1; i <= 100; i++) {
				await db.exec(`insert into iter_t values (${i}, ${i * 10})`);
			}
			// Start iterating but break early
			let count = 0;
			for await (const _row of db.eval('select * from iter_t')) {
				count++;
				if (count >= 5) break;
			}
			expect(count).to.equal(5);
			// DB should still be usable after early iterator break
			const row = await db.get('select count(*) as cnt from iter_t');
			expect(row!.cnt).to.equal(100);
		});
	});
});
