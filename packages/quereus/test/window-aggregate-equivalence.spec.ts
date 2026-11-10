import { expect } from 'chai';
import * as fc from 'fast-check';
import { Database } from '../src/core/database.js';
import type { SqlValue } from '../src/common/types.js';
import { isAggregateFunctionSchema } from '../src/schema/function.js';
import { getAllWindowFunctions } from '../src/schema/window-function.js';
import { sqlValueIdentical } from '../src/util/comparison.js';

/**
 * Every aggregate usable as a window function must compute exactly what the grouped
 * aggregate computes over the same rows — the same value AND the same storage class
 * (`bigint` vs `number`). Window SUM once kept its own float copy of the summing
 * logic and lost whole numbers past 2^53 that grouped `sum` keeps exact.
 *
 * Driven by the window registry rather than a hand-written list, so an aggregate
 * registered as a window later is covered without anyone adding it here. Each
 * execution shape is checked: the buffered frame walk (`over ()`), the streaming
 * running aggregate, and the streaming ROWS and RANGE sliding frames.
 *
 * The value domain mixes the exact-integer part of sum's accumulator (bigints past
 * 2^53, safe integers near the boundary, booleans) with its floating-point part
 * (fractions). No text: sum and avg refuse it, numeric text included. Fractions are dyadic and bounded, so float addition over them is
 * exact: a slide-and-retract and a fresh fold then agree bit for bit, and a
 * divergence means a real difference in the computation, not IEEE rounding order.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const signed = (arb: fc.Arbitrary<bigint>): fc.Arbitrary<bigint> =>
	fc.tuple(arb, fc.boolean()).map(([v, negative]) => (negative ? -v : v));

/** Whole numbers past the safe-integer range — always `bigint`. */
const bigWhole = signed(fc.bigInt({ min: MAX_SAFE + 1n, max: 2n ** 70n }));
/** Safe integers within 1000 of the boundary, so a few of them sum past it. */
const nearBoundary = signed(fc.bigInt({ min: MAX_SAFE - 1000n, max: MAX_SAFE })).map(Number);
/** Dyadic fractions (multiples of 0.25, |v| ≤ 1000). */
const dyadic = fc.integer({ min: -4_000, max: 4_000 }).map(v => v / 4);

const valueArb: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant<SqlValue>(null),
	bigWhole.map((v): SqlValue => v),
	nearBoundary.map((v): SqlValue => v),
	dyadic.map((v): SqlValue => v),
	fc.boolean().map((v): SqlValue => v),
);

interface Shape {
	readonly name: string;
	readonly over: string;
	/** The frame of row `id`, as a predicate on the subquery row `b`; null ⇒ whole table. */
	readonly frame: string | null;
	/** The streaming mode the WindowNode must plan, or null for the buffered walk. */
	readonly streamingMode: string | null;
}

const SHAPES: readonly Shape[] = [
	{ name: 'whole partition (buffered)', over: '()', frame: null, streamingMode: null },
	{ name: 'running', over: '(order by id)', frame: 'b.id <= a.id', streamingMode: 'runningAgg' },
	{
		name: 'ROWS sliding', over: '(order by id rows between 2 preceding and 1 following)',
		frame: 'b.id between a.id - 2 and a.id + 1', streamingMode: 'slidingAgg',
	},
	{
		name: 'RANGE sliding', over: '(order by id range between 2 preceding and 1 following)',
		frame: 'b.id between a.id - 2 and a.id + 1', streamingMode: 'slidingAgg',
	},
];

const show = (v: SqlValue): string => (typeof v === 'bigint' ? `${v}n` : JSON.stringify(v));
const sameValueAndClass = (a: SqlValue, b: SqlValue): boolean => typeof a === typeof b && sqlValueIdentical(a, b);

describe('Window aggregates agree with their grouped aggregates', () => {
	let db: Database;

	before(async () => {
		db = new Database();
		await db.exec('create table w (id integer primary key, v any null)');
	});

	after(async () => {
		await db.close();
	});

	/** Registry entries of kind 'aggregate' whose name also resolves as a one-argument aggregate. */
	function windowAggregates(): string[] {
		return getAllWindowFunctions()
			.filter(s => s.kind === 'aggregate')
			.map(s => s.name.toLowerCase())
			.filter(name => {
				const grouped = db._findFunction(name, 1);
				return grouped !== undefined && isAggregateFunctionSchema(grouped);
			});
	}

	async function windowStreamingModes(sql: string): Promise<string[] | null> {
		for await (const row of db.eval('select op, properties from query_plan(?)', [sql])) {
			const r = row as { op: string; properties: string | null };
			if (r.op !== 'WINDOW') continue;
			const props = r.properties ? JSON.parse(r.properties) as { streaming?: { modes: string[] } } : {};
			return props.streaming?.modes ?? null;
		}
		throw new Error(`no WINDOW node in the plan of: ${sql}`);
	}

	const windowSql = (f: string, shape: Shape): string => `select id, ${f}(v) over ${shape.over} as r from w`;
	const groupedSql = (f: string, shape: Shape): string => shape.frame === null
		? `select a.id, (select ${f}(v) from w) as r from w a`
		: `select a.id, (select ${f}(b.v) from w b where ${shape.frame}) as r from w a`;

	async function resultsById(sql: string): Promise<Map<number, SqlValue>> {
		const out = new Map<number, SqlValue>();
		for await (const row of db.eval(sql)) {
			out.set(Number(row.id), row.r as SqlValue);
		}
		return out;
	}

	it('covers the registry aggregates on the intended execution shapes', async () => {
		const names = windowAggregates();
		expect(names, 'registry aggregates under test').to.include.members(['count', 'sum', 'avg', 'min', 'max']);
		// Without this the comparison below could silently run every shape on the
		// buffered walk and never exercise the streaming emitter.
		for (const f of names) {
			for (const shape of SHAPES) {
				const modes = await windowStreamingModes(windowSql(f, shape));
				expect(modes, `${f} ${shape.name}`).to.deep.equal(shape.streamingMode === null ? null : [shape.streamingMode]);
			}
		}
	});

	it('every shape matches the grouped aggregate over the same frame, storage class included', async () => {
		const names = windowAggregates();
		await fc.assert(fc.asyncProperty(fc.array(valueArb, { minLength: 1, maxLength: 12 }), async (values) => {
			await db.exec('delete from w');
			await db.exec(
				`insert into w values ${values.map((_v, i) => `(${i + 1}, ?)`).join(', ')}`,
				values,
			);
			for (const f of names) {
				for (const shape of SHAPES) {
					const got = await resultsById(windowSql(f, shape));
					const want = await resultsById(groupedSql(f, shape));
					expect(got.size, `${f} ${shape.name}: row count`).to.equal(values.length);
					for (const [id, expected] of want) {
						const actual = got.get(id) ?? null;
						if (!sameValueAndClass(actual, expected)) {
							throw new Error(`${f}(v) ${shape.name} at id ${id}: window ${show(actual)}, grouped ${show(expected)}; `
								+ `values ${values.map(show).join(', ')}`);
						}
					}
				}
			}
		}), { numRuns: 50 });
	});
});
