/**
 * `BinaryOpNode.getType()` — the logical type a binary expression advertises (ticket
 * `binary-op-result-types-match-runtime`).
 *
 * The property under test is not "operator X announces type Y" for its own sake, but that
 * the announcement and the value agree: every case below asserts the announced type AND
 * that the value the runtime actually produces inhabits it (`conformsToType`, the same R2
 * predicate the statement-egress checker and the DML write path use). That pairing is what
 * catches the drift this ticket fixed — `select 'a' == 'a'` announced TEXT and returned a
 * boolean.
 *
 * The classification itself (`analysis/binary-operator-class.ts`) is unit-tested at the
 * bottom, since it is now the single list both `generateType` and `buildBinaryOpSpec`
 * dispatch on.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { Parser } from '../src/parser/parser.js';
import type * as AST from '../src/parser/ast.js';
import type { SqlValue } from '../src/common/types.js';
import { PlanNode } from '../src/planner/nodes/plan-node.js';
import { BinaryOpNode } from '../src/planner/nodes/scalar.js';
import { conformsToType } from '../src/types/representation.js';
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../src/types/builtin-types.js';
import { getType } from '../src/types/registry.js';
import { classifyBinaryOperator } from '../src/planner/analysis/binary-operator-class.js';
import { isComparisonOperator } from '../src/planner/analysis/comparison-collation.js';

describe('BinaryOpNode static type', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	/** The outermost BinaryOpNode in a logically-planned statement. */
	function findBinary(sql: string): BinaryOpNode {
		const ast = new Parser().parse(sql) as unknown as AST.Statement;
		const { plan } = db._buildPlan([ast]);
		let found: BinaryOpNode | undefined;
		const visit = (n: PlanNode): void => {
			if (found) return;
			if (n instanceof BinaryOpNode) { found = n; return; }
			for (const c of n.getChildren()) visit(c);
			for (const r of n.getRelations()) visit(r);
		};
		visit(plan);
		if (!found) throw new Error(`no BinaryOpNode in plan for: ${sql}`);
		return found;
	}

	async function firstValue(sql: string): Promise<SqlValue> {
		for await (const r of db.eval(sql)) return (r as { v: SqlValue }).v;
		throw new Error(`no row for: ${sql}`);
	}

	/**
	 * Assert `select <expr> as v` announces `typeName` and that its value inhabits the
	 * announced type. Both halves matter — either alone passes while they disagree.
	 */
	async function expectAnnouncedAndInhabited(expr: string, typeName: string): Promise<SqlValue> {
		const sql = `select ${expr} as v`;
		const announced = findBinary(sql).getType().logicalType;
		expect(announced.name, `announced type of ${expr}`).to.equal(typeName);

		const value = await firstValue(sql);
		expect(value, `${expr} produced NULL, which tests nothing here`).to.not.equal(null);
		expect(
			conformsToType(value as Exclude<SqlValue, null>, announced),
			`value ${String(value)} (${typeof value}) of ${expr} does not inhabit announced ${typeName}`,
		).to.equal(true);
		return value;
	}

	describe('comparison, logical and pattern-matching operators announce BOOLEAN', () => {
		// `==` and `XOR` and `LIKE` reach the planner with those exact spellings — the
		// parser normalizes `<>` to `!=` and desugars BETWEEN, which is why those two were
		// already correct while these three were not.
		it('announces BOOLEAN for == (was TEXT — the left operand type)', async () => {
			expect(await expectAnnouncedAndInhabited(`'a' == 'a'`, 'BOOLEAN')).to.equal(true);
		});

		it('announces BOOLEAN for XOR (was REAL — the left operand type)', async () => {
			expect(await expectAnnouncedAndInhabited(`1 xor 0`, 'BOOLEAN')).to.equal(true);
		});

		it('announces BOOLEAN for LIKE (was TEXT — the left operand type)', async () => {
			expect(await expectAnnouncedAndInhabited(`'ab' like 'a%'`, 'BOOLEAN')).to.equal(true);
		});

		it('keeps BOOLEAN for the spellings that were already right', async () => {
			expect(await expectAnnouncedAndInhabited(`'a' <> 'b'`, 'BOOLEAN')).to.equal(true);
			expect(await expectAnnouncedAndInhabited(`1 < 2`, 'BOOLEAN')).to.equal(true);
			expect(await expectAnnouncedAndInhabited(`1 and 1`, 'BOOLEAN')).to.equal(true);
			expect(await expectAnnouncedAndInhabited(`0 or 1`, 'BOOLEAN')).to.equal(true);
		});

		it('announces BOOLEAN under a NOT wrapper', async () => {
			// `NOT LIKE` is parsed as unary NOT over a LIKE BinaryOpNode, so the inner
			// node's announcement is what `findBinary` sees; the statement column type is
			// the NOT's. Both must be BOOLEAN.
			expect(await expectAnnouncedAndInhabited(`'ab' not like 'a%'`, 'BOOLEAN')).to.equal(false);
		});

		it('classifies a lowercase keyword operator, as internally built ASTs spell it', () => {
			// util/mutation-statement.ts synthesizes `operator: 'and'`; a case-sensitive
			// switch announced such a node as its left operand's type.
			expect(classifyBinaryOperator('and')).to.equal('logical');
			expect(classifyBinaryOperator('like')).to.equal('like');
			expect(classifyBinaryOperator('xor')).to.equal('logical');
		});
	});

	describe('arithmetic with a non-numeric operand announces ANY', () => {
		// The runtime sniffs each pair of values: a duration-shaped string yields a
		// TIMESPAN string, an ordinary string coerces to a number. No single concrete type
		// describes both, so the announcement is ANY.
		it('announces ANY for a numeric-looking TEXT operand (was TEXT; produces a number)', async () => {
			expect(await expectAnnouncedAndInhabited(`'123' + 0`, 'ANY')).to.equal(123);
		});

		it('announces ANY for a non-numeric TEXT operand (was TEXT; produces a number)', async () => {
			expect(await expectAnnouncedAndInhabited(`'abc' + 0`, 'ANY')).to.equal(0);
		});

		it('leaves nested arithmetic over such an expression unchanged', async () => {
			// The outer `+` sees an ANY left operand rather than TEXT. Neither is temporal
			// and neither is numeric, so both spellings selected the same generic coercing
			// body in `buildNumericOpSpec` before and after. Same answer.
			expect(await expectAnnouncedAndInhabited(`('123' + 0) + 1`, 'ANY')).to.equal(124);
		});

		it('keeps the numeric-promotion arm', async () => {
			expect(findBinary('select 1 + 2 as v').getType().logicalType.name).to.equal('INTEGER');
			expect(findBinary('select 1.5 + 2.5 as v').getType().logicalType.name).to.equal('REAL');
			// Mixed INTEGER/REAL announces NUMERIC, not REAL: the runtime keeps a
			// bigint INTEGER operand in the bigint domain when the REAL side is
			// integral, so the result inhabits number | bigint.
			expect(findBinary('select 1 + 2.5 as v').getType().logicalType.name).to.equal('NUMERIC');
		});

		it('keeps the temporal-operation-table arm', async () => {
			await db.exec('create table dts (id integer primary key, a date not null, b date not null)');
			// `date - date` is a TIMESPAN per types/temporal-ops.ts, not ANY.
			expect(findBinary('select a - b as v from dts').getType().logicalType.name).to.equal('TIMESPAN');
		});
	});

	describe('arithmetic over plugin-registered numeric types promotes by physical type', () => {
		// The promotion chain once matched the names REAL and NUMERIC, so any other
		// numeric type fell through to "both INTEGER": `len * len` over 1.5 announced
		// INTEGER and produced 2.25. The spreads give fresh objects, so nothing matches
		// these by identity against the builtin singletons.
		beforeEach(() => {
			db.registerType('BOPLEN', { ...REAL_TYPE, name: 'BOPLEN' });
			db.registerType('BOPCOUNT', { ...INTEGER_TYPE, name: 'BOPCOUNT' });
		});

		const len = 'cast(1.5 as boplen)';
		const count = (n: number): string => `cast(${n} as bopcount)`;

		it('a REAL-stored type promotes like REAL', async () => {
			expect(await expectAnnouncedAndInhabited(`${len} + ${len}`, 'REAL')).to.equal(3);
			expect(await expectAnnouncedAndInhabited(`${len} * ${len}`, 'REAL')).to.equal(2.25);
			expect(await expectAnnouncedAndInhabited(`${len} + 2.5`, 'REAL')).to.equal(4);
			// REAL-class against INTEGER-class is the mixed pair, which announces NUMERIC.
			expect(await expectAnnouncedAndInhabited(`${len} * 2`, 'NUMERIC')).to.equal(3);
		});

		it('an INTEGER-stored type promotes like INTEGER, nullability included', async () => {
			expect(await expectAnnouncedAndInhabited(`${count(3)} + ${count(4)}`, 'INTEGER')).to.equal(7);
			// The `+ - *` over two INTEGERs nullability exception the lens prover relies on.
			// Columns, not casts: a converting cast is itself nullable.
			await db.exec('create table bc (id integer primary key, a bopcount not null, b bopcount not null)');
			expect(findBinary('select a + b as v from bc').getType().nullable).to.equal(false);
			expect(await expectAnnouncedAndInhabited(`${count(3)} / ${count(4)}`, 'NUMERIC')).to.equal(0.75);
		});
	});

	describe('arithmetic over quantity types keeps the measure', () => {
		// BOPQLEN and BOPQMASS are REAL-stored quantities, BOPQCENTS an INTEGER-stored one.
		beforeEach(() => {
			db.registerType('BOPQLEN', { ...REAL_TYPE, name: 'BOPQLEN', isQuantity: true });
			db.registerType('BOPQMASS', { ...REAL_TYPE, name: 'BOPQMASS', isQuantity: true });
			db.registerType('BOPQCENTS', { ...INTEGER_TYPE, name: 'BOPQCENTS', isQuantity: true });
		});

		const len = (n: number): string => `cast(${n} as bopqlen)`;
		const mass = (n: number): string => `cast(${n} as bopqmass)`;
		const cents = (n: number): string => `cast(${n} as bopqcents)`;

		const cases: ReadonlyArray<readonly [expr: string, typeName: string, value: number]> = [
			// Step 1, measure kept: same quantity on both sides of + - %, scaled by a plain number.
			[`${len(1.5)} + ${len(1.5)}`, 'BOPQLEN', 3],
			[`${len(1.5)} - ${len(1)}`, 'BOPQLEN', 0.5],
			[`${len(3.5)} % ${len(1.5)}`, 'BOPQLEN', 0.5],
			[`${len(1.5)} * 2`, 'BOPQLEN', 3],
			[`2 * ${len(1.5)}`, 'BOPQLEN', 3],
			[`${len(1.5)} / 2`, 'BOPQLEN', 0.75],
			[`${len(3.5)} % 2`, 'BOPQLEN', 1.5],
			// Step 1, no known measure: the builtin promotion stands.
			[`${len(1.5)} * ${len(1.5)}`, 'REAL', 2.25],
			[`${len(3)} / ${len(1.5)}`, 'REAL', 2],
			[`3 / ${len(1.5)}`, 'NUMERIC', 2],
			[`3 % ${len(2)}`, 'NUMERIC', 1],
			[`${len(1.5)} + 2`, 'NUMERIC', 3.5],
			[`2 - ${len(1.5)}`, 'NUMERIC', 0.5],
			[`${len(1.5)} + ${mass(2)}`, 'REAL', 3.5],
			[`${len(1.5)} - ${mass(2)}`, 'REAL', -0.5],
			[`${len(1.5)} * ${mass(2)}`, 'REAL', 3],
			[`${len(3)} / ${mass(2)}`, 'REAL', 1.5],
			[`${len(3)} % ${mass(2)}`, 'REAL', 1],
			// Step 2, INTEGER-stored: kept only where the builtin promotion is INTEGER.
			[`${cents(3)} + ${cents(4)}`, 'BOPQCENTS', 7],
			[`${cents(3)} - ${cents(4)}`, 'BOPQCENTS', -1],
			[`${cents(7)} % ${cents(4)}`, 'BOPQCENTS', 3],
			[`${cents(3)} * 2`, 'BOPQCENTS', 6],
			[`2 * ${cents(3)}`, 'BOPQCENTS', 6],
			[`${cents(7)} % 4`, 'BOPQCENTS', 3],
			[`${cents(3)} * 1.5`, 'NUMERIC', 4.5],
			[`${cents(3)} / 2`, 'NUMERIC', 1.5],
			[`${cents(3)} * ${cents(4)}`, 'INTEGER', 12],
		];

		it('announces the quantity exactly where the rule keeps it, and the value inhabits it', async () => {
			for (const [expr, typeName, value] of cases) {
				expect(await expectAnnouncedAndInhabited(expr, typeName), expr).to.equal(value);
				if (typeName.startsWith('BOPQ')) {
					// The operand's own object: the write path compares types by identity.
					expect(findBinary(`select ${expr} as v`).getType().logicalType, expr).to.equal(getType(typeName));
				}
			}
		});

		it('computes a REAL-stored quantity in floating point, never as a bigint', async () => {
			// 9007199254740993 is a bigint literal; the bigint-preserving body would return a bigint.
			const product = await expectAnnouncedAndInhabited(`${len(3)} * 9007199254740993`, 'BOPQLEN');
			expect(typeof product).to.equal('number');
			const divided = findBinary(`select ${len(1.5)} / 0 as v`);
			expect(divided.getType().logicalType.name).to.equal('BOPQLEN');
			expect(divided.getType().nullable).to.equal(true);
			expect(await firstValue(`select ${len(1.5)} / 0 as v`)).to.equal(null);
		});

		it('keeps + over two NOT NULL INTEGER-stored quantity columns non-nullable', async () => {
			await db.exec('create table qc (id integer primary key, a bopqcents not null, b bopqcents not null)');
			expect(findBinary('select a + b as v from qc').getType().nullable).to.equal(false);
		});

		it('refuses a quantity type stored as TEXT', () => {
			expect(() => db.registerType('BOPQTEXT', { ...TEXT_TYPE, name: 'BOPQTEXT', isNumeric: true, isQuantity: true }))
				.to.throw(/isQuantity/);
			expect(getType('BOPQTEXT')).to.equal(undefined);
		});
	});

	describe('an ANY-announced source on the DML write path', () => {
		// ANY is never identical to a declared column type, so the write path's
		// static-type skip cannot fire and the coercion to the declared type must run.
		it('coerces to the declared column type instead of storing the raw value', async () => {
			await db.exec('create table w (id integer primary key, c text not null)');
			await db.exec(`insert into w values (1, '123' + 0)`);
			const stored = await firstValue('select c as v from w');
			expect(typeof stored, 'declared TEXT column must hold a string').to.equal('string');
			expect(stored).to.equal('123');
		});
	});

	describe('concatenation', () => {
		it('still announces TEXT', async () => {
			expect(await expectAnnouncedAndInhabited(`'a' || 'b'`, 'TEXT')).to.equal('ab');
		});
	});

	describe('operator classification is shared', () => {
		it('is case-insensitive and covers every spelling the emitter dispatches on', () => {
			const expected: Record<string, string> = {
				'+': 'arithmetic', '-': 'arithmetic', '*': 'arithmetic', '/': 'arithmetic', '%': 'arithmetic',
				'=': 'comparison', '==': 'comparison', '!=': 'comparison', '<>': 'comparison',
				'<': 'comparison', '<=': 'comparison', '>': 'comparison', '>=': 'comparison',
				'IS': 'is', 'is not': 'is',
				'IN': 'in', 'in': 'in',
				'AND': 'logical', 'or': 'logical', 'Xor': 'logical',
				'||': 'concat',
				'LIKE': 'like',
			};
			for (const [op, cls] of Object.entries(expected)) {
				expect(classifyBinaryOperator(op), op).to.equal(cls);
			}
		});

		it('returns undefined for an unimplemented spelling', () => {
			expect(classifyBinaryOperator('&')).to.equal(undefined);
			expect(classifyBinaryOperator('<<')).to.equal(undefined);
		});

		it('announces ANY, not the left operand type, for an unimplemented spelling', () => {
			// Nothing can execute such a node — buildBinaryOpSpec raises UNSUPPORTED — so
			// the announcement must not claim a type no value will ever be produced for.
			const node = new BinaryOpNode(
				findBinary(`select 'a' || 'b' as v`).scope,
				{ type: 'binary', operator: '&', left: { type: 'literal', value: 'a' }, right: { type: 'literal', value: 1 } },
				findBinary(`select 'a' || 'b' as v`).left,
				findBinary(`select 'a' || 'b' as v`).right,
			);
			expect(node.getType().logicalType.name).to.equal('ANY');
		});

		it('drives isComparisonOperator off the same classification', () => {
			for (const op of ['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT', 'is not']) {
				expect(isComparisonOperator(op), op).to.equal(true);
			}
			// LIKE stays out: buildLikeOpSpec ignores collation, so a conflict raised here
			// would be about a collation the operator never applies.
			for (const op of ['||', 'AND', 'OR', 'XOR', '+', 'LIKE', 'IN']) {
				expect(isComparisonOperator(op), op).to.equal(false);
			}
		});
	});
});
