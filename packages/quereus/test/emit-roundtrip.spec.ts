import { expect } from 'chai';
import { parse, parseAll } from '../src/parser/index.js';
import { astToString, expressionToString, quoteIdentifier } from '../src/emit/index.js';
import type { SelectStmt } from '../src/parser/index.js';

/** Round-trip a full statement: parse → stringify → parse → stringify, compare strings */
function roundTripStmt(sql: string): string {
	const ast1 = parse(sql);
	const str1 = astToString(ast1);
	const ast2 = parse(str1);
	const str2 = astToString(ast2);
	expect(str2, `statement round-trip mismatch for: ${sql}`).to.equal(str1);
	return str1;
}

/** Round-trip an expression via SELECT wrapper */
function roundTripExpr(exprSql: string): string {
	const stmt = parse(`select ${exprSql}`) as SelectStmt;
	const col = stmt.columns[0];
	if (col.type !== 'column') throw new Error('Expected column result');
	const str1 = expressionToString(col.expr);
	const stmt2 = parse(`select ${str1}`) as SelectStmt;
	const col2 = stmt2.columns[0];
	if (col2.type !== 'column') throw new Error('Expected column result');
	const str2 = expressionToString(col2.expr);
	expect(str2, `expression round-trip mismatch for: ${exprSql}`).to.equal(str1);
	return str1;
}

