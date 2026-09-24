import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { getParameterTypes, normalizeParamKey } from '../src/core/param.js';
import type { ScalarType } from '../src/common/datatype.js';
import type { SqlValue } from '../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Parameter Type System', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('PRAGMA default_vtab_module=memory');
	});

	afterEach(async () => {
		await db.close();
	});

	describe('Type Inference from JavaScript Values', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE type_test (
					id INTEGER PRIMARY KEY,
					int_col INTEGER NULL,
					real_col REAL NULL,
					text_col TEXT NULL,
					bool_col BOOLEAN NULL,
					blob_col BLOB NULL
				)
			`);
		});

		it('should infer INTEGER from JavaScript integer number', async () => {
			await db.exec('INSERT INTO type_test (id, int_col) VALUES (?, ?)', [1, 42]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT int_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].int_col).to.equal(42);
		});

		it('should infer REAL from JavaScript float number', async () => {
			await db.exec('INSERT INTO type_test (id, real_col) VALUES (?, ?)', [1, 3.14]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT real_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].real_col).to.equal(3.14);
		});

		it('should infer INTEGER from JavaScript bigint', async () => {
			await db.exec('INSERT INTO type_test (id, int_col) VALUES (?, ?)', [1, 9007199254740991n]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT int_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			// A bound bigint INSIDE the safe-integer range canonicalizes to `number` at the
			// bind boundary and is stored and returned in that form — R1, and the documented
			// API surface (docs/types.md § Physical representation). The VALUE round-trips
			// exactly; only its JavaScript form changes.
			expect(rows[0].int_col).to.equal(9007199254740991);
		});

		it('keeps a bound bigint PAST the safe-integer range exact', async () => {
			// The companion to the case above: outside the safe range `bigint` IS the canonical
			// form, so it survives the round trip untouched rather than being narrowed (which
			// would round it to 9007199254740994).
			await db.exec('INSERT INTO type_test (id, int_col) VALUES (?, ?)', [1, 9007199254740993n]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT int_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].int_col).to.equal(9007199254740993n);
		});

		it('should infer TEXT from JavaScript string', async () => {
			await db.exec('INSERT INTO type_test (id, text_col) VALUES (?, ?)', [1, 'hello']);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT text_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].text_col).to.equal('hello');
		});

		it('should infer BOOLEAN from JavaScript boolean', async () => {
			await db.exec('INSERT INTO type_test (id, bool_col) VALUES (?, ?)', [1, true]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT bool_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].bool_col).to.equal(true);
		});

		it('should infer BLOB from JavaScript Uint8Array', async () => {
			const blob = new Uint8Array([1, 2, 3, 4]);
			await db.exec('INSERT INTO type_test (id, blob_col) VALUES (?, ?)', [1, blob]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT blob_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].blob_col).to.be.instanceof(Uint8Array);
			expect(Array.from(rows[0].blob_col as Uint8Array)).to.deep.equal([1, 2, 3, 4]);
		});

		it('should handle NULL parameters', async () => {
			await db.exec('INSERT INTO type_test (id, text_col) VALUES (?, ?)', [1, null]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT text_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].text_col).to.be.null;
		});
	});

	describe('getParameterTypes key normalization', () => {
		it('keys an array-supplied positional hint by number', () => {
			const hints = getParameterTypes([9]);
			expect([...hints!.keys()]).to.deep.equal([1]);
			expect(typeof [...hints!.keys()][0]).to.equal('number');
		});

		it('keys a boundArgs-supplied positional hint (object with numeric-string key) by number too', () => {
			// This is the shape `getParameterTypes` sees on the bind()/bindAll() path
			// (Statement.boundArgs), where the key came from `boundArgs[index + 1]` and JS
			// object indexing has already stringified it.
			const hints = getParameterTypes({ 1: 9 });
			expect([...hints!.keys()]).to.deep.equal([1]);
			expect(typeof [...hints!.keys()][0]).to.equal('number');
		});

		it('keys a leading-zero index by its number, matching the `:007` slot convention', () => {
			expect([...getParameterTypes({ '01': 9 })!.keys()]).to.deep.equal([1]);
			expect([...getParameterTypes({ '007': 9 })!.keys()]).to.deep.equal([7]);
		});

		it('does not renumber a name that merely starts with digits', () => {
			expect([...getParameterTypes({ '1abc': 9 })!.keys()]).to.deep.equal(['1abc']);
		});

		it('normalizeParamKey matches the same rule directly', () => {
			expect(normalizeParamKey('1')).to.equal(1);
			expect(normalizeParamKey('0')).to.equal(0);
			expect(normalizeParamKey('01')).to.equal(1);
			expect(normalizeParamKey('007')).to.equal(7);
			expect(normalizeParamKey('1abc')).to.equal('1abc');
			expect(normalizeParamKey('name')).to.equal('name');
		});

		it('leaves an index past 2^53 as a string so distinct names cannot collide', () => {
			expect(normalizeParamKey('9007199254740993')).to.equal('9007199254740993');
			expect(normalizeParamKey('9007199254740994')).to.equal('9007199254740994');
		});
	});

	describe('Positional parameters bound after prepare (bind/bindAll)', () => {
		it('announces INTEGER for a number bound via bindAll, matching the prepare-time array path', async () => {
			const prepared = db.prepare('select ? as v', [9]);
			expect(prepared.getColumnDefs()[0].type.logicalType.name).to.equal('INTEGER');
			await prepared.finalize();

			const bound = db.prepare('select ? as v');
			bound.bindAll([9]);
			expect(bound.getColumnDefs()[0].type.logicalType.name).to.equal('INTEGER');
			await bound.finalize();
		});

		it('announces the matching type for each JS value kind bound via bindAll', async () => {
			const cases: ReadonlyArray<{ bound: SqlValue; expected: string }> = [
				{ bound: 9, expected: 'INTEGER' },
				{ bound: 'hello', expected: 'TEXT' },
				{ bound: new Uint8Array([1, 2]), expected: 'BLOB' },
				{ bound: true, expected: 'BOOLEAN' },
				{ bound: 9007199254740993n, expected: 'INTEGER' },
			];
			for (const { bound, expected } of cases) {
				const stmt = db.prepare('select ? as v');
				stmt.bindAll([bound]);
				expect(stmt.getColumnDefs()[0].type.logicalType.name, `bound=${String(bound)}`).to.equal(expected);
				await stmt.finalize();
			}
		});

		it('still rejects a physical-type mismatch on a positional parameter bound via bindAll', async () => {
			const stmt = db.prepare('select ? as v');
			stmt.bindAll([9]);
			stmt.compile(); // Freezes parameterTypes to INTEGER from the initial bind.

			let error: Error | undefined;
			try {
				await stmt.get([3.14]);
			} catch (e) {
				error = e as Error;
			}
			expect(error).to.exist;
			expect(error!.message).to.include('Parameter type mismatch');
			await stmt.finalize();
		});

		it('announces INTEGER for a named parameter bound via bindAll (already correct before this fix)', async () => {
			const stmt = db.prepare('select :p as v');
			stmt.bindAll({ p: 7n });
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('INTEGER');
			await stmt.finalize();
		});

		it('announces INTEGER for a single-key bind() too, not just bindAll', async () => {
			const stmt = db.prepare('select ? as v');
			stmt.bind(1, 9);
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('INTEGER');
			await stmt.finalize();
		});

		it('types each positional slot independently when several are bound', async () => {
			const stmt = db.prepare('select ? as a, ? as b, ? as c');
			stmt.bindAll([9, 'x', new Uint8Array([1])]);
			expect(stmt.getColumnDefs().map(c => c.type.logicalType.name)).to.deep.equal(['INTEGER', 'TEXT', 'BLOB']);
			await stmt.finalize();
		});

		it('announces INTEGER for a `:`-prefixed named key in the bound object', async () => {
			const stmt = db.prepare('select :p as v');
			stmt.bindAll({ ':p': 9 });
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('INTEGER');
			await stmt.finalize();
		});
	});

	describe('`:N` named-index parameters', () => {
		it('resolves a leading-zero index to its positional slot', async () => {
			expect(await db.get('select :01 as v', [9])).to.deep.equal({ v: 9 });
			expect(await db.get('select :002 as v', [8, 9])).to.deep.equal({ v: 9 });
		});

		it('announces the bound value type for a leading-zero index', async () => {
			const stmt = db.prepare('select :01 as v');
			stmt.bindAll([9]);
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('INTEGER');
			await stmt.finalize();
		});

		it('resolves a plain numeric index to its positional slot', async () => {
			expect(await db.get('select :2 as v', [8, 9])).to.deep.equal({ v: 9 });
		});
	});

	describe('Parameter types are established from the first binding source', () => {
		it('announces ANY before the first bind and the bound type after', async () => {
			const stmt = db.prepare('select ? as v');
			// Nothing is bound yet, so there is no type to announce — and this compile
			// must NOT freeze that emptiness as the established answer.
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('ANY');
			stmt.bindAll([9]);
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('INTEGER');
			await stmt.finalize();
		});

		it('keeps the first established type frozen across later binds', async () => {
			const stmt = db.prepare('select ? as v');
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('ANY');
			stmt.bindAll([9]);
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('INTEGER');
			// Established once, established for good: a REAL value is now a mismatch,
			// not a re-inference.
			stmt.bindAll([3.14]);
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('INTEGER');
			let error: Error | undefined;
			try {
				await stmt.get();
			} catch (e) {
				error = e as Error;
			}
			expect(error, 'expected a frozen-type mismatch').to.exist;
			expect(error!.message).to.include('Parameter type mismatch');
			await stmt.finalize();
		});
	});

	describe('A parameter first bound after the plan was built still gets its type', () => {
		// The plan a statement caches announces the parameter types known when it was
		// built. Binding a value for a parameter that plan had NO type for has to discard
		// it, or that parameter stays ANY for the statement's whole life and a cross-type
		// comparison against it silently matches nothing.
		beforeEach(async () => {
			await db.exec('create table w (k integer primary key, a text, b text)');
			await db.exec("insert into w values (1, '5', '7')");
		});

		it('types a second parameter bound after an introspecting compile', async () => {
			const stmt = db.prepare('select k from w where a = :x and b = :y');
			stmt.bind('x', 5);
			// Compiles with only :x typed — :y is ANY in this plan.
			expect(stmt.getColumnDefs().map(c => c.name)).to.deep.equal(['k']);
			stmt.bind('y', 7);
			const rows: ResultRow[] = [];
			for await (const row of stmt.all()) rows.push(row);
			expect(rows).to.deep.equal([{ k: 1 }]);
			await stmt.finalize();
		});

		it('types a parameter bound after preparing with an empty parameter collection', async () => {
			for (const empty of [[], {}] as ReadonlyArray<SqlValue[] | Record<string, SqlValue>>) {
				const stmt = db.prepare('select ? as v', empty);
				stmt.bindAll([9]);
				expect(stmt.getColumnDefs()[0].type.logicalType.name, JSON.stringify(empty)).to.equal('INTEGER');
				await stmt.finalize();
			}
		});

		it('leaves an already-typed parameter frozen while typing a newly bound one', async () => {
			const stmt = db.prepare('select :x as x, :y as y');
			stmt.bind('x', 9);
			expect(stmt.getColumnDefs().map(c => c.type.logicalType.name)).to.deep.equal(['INTEGER', 'ANY']);
			stmt.bind('y', 'text');
			expect(stmt.getColumnDefs().map(c => c.type.logicalType.name)).to.deep.equal(['INTEGER', 'TEXT']);
			// :x keeps the type its first value established, so a REAL is still a mismatch.
			stmt.bind('x', 3.14);
			let error: Error | undefined;
			try {
				await stmt.get();
			} catch (e) {
				error = e as Error;
			}
			expect(error, 'expected a frozen-type mismatch on :x').to.exist;
			expect(error!.message).to.include('Parameter type mismatch');
			await stmt.finalize();
		});

		it('does not poison the executed plan when getChangeScope() runs before any bind', async () => {
			// getChangeScope() plans through getAnalysisPlan(), a second compile-before-bind
			// site that shares establishParameterTypes with compile().
			const stmt = db.prepare('select k from w where a = ?');
			expect(stmt.getChangeScope()).to.exist;
			const rows: ResultRow[] = [];
			for await (const row of stmt.all([5])) rows.push(row);
			expect(rows).to.deep.equal([{ k: 1 }]);
			await stmt.finalize();
		});
	});

	describe('Cross-type parameter comparison agrees across entry points', () => {
		// A statement compiled before its first bind plans every parameter as ANY, so no
		// comparison-site coercion is minted and a cross-type comparison silently matches
		// nothing. Every entry point that introspects (getColumnNames/getColumnDefs) before
		// binding used to land there, while the ones that bind at prepare() did not — two
		// eval() calls differing only in readConcurrency disagreed. This is the test for the
		// whole class: one query, every entry point, same rows.
		type Reader = (sql: string, params: SqlValue[]) => Promise<ResultRow[]>;

		const drain = async (rows: AsyncIterable<ResultRow>): Promise<ResultRow[]> => {
			const out: ResultRow[] = [];
			for await (const row of rows) out.push(row);
			return out;
		};

		const readers: ReadonlyArray<{ name: string; read: Reader }> = [
			{ name: 'db.eval', read: (sql, params) => drain(db.eval(sql, params)) },
			{
				name: "db.eval readConcurrency: 'committed'",
				read: (sql, params) => drain(db.eval(sql, params, { readConcurrency: 'committed' })),
			},
			{
				// The batch's last statement is run by a Statement built inside _evalGenerator,
				// which is a second compile-before-bind site.
				name: 'db.eval over a multi-statement batch',
				read: (sql, params) => drain(db.eval(`select 1 as ignored; ${sql}`, params)),
			},
			{
				name: 'db.get',
				read: async (sql, params) => {
					const row = await db.get(sql, params);
					return row ? [row] : [];
				},
			},
			{
				name: 'db.prepare(sql, params).all()',
				read: async (sql, params) => {
					const stmt = db.prepare(sql, params);
					try {
						return await drain(stmt.all());
					} finally {
						await stmt.finalize();
					}
				},
			},
			{
				name: 'db.prepare(sql).all(params)',
				read: async (sql, params) => {
					const stmt = db.prepare(sql);
					try {
						return await drain(stmt.all(params));
					} finally {
						await stmt.finalize();
					}
				},
			},
			{
				name: 'db.prepare(sql).get(params)',
				read: async (sql, params) => {
					const stmt = db.prepare(sql);
					try {
						const row = await stmt.get(params);
						return row ? [row] : [];
					} finally {
						await stmt.finalize();
					}
				},
			},
			{
				// An empty parameter collection at prepare() supplies no type for anything,
				// which must read as "nothing typed yet" and not as "typed, and there are
				// none" — the wrapper spelling `run(sql, params = [])` lands here.
				name: 'db.prepare(sql, []).all(params)',
				read: async (sql, params) => {
					const stmt = db.prepare(sql, []);
					try {
						return await drain(stmt.all(params));
					} finally {
						await stmt.finalize();
					}
				},
			},
			{
				name: 'db.prepare(sql).bindAll(params).all()',
				read: async (sql, params) => {
					const stmt = db.prepare(sql);
					try {
						stmt.bindAll(params);
						return await drain(stmt.all());
					} finally {
						await stmt.finalize();
					}
				},
			},
		];

		const cases: ReadonlyArray<{ name: string; sql: string; params: SqlValue[] }> = [
			{ name: 'integer parameter against a TEXT column', sql: 'select k from t where v = ?', params: [5] },
			{ name: 'text parameter against an INTEGER column', sql: 'select k from u where n = ?', params: ['5'] },
		];

		beforeEach(async () => {
			await db.exec('create table t (k integer primary key, v text)');
			await db.exec("insert into t values (1, '5')");
			await db.exec('create table u (k integer primary key, n integer)');
			await db.exec('insert into u values (1, 5)');
		});

		for (const { name, sql, params } of cases) {
			it(`returns the matching row through every entry point — ${name}`, async () => {
				for (const reader of readers) {
					const rows = await reader.read(sql, params);
					expect(rows, `${reader.name}: ${sql} bound to ${JSON.stringify(params)}`)
						.to.deep.equal([{ k: 1 }]);
				}
			});
		}
	});

	describe('Named Parameters with Type Inference', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT,
					age INTEGER,
					score REAL
				)
			`);
		});

		it('should infer types for named parameters', async () => {
			await db.exec(
				'INSERT INTO users (id, name, age, score) VALUES (:id, :name, :age, :score)',
				{ id: 1, name: 'Alice', age: 30, score: 95.5 }
			);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM users WHERE id = :id', { id: 1 })) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].name).to.equal('Alice');
			expect(rows[0].age).to.equal(30);
			expect(rows[0].score).to.equal(95.5);
		});
	});

	describe('Type Conversion in Expressions', () => {
		it('should allow explicit type conversion with conversion functions', async () => {
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT date(?) as d', ['2024-01-15'])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].d).to.equal('2024-01-15');
		});
	});

	describe('Prepared Statement Type Validation', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE mixed_test (
					id INTEGER PRIMARY KEY,
					value_col INTEGER NULL
				)
			`);
		});

		it('should preserve parameter types and avoid recompilation', async () => {
			// Prepare with initial INTEGER parameters
			const stmt = db.prepare('INSERT INTO mixed_test (id, value_col) VALUES (?, ?)', [1, 42]);

			// First execution with the initial parameters
			await stmt.run();

			// Second execution with different INTEGER parameters (same type - no recompilation)
			await stmt.run([2, 100]);

			// Verify both rows were inserted
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM mixed_test ORDER BY id')) {
				rows.push(row);
			}
			expect(rows).to.have.length(2);
			expect(rows[0].value_col).to.equal(42);
			expect(rows[1].value_col).to.equal(100);

			await stmt.finalize();
		});

		it('should reject parameter type mismatches', async () => {
			// Prepare with INTEGER parameter
			const stmt = db.prepare('INSERT INTO mixed_test (id, value_col) VALUES (?, ?)', [1, 42]);

			// Try to execute with REAL parameter (different type - should throw)
			let error: Error | undefined;
			try {
				await stmt.run([2, 3.14]);
			} catch (e) {
				error = e as Error;
			}

			expect(error).to.exist;
			expect(error!.message).to.include('Parameter type mismatch');
			expect(error!.message).to.include('expected INTEGER');
			expect(error!.message).to.include('physical type REAL');

			await stmt.finalize();
		});

		it('should work with explicit type hints', async () => {
			const { INTEGER_TYPE } = await import('../src/types/builtin-types.js');

			// Prepare with explicit types
			const types = new Map([
				[1, { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false } as ScalarType],
				[2, { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true }]
			]);

			const stmt = db.prepare('INSERT INTO mixed_test (id, value_col) VALUES (?, ?)', types);

			// Execute with matching types
			await stmt.run([1, 42]);
			await stmt.run([2, 100]);

			// Verify rows were inserted
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM mixed_test ORDER BY id')) {
				rows.push(row);
			}
			expect(rows).to.have.length(2);

			await stmt.finalize();
		});

		it('should allow same-type parameters without recompilation', async () => {
			await db.exec('INSERT INTO mixed_test (id, value_col) VALUES (1, 42), (2, 100), (3, 200)');

			// Prepare with INTEGER parameter
			const stmt = db.prepare('SELECT * FROM mixed_test WHERE value_col > ?', [50]);

			// First query
			let rows: ResultRow[] = [];
			for await (const row of stmt.all()) {
				rows.push(row);
			}
			expect(rows).to.have.length(2);

			// Second query with different INTEGER value (no recompilation)
			rows = [];
			for await (const row of stmt.all([150])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);

			await stmt.finalize();
		});

		it('should validate physical type compatibility, not logical type', async () => {
			// Prepare with an integer number (infers INTEGER logical type)
			const stmt = db.prepare('SELECT ? as value', [42]);

			// Should accept bigint (same physical type: INTEGER). A safe-range bigint
			// canonicalizes to number at bind (R1, docs/types.md § Physical
			// representation), so the value comes back as the number 100.
			const result1 = await stmt.get([100n]);
			expect(result1).to.exist;
			expect(result1!.value).to.equal(100);
			expect(typeof result1!.value).to.equal('number');

			// Should accept integer number
			const result2 = await stmt.get([200]);
			expect(result2).to.exist;
			expect(result2!.value).to.equal(200);

			// Should reject float (different physical type: REAL vs INTEGER)
			let error: Error | undefined;
			try {
				await stmt.get([3.14]);
			} catch (e) {
				error = e as Error;
			}
			expect(error).to.exist;
			expect(error!.message).to.include('Parameter type mismatch');

			await stmt.finalize();
		});

		it('should allow any string for TEXT-based logical types', async () => {
			// Any string should be valid for TEXT physical type
			const stmt = db.prepare('SELECT ? as value', ['hello']);

			// Should accept any string
			const result1 = await stmt.get(['world']);
			expect(result1).to.exist;
			expect(result1!.value).to.equal('world');

			const result2 = await stmt.get(['2024-01-15']); // Date-like string is still TEXT
			expect(result2).to.exist;
			expect(result2!.value).to.equal('2024-01-15');

			await stmt.finalize();
		});
	});
});

