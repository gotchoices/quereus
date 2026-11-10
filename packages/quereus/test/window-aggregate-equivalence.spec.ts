import { expect } from 'chai';
import * as fc from 'fast-check';
import { Database } from '../src/core/database.js';
import type { SqlValue } from '../src/common/types.js';
import { isAggregateFunctionSchema } from '../src/schema/function.js';
import { getAllWindowFunctions } from '../src/schema/window-function.js';
import { sqlValueIdentical } from '../src/util/comparison.js';

/**
 * Every aggregate usable as a window function must compute what the grouped aggregate
 * computes over the same rows — the same value AND the same storage class (`bigint` vs
 * `number`). Window SUM once kept its own float copy of the summing logic and lost
 * whole numbers past 2^53 that grouped `sum` keeps exact.
 *
 * Driven by the window registry rather than a hand-written list, so an aggregate
 * registered as a window later is covered without anyone adding it here. Each
 * execution shape is checked: the buffered frame walk (`over ()`), the streaming
 * running aggregate, and the streaming ROWS and RANGE sliding frames.
 *
 * The value domain mixes the exact-integer part of sum's accumulator (bigints past
 * 2^53, safe integers near the boundary, booleans) with its floating-point part:
 * arbitrary fractions, very large and very small REALs. No text: sum and avg refuse
 * it, numeric text included. Integers are exact on every path, so a frame holding no
 * REAL value must match bit for bit and in storage class — including after a sliding
 * frame retracted REAL values. REAL addition is approximate and its order unspecified,
 * so a sum/avg frame holding a REAL must match in storage class and to within a
 * rounding bound (see `realTolerance`).
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const signed = <T extends number | bigint>(arb: fc.Arbitrary<T>): fc.Arbitrary<T> =>
	fc.tuple(arb, fc.boolean()).map(([v, negative]) => (negative ? -v : v) as T);

/** Whole numbers past the safe-integer range — always `bigint`. */
const bigWhole = signed(fc.bigInt({ min: MAX_SAFE + 1n, max: 2n ** 70n }));
/** Safe integers within 1000 of the boundary, so a few of them sum past it. */
const nearBoundary = signed(fc.bigInt({ min: MAX_SAFE - 1000n, max: MAX_SAFE })).map(Number);
/** Dyadic fractions (multiples of 0.25, |v| ≤ 1000). */
const dyadic = fc.integer({ min: -4_000, max: 4_000 }).map(v => v / 4);
/** Arbitrary doubles of moderate magnitude — float addition over them rounds. */
const moderateReal = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
/** Large REALs (most are whole numbers past 2^53, still REAL), which swallow small addends. */
const largeReal = signed(fc.double({ min: 1e15, max: 1e20, noNaN: true, noDefaultInfinity: true }));
/** Small REALs, the addends a large value swallows. */
const smallReal = signed(fc.double({ min: 1e-11, max: 1e-9, noNaN: true, noDefaultInfinity: true }));

const valueArb: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant<SqlValue>(null),
	bigWhole.map((v): SqlValue => v),
	nearBoundary.map((v): SqlValue => v),
	dyadic.map((v): SqlValue => v),
	moderateReal.map((v): SqlValue => v),
	largeReal.map((v): SqlValue => v),
	smallReal.map((v): SqlValue => v),
	fc.boolean().map((v): SqlValue => v),
);

/** Does sum route this value to its floating-point part? Mirrors sum's routing rule. */
const isReal = (v: SqlValue): boolean => typeof v === 'number' && !Number.isSafeInteger(v);
const magnitude = (v: SqlValue): number =>
	typeof v === 'number' || typeof v === 'bigint' ? Math.abs(Number(v)) : v === true ? 1 : 0;
const sumOfMagnitudes = (vs: readonly SqlValue[]): number => vs.reduce<number>((total, v) => total + magnitude(v), 0);
/** Aggregates whose REAL arithmetic is approximate, so compared to a rounding bound. */
const APPROXIMATE_OVER_REAL: ReadonlySet<string> = new Set(['sum', 'avg']);
/**
 * How far a sum/avg over a frame holding a REAL may stray from the grouped result.
 * Compensated summation errs first-order in the frame's own magnitude (about 10^4 ulps
 * allowed here); a sliding frame's retractions add only a second-order term in the
 * magnitude of everything that passed through it — the partition. Uncompensated
 * retraction errs first-order in the partition's magnitude, which this bound rejects:
 * it is what lost the 0.5 beside a departing 1e20.
 */