describe('Emit: statement round-trips', () => {

	describe('SELECT', () => {
		it('basic columns', () => {
			roundTripStmt('select a, b, c from t');
		});

		it('WHERE clause', () => {
			roundTripStmt('select x from t where x > 10');
		});

		it('ORDER BY', () => {
			roundTripStmt('select x from t order by x desc');
		});

		it('LIMIT and OFFSET', () => {
			roundTripStmt('select x from t limit 10 offset 5');
		});

		it('GROUP BY and HAVING', () => {
			roundTripStmt('select a, count(*) from t group by a having count(*) > 1');
		});

		it('DISTINCT', () => {
			roundTripStmt('select distinct a, b from t');
		});

		it('compound UNION ALL', () => {
			roundTripStmt('select 1 union all select 2');
		});

		it('compound UNION', () => {
			roundTripStmt('select a from t1 union select b from t2');
		});

		it('compound INTERSECT', () => {
			roundTripStmt('select a from t1 intersect select b from t2');
		});

		it('compound EXCEPT', () => {
			roundTripStmt('select a from t1 except select b from t2');
		});

		it('compound UNION with set-op membership columns', () => {
			// The `exists <branch> as <name>` membership clause sits between the operator
			// keyword and the right leg and round-trips structurally (branch always explicit).
			roundTripStmt('select id, x from a union exists left as inA, exists right as inB select id, x from b');
		});

		it('compound INTERSECT/EXCEPT with single membership column', () => {
			roundTripStmt('select id, x from a intersect exists right as inB select id, x from b');
			roundTripStmt('select id, x from a except exists left as inL select id, x from b');
		});

		it('rejects set-op membership columns on DIFF', () => {
			expect(() => parse('select id from a diff exists left as inA select id from b')).to.throw();
		});

		it('subquery in FROM', () => {
			roundTripStmt('select x from (select 1 as x) as sub');
		});

		it('INNER JOIN', () => {
			roundTripStmt('select a.x, b.y from a inner join b on a.id = b.id');
		});

		it('LEFT JOIN', () => {
			roundTripStmt('select a.x from a left join b on a.id = b.id');
		});

		it('CROSS JOIN', () => {
			roundTripStmt('select a.x from a cross join b');
		});

		it('LEFT JOIN with exists existence column (side resolved)', () => {
			// `exists as f` resolves to the non-preserved (right) side; stringify emits
			// the explicit side, so the round-trip is stable from the second parse on.
			expect(roundTripStmt('select a.x, f from a left join b on a.id = b.id exists as f'))
				.to.equal('select a.x, f from a left join b on a.id = b.id exists right as f');
		});

		it('LEFT JOIN with explicit exists right', () => {
			roundTripStmt('select a.x, f from a left join b on a.id = b.id exists right as f');
		});

		it('FULL JOIN with both-side exists existence columns', () => {
			roundTripStmt('select a.x, fa, fb from a full join b on a.id = b.id exists left as fa, exists right as fb');
		});

		it('rejects exists existence on inner/cross/full-without-side', () => {
			expect(() => parse('select a.x from a inner join b on a.id = b.id exists right as f')).to.throw();
			expect(() => parse('select a.x from a join b on a.id = b.id exists left as f')).to.throw();
			expect(() => parse('select a.x from a full join b on a.id = b.id exists as f')).to.throw();
			// `exists left` on a LEFT join names the preserved side — rejected.
			expect(() => parse('select a.x from a left join b on a.id = b.id exists left as f')).to.throw();
		});

		it('does not absorb a trailing exists-predicate subquery as an existence clause', () => {
			// `exists (` is the predicate form, never the existence clause — a WHERE
			// `exists (...)` after the join must still parse as a predicate.
			roundTripStmt('select a.x from a left join b on a.id = b.id where exists (select 1 from b)');
		});

		it('WITH CTE', () => {
			roundTripStmt('with cte as (select 1 as x) select x from cte');
		});

		it('WITH RECURSIVE', () => {
			roundTripStmt('with recursive r(n) as (select 1 union all select n + 1 from r where n < 10) select n from r');
		});

		it('WITH MATERIALIZED hint', () => {
			roundTripStmt('with x as materialized (select 1) select * from x');
		});

		it('WITH NOT MATERIALIZED hint', () => {
			roundTripStmt('with x as not materialized (select 1) select * from x');
		});

		it('preserves the materialization hint structurally', () => {
			// roundTripStmt only proves idempotence — a dropped hint re-emits identically
			// and still passes it. These assertions check the hint survives the *first*
			// parse→stringify→parse against the original, which is the actual regression.
			// Covers the keyword × {column list, recursive} cross-products that the
			// `withClauseToString` emitter and `commonTableExpression` parser share.
			for (const [sql, expected] of [
				['with x as materialized (select 1) select * from x', 'materialized'],
				['with x as not materialized (select 1) select * from x', 'not_materialized'],
				['with x as (select 1) select * from x', undefined],
				// Column list before AS, hint after.
				['with x (a) as materialized (select 1) select * from x', 'materialized'],
				['with x (a) as not materialized (select 1) select * from x', 'not_materialized'],
				// Recursive CTEs route through the same emitter/parser path.
				['with recursive r(n) as materialized (select 1 union all select n + 1 from r where n < 10) select n from r', 'materialized'],
				['with recursive r(n) as not materialized (select 1 union all select n + 1 from r where n < 10) select n from r', 'not_materialized'],
			] as const) {
				const stmt = parse(sql) as SelectStmt;
				const reparsed = parse(astToString(stmt)) as SelectStmt;
				expect(reparsed.withClause?.ctes[0].materializationHint, sql).to.equal(expected);
			}
		});
	});

	describe('INSERT', () => {
		it('INSERT INTO ... VALUES', () => {
			roundTripStmt("insert into t values (1, 'hello', null)");
		});

		it('INSERT INTO ... SELECT', () => {
			roundTripStmt('insert into t select * from s');
		});

		it('INSERT with column list', () => {
			roundTripStmt("insert into t (a, b) values (1, 2)");
		});

		it('INSERT with RETURNING', () => {
			roundTripStmt("insert into t (a) values (1) returning *");
		});

		it('INSERT with ON CONFLICT DO NOTHING', () => {
			roundTripStmt("insert into t (a) values (1) on conflict do nothing");
		});

		it('INSERT with ON CONFLICT DO UPDATE (upsert)', () => {
			roundTripStmt("insert into t (a, b) values (1, 2) on conflict (a) do update set b = 3");
		});
	});

	describe('UPDATE', () => {
		it('basic SET', () => {
			roundTripStmt('update t set a = 1');
		});

		it('with WHERE', () => {
			roundTripStmt('update t set a = 1 where b > 0');
		});

		it('with RETURNING', () => {
			roundTripStmt('update t set a = 1 returning *');
		});
	});

	describe('DELETE', () => {
		it('basic', () => {
			roundTripStmt('delete from t');
		});

		it('with WHERE', () => {
			roundTripStmt('delete from t where id = 1');
		});

		it('with RETURNING', () => {
			roundTripStmt('delete from t where id = 1 returning *');
		});
	});

	describe('VALUES', () => {
		it('standalone VALUES clause', () => {
			roundTripStmt('values (1, 2), (3, 4)');
		});
	});

	describe('CREATE TABLE', () => {
		it('basic columns with types', () => {
			roundTripStmt('create table t (a integer, b text)');
		});

		it('table-level tags', () => {
			roundTripStmt("create table t (a integer) with tags (display_name = 'Orders', audit = true)");
		});

		it('column-level tags', () => {
			roundTripStmt("create table t (a integer with tags (display_name = 'ID'), b text)");
		});

		it('column constraint tags', () => {
			roundTripStmt("create table t (a integer check (a > 0) with tags (error_message = 'Must be positive'))");
		});

		it('table constraint tags', () => {
			roundTripStmt("create table t (a integer, b integer, constraint uq unique (a) with tags (label = 'uq'))");
		});

		it('tag value types', () => {
			roundTripStmt("create table t (a integer) with tags (s = 'hi', n = 42, f = 3.14, bt = true, bf = false, z = null, neg = -10)");
		});

		it('combined WITH TAGS and WITH CONTEXT', () => {
			roundTripStmt("create table t (a integer) with context (user_name text) with tags (audit = true)");
		});

		it('combined WITH TAGS before WITH CONTEXT', () => {
			roundTripStmt("create table t (a integer) with tags (audit = true) with context (user_name text)");
		});

		it('PRIMARY KEY constraint', () => {
			roundTripStmt('create table t (id integer primary key, name text)');
		});

		it('NOT NULL and UNIQUE', () => {
			roundTripStmt('create table t (id integer not null unique)');
		});

		it('DEFAULT value', () => {
			roundTripStmt('create table t (a integer default 0)');
		});

		it('DEFAULT reading a populated sibling via new.<column>', () => {
			// The `new.` qualifier must survive the round-trip — dropping it would
			// silently corrupt the feature under schema export / declarative apply.
			const out = roundTripStmt(
				'create table t (id integer primary key, base integer, title text, doubled integer default (new.base * 2), slug text default (lower(new.title)))'
			);
			expect(out).to.contain('new.base');
			expect(out).to.contain('new.title');
		});

		it('CHECK constraint', () => {
			roundTripStmt('create table t (a integer check (a > 0))');
		});

		it('FOREIGN KEY column constraint', () => {
			roundTripStmt('create table orders (user_id integer references users(id))');
		});

		it('IF NOT EXISTS', () => {
			roundTripStmt('create table if not exists t (a integer)');
		});

		it('table-level PRIMARY KEY', () => {
			roundTripStmt('create table t (a integer, b integer, primary key (a, b))');
		});

		it('table-level FOREIGN KEY', () => {
			roundTripStmt('create table orders (user_id integer, foreign key (user_id) references users(id))');
		});

		it('GENERATED column', () => {
			roundTripStmt('create table t (a integer, b integer generated always as (a * 2))');
		});
	});

	describe('CREATE INDEX', () => {
		it('basic', () => {
			roundTripStmt('create index idx on t (a)');
		});

		it('UNIQUE', () => {
			roundTripStmt('create unique index idx on t (a)');
		});

		it('IF NOT EXISTS', () => {
			roundTripStmt('create index if not exists idx on t (a)');
		});

		it('partial index with WHERE', () => {
			roundTripStmt('create index idx on t (a) where a > 0');
		});

		it('with tags', () => {
			roundTripStmt("create index idx on t (a) with tags (purpose = 'search')");
		});
	});

	describe('CREATE VIEW', () => {
		it('basic', () => {
			roundTripStmt('create view v as select * from t');
		});

		it('IF NOT EXISTS', () => {
			roundTripStmt('create view if not exists v as select * from t');
		});

		it('with column list', () => {
			roundTripStmt('create view v (x, y) as select a, b from t');
		});

		it('with tags', () => {
			roundTripStmt("create view v as select * from t with tags (cacheable = true)");
		});
	});

	describe('CREATE MATERIALIZED VIEW', () => {
		// Post-consolidation shape: bare `create materialized view … as select …`
		// with NO `with refresh` policy clause (every MV is row-time maintained).
		it('basic (no refresh policy)', () => {
			roundTripStmt('create materialized view mv as select id, x from t');
		});

		it('IF NOT EXISTS', () => {
			roundTripStmt('create materialized view if not exists mv as select id, x from t');
		});

		it('with column list', () => {
			roundTripStmt('create materialized view mv (a, b) as select id, x from t');
		});

		it('with a partial (WHERE) + ORDER BY body', () => {
			roundTripStmt('create materialized view mv as select x, id from t where x > 0 order by x');
		});

		it('with tags', () => {
			roundTripStmt('create materialized view mv as select id, x from t with tags (owner = \'me\')');
		});
	});

	describe('DROP', () => {
		it('DROP TABLE', () => {
			roundTripStmt('drop table t');
		});

		it('DROP INDEX', () => {
			roundTripStmt('drop index idx');
		});

		it('DROP VIEW', () => {
			roundTripStmt('drop view v');
		});

		it('DROP TABLE IF EXISTS', () => {
			roundTripStmt('drop table if exists t');
		});
	});

	describe('ALTER TABLE', () => {
		it('RENAME TO', () => {
			roundTripStmt('alter table t rename to t2');
		});

		it('RENAME COLUMN', () => {
			roundTripStmt('alter table t rename column a to b');
		});

		it('ADD COLUMN', () => {
			roundTripStmt('alter table t add column c integer');
		});

		it('DROP COLUMN', () => {
			roundTripStmt('alter table t drop column c');
		});

		it('SET TAGS (table)', () => {
			roundTripStmt("alter table t set tags (display_name = 'T', audit = true)");
		});

		it('SET TAGS () clear (table)', () => {
			roundTripStmt('alter table t set tags ()');
		});

		it('ALTER COLUMN SET TAGS', () => {
			roundTripStmt("alter table t alter column c set tags (searchable = true)");
		});

		it('ALTER COLUMN SET TAGS () clear', () => {
			roundTripStmt('alter table t alter column c set tags ()');
		});

		it('ALTER CONSTRAINT SET TAGS', () => {
			roundTripStmt("alter table t alter constraint uq set tags (msg = 'dup')");
		});
	});

	describe('Transaction', () => {
		it('BEGIN', () => {
			roundTripStmt('begin');
		});

		it('COMMIT', () => {
			roundTripStmt('commit');
		});

		it('ROLLBACK', () => {
			roundTripStmt('rollback');
		});

		it('SAVEPOINT', () => {
			roundTripStmt('savepoint sp1');
		});

		it('RELEASE', () => {
			roundTripStmt('release sp1');
		});

		it('ROLLBACK TO', () => {
			roundTripStmt('rollback to sp1');
		});

		// Reserved-word savepoint names (the `release to` regression class) are now
		// covered exhaustively — every keyword, every savepoint form — by the
		// position-by-position suite in `emit-roundtrip-positions.spec.ts`.
	});

	describe('PRAGMA', () => {
		it('bare pragma', () => {
			roundTripStmt('pragma table_info');
		});

		it('pragma = value', () => {
			roundTripStmt('pragma cache_size = 1000');
		});
	});

	describe('ANALYZE', () => {
		it('bare', () => {
			roundTripStmt('analyze');
		});

		it('with table name', () => {
			roundTripStmt('analyze users');
		});
	});
});

