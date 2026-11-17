/**
 * A scalar builtin that declares `textArgs` reads each of those arguments through the
 * one value-to-text conversion (`util/value-text.ts`): at every declared position,
 * `f(…x…)` is `f(…cast(x as text)…)`. Generated from the registry, so a builtin that
 * gains a `textArgs` declaration is covered without editing this file.
 *
 * The sample reaches one call through a bound parameter, so it cannot be constant-folded
 * and the runtime path runs; the other call spells the cast out. NULL results must match
 * too (`substr(x)` with no start is NULL either way).
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { BUILTIN_FUNCTIONS } from '../src/func/builtins/index.js';
import { isScalarFunctionSchema, type ScalarFunctionSchema } from '../src/schema/function.js';
import { comparisonGroupIndices } from '../src/types/comparison-coercion.js';
import type { SqlValue } from '../src/common/types.js';

interface Sample {
	/** The value as a SQL expression. */
	readonly sql: string;
	/** The same value as a bound parameter. */
	readonly bound: SqlValue;
}

const SAMPLES: readonly Sample[] = [
	{ sql: `x'6162'`, bound: new Uint8Array([0x61, 0x62]) },
	{ sql: '12', bound: 12 },
	{ sql: '2.5', bound: 2.5 },
	{ sql: `cast('9007199254740993' as integer)`, bound: 9007199254740993n },
	{ sql: 'true', bound: true },
	{ sql: `json('{"a":1}')`, bound: { a: 1 } },
	{ sql: `json('[1,2]')`, bound: [1, 2] },
	{ sql: `'ab'`, bound: 'ab' },
];

/** What fills the positions the sample is not at: text where the function reads text, else a number. */
const filler = (textPositions: readonly number[], i: number): string => textPositions.includes(i) ? `'ab'` : '2';

describe('String builtins read text arguments as cast(x as text)', () => {
	let db: Database;

	before(() => {
		db = new Database();
	});

	after(async () => {
		await db.close();
	});

	const textArgFunctions = BUILTIN_FUNCTIONS
		.filter(isScalarFunctionSchema)
		.filter((schema): schema is ScalarFunctionSchema & { textArgs: NonNullable<ScalarFunctionSchema['textArgs']> } =>
			schema.textArgs !== undefined);

	function preparesWithFillers(name: string, textPositions: readonly number[], arity: number): boolean {
		const args = Array.from({ length: arity }, (_, i) => filler(textPositions, i));
		let stmt;
		try {
			stmt = db.prepare(`select ${name}(${args.join(', ')})`);
			stmt.getColumnDefs(); // planning happens here, so a rejected arity throws
			return true;
		} catch {
			return false;
		} finally {
			void stmt?.finalize();
		}
	}

	it('covers at least one function', () => {
		expect(textArgFunctions).to.not.be.empty;
	});

	it('f(…x…) is f(…cast(x as text)…) at every declared text position', async () => {
		const violations: string[] = [];
		for (const schema of textArgFunctions) {
			const variadic = schema.numArgs < 0;
			for (const arity of variadic ? [1, 2, 3] : [schema.numArgs]) {
				const textPositions = comparisonGroupIndices(schema.textArgs, arity);
				// A variadic function need not accept every arity; a fixed one must.
				if (variadic && !preparesWithFillers(schema.name, textPositions, arity)) continue;
				for (const pos of textPositions) {
					const call = (atPos: string) => `${schema.name}(${Array.from({ length: arity },
						(_, i) => i === pos ? atPos : filler(textPositions, i)).join(', ')})`;
					for (const sample of SAMPLES) {
						const sql = `select ${call('?')} as a, ${call(`cast(${sample.sql} as text)`)} as b`;
						const row = await db.get(sql, [sample.bound]);
						// Results are text, integer, boolean or NULL, so strict equality is value equality.
						if (!row || row.a !== row.b) violations.push(`${sql} [? = ${sample.sql}]: ${String(row?.a)} vs ${String(row?.b)}`);
					}
				}
			}
		}
		expect(violations).to.deep.equal([]);
	});
});