const realTolerance = (frameMagnitude: number, partitionMagnitude: number): number =>
	1e-12 * frameMagnitude + 1e-24 * partitionMagnitude;

interface Shape {
	readonly name: string;
	readonly over: string;
	/** The frame of row `id`, as a predicate on the subquery row `b`; null ⇒ whole table. */
	readonly frame: string | null;
	/** The same frame in JS: is row `b` in the frame of row `a`? */
	readonly inFrame: (a: number, b: number) => boolean;
	/** The streaming mode the WindowNode must plan, or null for the buffered walk. */
	readonly streamingMode: string | null;
}

const SHAPES: readonly Shape[] = [
	{ name: 'whole partition (buffered)', over: '()', frame: null, inFrame: () => true, streamingMode: null },
	{ name: 'running', over: '(order by id)', frame: 'b.id <= a.id', inFrame: (a, b) => b <= a, streamingMode: 'runningAgg' },
	{
		name: 'ROWS sliding', over: '(order by id rows between 2 preceding and 1 following)',
		frame: 'b.id between a.id - 2 and a.id + 1', inFrame: (a, b) => b >= a - 2 && b <= a + 1,
		streamingMode: 'slidingAgg',
	},
	{
		name: 'RANGE sliding', over: '(order by id range between 2 preceding and 1 following)',
		frame: 'b.id between a.id - 2 and a.id + 1', inFrame: (a, b) => b >= a - 2 && b <= a + 1,
		streamingMode: 'slidingAgg',
	},
];

const show = (v: SqlValue): string => (typeof v === 'bigint' ? `${v}n` : JSON.stringify(v));
const sameValueAndClass = (a: SqlValue, b: SqlValue): boolean => typeof a === typeof b && sqlValueIdentical(a, b);
const withinRounding = (a: SqlValue, b: SqlValue, tolerance: number): boolean =>
	typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance;

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
			const partitionMagnitude = sumOfMagnitudes(values);
			for (const f of names) {
				for (const shape of SHAPES) {
					const got = await resultsById(windowSql(f, shape));
					const want = await resultsById(groupedSql(f, shape));
					expect(got.size, `${f} ${shape.name}: row count`).to.equal(values.length);
					for (const [id, expected] of want) {
						const actual = got.get(id) ?? null;
						const frame = values.filter((_v, i) => shape.inFrame(id, i + 1));
						const approximate = APPROXIMATE_OVER_REAL.has(f) && frame.some(isReal);
						const agrees = sameValueAndClass(actual, expected) || (approximate
							&& withinRounding(actual, expected, realTolerance(sumOfMagnitudes(frame), partitionMagnitude)));
						if (!agrees) {
							throw new Error(`${f}(v) ${shape.name} at id ${id}: window ${show(actual)}, grouped ${show(expected)}; `
								+ `values ${values.map(show).join(', ')}`);
						}
					}
				}
			}
		}), { numRuns: 50 });
	});

	it('a ROWS frame sliding past a large or REAL value recovers the grouped total and storage class', async () => {
		// A large REAL leaving the frame must not take the small value beside it along
		// (third row), and once the last REAL value has left, the frame is exact again:
		// no float residue (fourth row of the first case), and a total past 2^53 is a
		// `bigint` again (second case). The float part is also reset then, so the NaN
		// that retracting an Infinity leaves does not reach a later REAL frame (third case).
		const slide = async (values: SqlValue[]): Promise<SqlValue[]> => {
			await db.exec('delete from w');
			await db.exec(`insert into w values ${values.map((_v, i) => `(${i + 1}, ?)`).join(', ')}`, values);
			const sql = 'select id, sum(v) over (order by id rows between 1 preceding and current row) as r from w';
			return [...(await resultsById(sql)).values()];
		};
		expect(await slide([1e20, 0.5, 5, 7])).to.deep.equal([1e20, 1e20, 5.5, 12]);
		expect((await slide([0.1, 0.2, 9007199254740993n, 5]))[3]).to.equal(9007199254740998n);
		expect((await slide([Number.POSITIVE_INFINITY, 5, 7, 0.5]))[3]).to.equal(7.5);
	});
});
