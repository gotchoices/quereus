/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { Database, QuereusError } from '../src/index.js';

describe('Core API Features', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// ========================================================================
	// 1. Function Registration
	// ========================================================================

	describe('Function Registration', () => {

		describe('createScalarFunction()', () => {

			it('should register a simple scalar function and use it in a query', async () => {
				db.createScalarFunction('double', { numArgs: 1 }, (x) => {
					return (x as number) * 2;
				});

				const row = await db.get('select double(21) as result');
				void expect(row).to.exist;
				void expect(row!.result).to.equal(42);
			});

			it('should register a deterministic function', async () => {
				db.createScalarFunction('add_ten', { numArgs: 1, deterministic: true }, (x) => {
					return (x as number) + 10;
				});

				const row = await db.get('select add_ten(5) as result');
				void expect(row).to.exist;
				void expect(row!.result).to.equal(15);
			});

			it('should pass correct arguments to the registered function', async () => {
				const receivedArgs: any[] = [];

				db.createScalarFunction('capture_args', { numArgs: 3 }, (a, b, c) => {
					receivedArgs.push(a, b, c);
					return 1;
				});

				await db.get("select capture_args(42, 'hello', 3.14) as result");

				void expect(receivedArgs).to.have.length(3);
				void expect(receivedArgs[0]).to.equal(42);
				void expect(receivedArgs[1]).to.equal('hello');
				void expect(receivedArgs[2]).to.be.closeTo(3.14, 0.001);
			});

			it('should propagate errors from the function to the query', async () => {
				db.createScalarFunction('blow_up', { numArgs: 0 }, () => {
					throw new Error('kaboom');
				});

				try {
					await db.get('select blow_up() as result');
					expect.fail('Should have thrown');
				} catch (err) {
					void expect(err).to.be.instanceOf(Error);
					void expect((err as Error).message).to.include('kaboom');
				}
			});
		});

		describe('createAggregateFunction()', () => {

			it('should register a custom aggregate and use in a GROUP BY query', async () => {
				db.createAggregateFunction(
					'string_agg',
					{ numArgs: 1, initialState: '' },
					(acc, val) => (acc as string) + (acc ? ',' : '') + String(val),
					(acc) => acc as string
				);

				await db.exec('create table items (category text, name text)');
				await db.exec("insert into items values ('fruit', 'apple')");
				await db.exec("insert into items values ('fruit', 'banana')");
				await db.exec("insert into items values ('veggie', 'carrot')");

				const rows: any[] = [];
				for await (const row of db.eval(
					"select category, string_agg(name) as names from items group by category order by category"
				)) {
					rows.push(row);
				}

				void expect(rows).to.have.length(2);
				void expect(rows[0].category).to.equal('fruit');
				// Order within group may vary, just check both names present
				void expect(rows[0].names).to.include('apple');
				void expect(rows[0].names).to.include('banana');
				void expect(rows[1].category).to.equal('veggie');
				void expect(rows[1].names).to.include('carrot');
			});

			it('should support initialState for the aggregate', async () => {
				db.createAggregateFunction(
					'sum_from_100',
					{ numArgs: 1, initialState: 100 },
					(acc, val) => (acc as number) + (val as number),
					(acc) => acc as number
				);

				await db.exec('create table nums (val integer)');
				await db.exec('insert into nums values (1), (2), (3)');

				const row = await db.get('select sum_from_100(val) as total from nums');
				void expect(row).to.exist;
				void expect(row!.total).to.equal(106);
			});

			it('should handle empty groups', async () => {
				db.createAggregateFunction(
					'concat_all',
					{ numArgs: 1, initialState: '' },
					(acc, val) => (acc as string) + String(val),
					(acc) => acc as string || null
				);

				await db.exec('create table empty_t (val text)');

				const row = await db.get('select concat_all(val) as result from empty_t');
				void expect(row).to.exist;
				// Empty aggregation: finalizer receives the initial state ('')
				// which becomes null via the || null fallback
				void expect(row!.result).to.satisfy((v: any) => v === null || v === '');
			});
		});
	});

	// ========================================================================
	// 2. Statement Metadata
	// ========================================================================

	describe('Statement Metadata', () => {

		beforeEach(async () => {
			await db.exec('create table meta_t (id integer primary key, name text, score real)');
			await db.exec("insert into meta_t values (1, 'Alice', 95.5)");
		});

		describe('getColumnNames()', () => {

			it('should return correct names for a simple select', () => {
				const stmt = db.prepare('select id, name, score from meta_t');
				const names = stmt.getColumnNames();
				void expect(names).to.deep.equal(['id', 'name', 'score']);
			});

			it('should return aliased names', () => {
				const stmt = db.prepare('select id as user_id, name as user_name from meta_t');
				const names = stmt.getColumnNames();
				void expect(names).to.deep.equal(['user_id', 'user_name']);
			});
		});

		describe('getColumnType()', () => {

			it('should return correct type for INTEGER column', () => {
				const stmt = db.prepare('select id from meta_t');
				const colType = stmt.getColumnType(0);
				void expect(colType).to.exist;
				void expect(colType.logicalType.name).to.match(/integer/i);
			});

			it('should return correct type for TEXT column', () => {
				const stmt = db.prepare('select name from meta_t');
				const colType = stmt.getColumnType(0);
				void expect(colType).to.exist;
				void expect(colType.logicalType.name).to.match(/text/i);
			});

			it('should throw RangeError for out-of-bounds index', () => {
				const stmt = db.prepare('select id from meta_t');
				try {
					stmt.getColumnType(99);
					expect.fail('Should have thrown');
				} catch (err) {
					void expect(err).to.be.instanceOf(RangeError);
				}
			});
		});

		describe('getColumnName()', () => {

			it('should return correct name by index', () => {
				const stmt = db.prepare('select id, name, score from meta_t');
				void expect(stmt.getColumnName(0)).to.equal('id');
				void expect(stmt.getColumnName(1)).to.equal('name');
				void expect(stmt.getColumnName(2)).to.equal('score');
			});

			it('should throw RangeError for out-of-bounds index', () => {
				const stmt = db.prepare('select id from meta_t');
				try {
					stmt.getColumnName(5);
					expect.fail('Should have thrown');
				} catch (err) {
					void expect(err).to.be.instanceOf(RangeError);
				}
			});
		});

		describe('isQuery()', () => {

			it('should return true for SELECT', () => {
				const stmt = db.prepare('select * from meta_t');
				void expect(stmt.isQuery()).to.be.true;
			});

			it('should return false for INSERT', () => {
				const stmt = db.prepare("insert into meta_t values (2, 'Bob', 88.0)");
				void expect(stmt.isQuery()).to.be.false;
			});
		});
	});

	// ========================================================================
	// 3. Schema Management
	// ========================================================================

	describe('Schema Management', () => {

		describe('setSchemaPath() / getSchemaPath()', () => {

			it('should set and get schema path', () => {
				db.setSchemaPath(['main', 'extensions', 'plugins']);
				const path = db.getSchemaPath();
				void expect(path).to.deep.equal(['main', 'extensions', 'plugins']);
			});

			it('should have default schema path of [\'main\']', () => {
				const path = db.getSchemaPath();
				void expect(path).to.deep.equal(['main']);
			});
		});

		describe('setOption() / getOption()', () => {

			it('should set and get a known option', () => {
				db.setOption('runtime_stats', true);
				const value = db.getOption('runtime_stats');
				void expect(value).to.equal(true);
			});

			it('should get default value for unset option', () => {
				const value = db.getOption('runtime_stats');
				void expect(value).to.equal(false);
			});

			it('should reject invalid onChange value and roll back', () => {
				// default_column_nullability has an onChange that throws for invalid values
				const before = db.getOption('default_column_nullability');
				void expect(before).to.equal('not_null');

				void expect(() => {
					db.setOption('default_column_nullability', 'bogus');
				}).to.throw(QuereusError);

				// Value must remain unchanged after the rejected set
				const after = db.getOption('default_column_nullability');
				void expect(after).to.equal('not_null');
			});

			it('should accept valid onChange value', () => {
				db.setOption('default_column_nullability', 'nullable');
				const value = db.getOption('default_column_nullability');
				void expect(value).to.equal('nullable');
			});
		});
	});

	// ========================================================================
	// 4. Statement Batch Operations
	// ========================================================================

	describe('Statement Batch Operations', () => {

		describe('nextStatement()', () => {

			it('should advance through a multi-statement batch', () => {
				const stmt = db.prepare(
					"create table t (id integer primary key); insert into t values (1); select * from t"
				);

				// Already on first statement (index 0)
				const advanced1 = stmt.nextStatement();
				void expect(advanced1).to.be.true;

				const advanced2 = stmt.nextStatement();
				void expect(advanced2).to.be.true;
			});

			it('should return false when no more statements', () => {
				const stmt = db.prepare('select 1 as x');

				// Already on the only statement — advancing should return false
				const advanced = stmt.nextStatement();
				void expect(advanced).to.be.false;
			});
		});
	});

	// ========================================================================
	// 5. ParseError Preservation
	// ========================================================================

	describe('ParseError Preservation', () => {

		it('should preserve line/column info from a parse error', () => {
			try {
				db.prepare('select * from');
				expect.fail('Should have thrown a parse error');
			} catch (err) {
				void expect(err).to.be.instanceOf(QuereusError);
				const qErr = err as QuereusError;
				void expect(qErr.line).to.be.a('number');
				void expect(qErr.column).to.be.a('number');
				void expect(qErr.message).to.match(/line \d+.*column \d+/i);
			}
		});
	});
});
