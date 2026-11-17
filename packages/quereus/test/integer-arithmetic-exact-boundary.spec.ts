/**
 * `+ - *` over two safe-integer operands returns the EXACT answer in canonical form (R1,
 * util/numeric-canonical.ts): a `number` inside the safe-integer range, a `bigint` past
 * it. Floating point is exact only while the answer stays inside that range — past it
 * `9007199254740991 * 3` rounds to …972 — so the evaluator (`buildNumericOpSpec`,
 * runtime/emit/binary.ts) redoes that one operation in bigint.
 *
 * Swept over operands straddling the boundary, through both runtime bodies: two INTEGER
 * operands (the numeric-only body) and a TEXT-spelled operand (the coercing body). Each
 * value is compared with strict equality against the canonicalized exact answer, which
 * checks digits and storage class together, and against the column's announced type.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';
import { canonicalizeInteger } from '../src/util/numeric-canonical.js';
import { conformsToType } from '../src/types/representation.js';

const MAGNITUDES = [0, 1, 2, 3, 2 ** 26, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
const OPERANDS = [...MAGNITUDES, ...MAGNITUDES.slice(1).map(m => -m)];
const OPERATORS: ReadonlyArray<readonly [string, (a: bigint, b: bigint) => bigint]> = [
	['+', (a, b) => a + b],
	['-', (a, b) => a - b],
	['*', (a, b) => a * b],
];

describe('Integer arithmetic across the safe-integer boundary', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table pairs (id integer primary key, a integer not null, b integer not null, a_text text not null)');
		const rows = OPERANDS.flatMap(a => OPERANDS.map(b => [a, b]));
		const values = rows.map(([a, b], id) => `(${id}, ${a}, ${b}, '${a}')`).join(', ');
		await db.exec(`insert into pairs values ${values}`);
	});

	afterEach(async () => {
		await db.close();
	});

	/** Evaluate `<left> <op> b` for every operator over every pair and check each value. */
	async function sweep(left: string): Promise<void> {
		const stmt = db.prepare(`select a, b, ${OPERATORS.map(([op]) => `${left} ${op} b`).join(', ')} from pairs`);
		try {
			const announced = stmt.getColumnDefs().map(col => col.type.logicalType);
			let checked = 0;
			for await (const row of stmt.iterateRows()) {
				const [a, b] = row as [number, number];
				OPERATORS.forEach(([op, exact], i) => {
					const value = row[i + 2];
					const label = `${left}=${a} ${op} ${b} (got ${String(value)}, ${typeof value})`;
					expect(value, label).to.equal(canonicalizeInteger(exact(BigInt(a), BigInt(b))));
					expect(conformsToType(value as Exclude<SqlValue, null>, announced[i + 2]), `${label} vs announced ${announced[i + 2].name}`).to.equal(true);
				});
				checked++;
			}
			expect(checked).to.equal(OPERANDS.length ** 2);
		} finally {
			await stmt.finalize();
		}
	}

	async function firstValue(sql: string): Promise<SqlValue> {
		for await (const row of db.eval(sql)) return Object.values(row)[0];
		throw new Error(`no row for: ${sql}`);
	}

	it('is exact for two INTEGER operands, literal or column', async () => {
		expect(await firstValue('select 9007199254740991 * 3')).to.equal(27021597764222973n);
		await sweep('a');
	});

	it('is exact for a TEXT-spelled operand (coercing arithmetic)', async () => {
		expect(await firstValue(`select '9007199254740991' * 3`)).to.equal(27021597764222973n);
		await sweep('a_text');
	});

	it('leaves REAL × REAL a floating-point number past the safe range', async () => {
		const sql = 'select cast(9007199254740991 as real) * cast(3 as real) as v';
		const stmt = db.prepare(sql);
		try {
			expect(stmt.getColumnDefs()[0].type.logicalType.name).to.equal('REAL');
		} finally {
			await stmt.finalize();
		}
		expect(await firstValue(sql)).to.equal(9007199254740991 * 3);
	});
});