describe('Emit: expression round-trips', () => {

	describe('Literals', () => {
		it('integer', () => {
			roundTripExpr('42');
		});

		it('float', () => {
			roundTripExpr('3.14');
		});

		it('negative number', () => {
			roundTripExpr('-1');
		});

		it('string', () => {
			roundTripExpr("'hello'");
		});

		it('NULL', () => {
			roundTripExpr('null');
		});

		it('blob literal', () => {
			roundTripExpr("x'ABCD'");
		});
	});

	describe('Column references', () => {
		it('simple column', () => {
			roundTripExpr('a');
		});

		it('table.column', () => {
			roundTripExpr('t.a');
		});
	});

	describe('Unary operators', () => {
		it('NOT expr', () => {
			roundTripExpr('not a');
		});

		it('-expr', () => {
			roundTripExpr('-a');
		});

		it('expr IS NULL', () => {
			roundTripExpr('a is null');
		});

		it('expr IS NOT NULL', () => {
			roundTripExpr('a is not null');
		});

		it('expr IS TRUE', () => {
			roundTripExpr('a is true');
		});

		it('expr IS NOT TRUE', () => {
			roundTripExpr('a is not true');
		});

		it('expr IS FALSE', () => {
			roundTripExpr('a is false');
		});

		it('expr IS NOT FALSE', () => {
			roundTripExpr('a is not false');
		});
	});

	describe('Function calls', () => {
		it('simple function', () => {
			roundTripExpr('length(x)');
		});

		it('multi-arg function', () => {
			roundTripExpr('substr(x, 1, 3)');
		});

		it('count(*)', () => {
			roundTripExpr('count(*)');
		});

		it('count(distinct x)', () => {
			roundTripExpr('count(distinct x)');
		});
	});

	describe('CAST', () => {
		it('cast to integer', () => {
			roundTripExpr('cast(x as integer)');
		});

		it('cast to text', () => {
			roundTripExpr('cast(x as text)');
		});
	});

	describe('CASE', () => {
		it('simple CASE x WHEN', () => {
			roundTripExpr("case x when 1 then 'a' when 2 then 'b' end");
		});

		it('searched CASE WHEN', () => {
			roundTripExpr("case when x > 0 then 'pos' when x < 0 then 'neg' end");
		});

		it('CASE with ELSE', () => {
			roundTripExpr("case when x > 0 then 'pos' else 'other' end");
		});
	});

	describe('Subquery expression', () => {
		it('scalar subquery', () => {
			roundTripExpr('(select 1)');
		});
	});

	describe('EXISTS', () => {
		it('exists subquery', () => {
			roundTripExpr('exists (select 1 from t)');
		});
	});

	describe('IN', () => {
		it('in value list', () => {
			roundTripExpr('x in (1, 2, 3)');
		});

		it('in subquery', () => {
			roundTripExpr('x in (select id from t)');
		});
	});

	describe('BETWEEN', () => {
		it('x between 1 and 10', () => {
			roundTripExpr('x between 1 and 10');
		});

		it('x not between 1 and 10', () => {
			roundTripExpr('x not between 1 and 10');
		});
	});

	describe('COLLATE', () => {
		it('collate nocase', () => {
			roundTripExpr('x collate nocase');
		});
	});

	describe('Window functions', () => {
		it('row_number() over (order by x)', () => {
			roundTripExpr('row_number() over (order by x)');
		});

		it('sum with partition by', () => {
			roundTripExpr('sum(x) over (partition by y order by z)');
		});

		it('with frame spec', () => {
			roundTripExpr('sum(x) over (order by y rows between unbounded preceding and current row)');
		});
	});

	describe('Nested/compound', () => {
		it('function of arithmetic', () => {
			roundTripExpr('abs(a + b * c)');
		});

		it('CASE with IN', () => {
			roundTripExpr("case when x in (1, 2) then 'a' else 'b' end");
		});
	});
});

describe('Emit: identifier quoting', () => {
	it('normal identifier is not quoted', () => {
		expect(quoteIdentifier('users')).to.equal('users');
	});

	it('reserved keyword "select" is quoted', () => {
		expect(quoteIdentifier('select')).to.equal('"select"');
	});

	it('reserved keyword "from" is quoted', () => {
		expect(quoteIdentifier('from')).to.equal('"from"');
	});

	it('reserved keyword "table" is quoted', () => {
		expect(quoteIdentifier('table')).to.equal('"table"');
	});

	it('identifier with spaces is quoted', () => {
		expect(quoteIdentifier('my table')).to.equal('"my table"');
	});

	it('identifier starting with digit is quoted', () => {
		expect(quoteIdentifier('1abc')).to.equal('"1abc"');
	});

	it('embedded double quotes are escaped', () => {
		expect(quoteIdentifier('a"b')).to.equal('"a""b"');
	});

	it('underscore-prefixed identifier is not quoted', () => {
		expect(quoteIdentifier('_private')).to.equal('_private');
	});
});

describe('Emit: string literal escaping', () => {
	it('simple string', () => {
		const result = roundTripExpr("'hello'");
		expect(result).to.equal("'hello'");
	});

	it('string with embedded single quote', () => {
		const result = roundTripExpr("'it''s'");
		expect(result).to.equal("'it''s'");
	});

	it('empty string', () => {
		const result = roundTripExpr("''");
		expect(result).to.equal("''");
	});

	it('string with multiple quotes', () => {
		const result = roundTripExpr("'a''b''c'");
		expect(result).to.equal("'a''b''c'");
	});
});

describe('Emit: edge cases', () => {
	it('NULL literal round-trip', () => {
		roundTripStmt('select null');
	});

	it('aliased expression', () => {
		roundTripStmt('select 1 as x');
	});

	it('star expression', () => {
		roundTripStmt('select *');
	});

	it('table.star', () => {
		roundTripStmt('select t.* from t');
	});

	it('schema-qualified table in FROM', () => {
		roundTripStmt('select * from main.t');
	});

	it('multiple statements via parseAll', () => {
		const stmts = parseAll('select 1; select 2');
		expect(stmts).to.have.length(2);
		for (const stmt of stmts) {
			const str1 = astToString(stmt);
			const ast2 = parse(str1);
			const str2 = astToString(ast2);
			expect(str2).to.equal(str1);
		}
	});
});
