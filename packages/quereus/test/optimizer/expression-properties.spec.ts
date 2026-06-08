import { expect } from 'chai';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode, LiteralNode, UnaryOpNode, CastNode, BetweenNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../../src/planner/nodes/reference.js';
import { ScalarFunctionCallNode } from '../../src/planner/nodes/function.js';
import {
	addMonotonicity,
	negateMonotonicity,
	type Monotonicity,
	type ScalarPlanNode,
} from '../../src/planner/nodes/plan-node.js';
import type { ScalarFunctionSchema } from '../../src/schema/function.js';
import { FunctionFlags } from '../../src/common/constants.js';
import type * as AST from '../../src/parser/ast.js';
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scope = EmptyScope.instance as unknown as any;

// ---- Construction helpers ---------------------------------------------------

function colRef(attrId: number, name = 'c', index = 0, numeric = true): ColumnReferenceNode {
	const expr = { type: 'column', name } as unknown as AST.ColumnExpr;
	const columnType = {
		typeClass: 'scalar' as const,
		logicalType: numeric ? INTEGER_TYPE : TEXT_TYPE,
		nullable: false,
		isReadOnly: false,
	};
	return new ColumnReferenceNode(scope, expr, columnType, attrId, index);
}

function lit(value: number | string | bigint | null): LiteralNode {
	const expr = { type: 'literal', value } as unknown as AST.LiteralExpr;
	return new LiteralNode(scope, expr);
}

function param(nameOrIndex: string | number = ':p'): ParameterReferenceNode {
	const expr = { type: 'parameter', name: typeof nameOrIndex === 'string' ? nameOrIndex : undefined, index: typeof nameOrIndex === 'number' ? nameOrIndex : undefined } as unknown as AST.ParameterExpr;
	return new ParameterReferenceNode(scope, expr, nameOrIndex, {
		typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true,
	});
}

function binOp(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast = {
		type: 'binary',
		operator: op,
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	} as AST.BinaryExpr;
	return new BinaryOpNode(scope, ast, left, right);
}

function unaryOp(op: string, operand: ScalarPlanNode): UnaryOpNode {
	const ast = {
		type: 'unary',
		operator: op,
		expr: (operand as unknown as { expression: AST.Expression }).expression,
	} as AST.UnaryExpr;
	return new UnaryOpNode(scope, ast, operand);
}

function castNode(operand: ScalarPlanNode, targetType = 'INTEGER'): CastNode {
	const ast = {
		type: 'cast',
		expr: (operand as unknown as { expression: AST.Expression }).expression,
		targetType,
	} as AST.CastExpr;
	return new CastNode(scope, ast, operand);
}

function makeFnSchema(opts: Partial<ScalarFunctionSchema> & { name: string; numArgs: number }): ScalarFunctionSchema {
	return {
		name: opts.name,
		numArgs: opts.numArgs,
		flags: opts.flags ?? (FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC),
		returnType: opts.returnType ?? {
			typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true,
		},
		implementation: opts.implementation ?? (() => null),
		injectiveOnArgs: opts.injectiveOnArgs,
		monotoneOnArgs: opts.monotoneOnArgs,
		rangeRewriteOnArg: opts.rangeRewriteOnArg,
	};
}

function fnCall(schema: ScalarFunctionSchema, operands: ScalarPlanNode[]): ScalarFunctionCallNode {
	const ast = {
		type: 'function',
		name: schema.name,
		args: operands.map(o => (o as unknown as { expression: AST.Expression }).expression),
	} as unknown as AST.FunctionExpr;
	return new ScalarFunctionCallNode(scope, ast, schema, operands);
}

// ---- Default-helper sanity checks ------------------------------------------

describe('Monotonicity helper functions', () => {
	it('negateMonotonicity flips increasing/decreasing and preserves others', () => {
		expect(negateMonotonicity('increasing')).to.equal('decreasing');
		expect(negateMonotonicity('decreasing')).to.equal('increasing');
		expect(negateMonotonicity('constant')).to.equal('constant');
		expect(negateMonotonicity('non_monotone')).to.equal('non_monotone');
		expect(negateMonotonicity('unknown')).to.equal('unknown');
	});

	it('addMonotonicity follows expected lattice', () => {
		const a: Monotonicity[] = ['increasing', 'decreasing', 'constant', 'non_monotone', 'unknown'];
		const b: Monotonicity[] = ['increasing', 'decreasing', 'constant', 'non_monotone', 'unknown'];
		const expected: Record<string, Record<string, Monotonicity>> = {
			increasing: { increasing: 'increasing', decreasing: 'unknown', constant: 'increasing', non_monotone: 'non_monotone', unknown: 'unknown' },
			decreasing: { increasing: 'unknown', decreasing: 'decreasing', constant: 'decreasing', non_monotone: 'non_monotone', unknown: 'unknown' },
			constant: { increasing: 'increasing', decreasing: 'decreasing', constant: 'constant', non_monotone: 'non_monotone', unknown: 'unknown' },
			non_monotone: { increasing: 'non_monotone', decreasing: 'non_monotone', constant: 'non_monotone', non_monotone: 'non_monotone', unknown: 'unknown' },
			unknown: { increasing: 'unknown', decreasing: 'unknown', constant: 'unknown', non_monotone: 'unknown', unknown: 'unknown' },
		};
		for (const x of a) {
			for (const y of b) {
				expect(addMonotonicity(x, y), `${x} + ${y}`).to.equal(expected[x][y]);
			}
		}
	});
});

// ---- ColumnReferenceNode ----------------------------------------------------

describe('ColumnReferenceNode property inference', () => {
	it('matches own attribute: injective + increasing', () => {
		const c = colRef(7);
		expect(c.isInjectiveIn(7).injective).to.equal(true);
		expect(c.monotonicityIn(7).monotonicity).to.equal('increasing');
	});

	it('different attribute: not injective + constant', () => {
		const c = colRef(7);
		expect(c.isInjectiveIn(99).injective).to.equal(false);
		expect(c.monotonicityIn(99).monotonicity).to.equal('constant');
	});
});

// ---- LiteralNode / ParameterReferenceNode ----------------------------------

describe('LiteralNode and ParameterReferenceNode property inference', () => {
	it('literal is constant in any attribute and not injective', () => {
		const v = lit(42);
		expect(v.monotonicityIn(0).monotonicity).to.equal('constant');
		expect(v.monotonicityIn(123).monotonicity).to.equal('constant');
		expect(v.isInjectiveIn(0).injective).to.equal(false);
	});

	it('parameter is constant in any attribute and not injective', () => {
		const p = param(':x');
		expect(p.monotonicityIn(0).monotonicity).to.equal('constant');
		expect(p.monotonicityIn(42).monotonicity).to.equal('constant');
		expect(p.isInjectiveIn(0).injective).to.equal(false);
	});
});

// ---- UnaryOpNode -----------------------------------------------------------

describe('UnaryOpNode property inference', () => {
	it('unary minus on numeric col: injective + decreasing in that col', () => {
		const c = colRef(1);
		const neg = unaryOp('-', c);
		expect(neg.isInjectiveIn(1).injective).to.equal(true);
		expect(neg.monotonicityIn(1).monotonicity).to.equal('decreasing');
	});

	it('unary plus on numeric col: passes through', () => {
		const c = colRef(1);
		const plus = unaryOp('+', c);
		expect(plus.isInjectiveIn(1).injective).to.equal(true);
		expect(plus.monotonicityIn(1).monotonicity).to.equal('increasing');
	});

	it('NOT / IS NULL / ~ default to unknown / not injective', () => {
		const c = colRef(1);
		for (const op of ['NOT', 'IS NULL', '~']) {
			const u = unaryOp(op, c);
			expect(u.isInjectiveIn(1).injective, `${op} injective`).to.equal(false);
			expect(u.monotonicityIn(1).monotonicity, `${op} monotonicity`).to.equal('unknown');
		}
	});

	it('double negation is increasing again (composition)', () => {
		const c = colRef(1);
		const negNeg = unaryOp('-', unaryOp('-', c));
		expect(negNeg.isInjectiveIn(1).injective).to.equal(true);
		expect(negNeg.monotonicityIn(1).monotonicity).to.equal('increasing');
	});
});

// ---- BinaryOpNode ----------------------------------------------------------

describe('BinaryOpNode property inference (numeric + / -)', () => {
	it('col + literal: injective + increasing', () => {
		const c = colRef(1);
		const e = binOp('+', c, lit(1));
		expect(e.isInjectiveIn(1).injective).to.equal(true);
		expect(e.monotonicityIn(1).monotonicity).to.equal('increasing');
	});

	it('literal + col: injective + increasing', () => {
		const c = colRef(1);
		const e = binOp('+', lit(1), c);
		expect(e.isInjectiveIn(1).injective).to.equal(true);
		expect(e.monotonicityIn(1).monotonicity).to.equal('increasing');
	});

	it('col - literal: injective + increasing', () => {
		const c = colRef(1);
		const e = binOp('-', c, lit(1));
		expect(e.isInjectiveIn(1).injective).to.equal(true);
		expect(e.monotonicityIn(1).monotonicity).to.equal('increasing');
	});

	it('literal - col: injective + decreasing (flips for right of -)', () => {
		const c = colRef(1);
		const e = binOp('-', lit(1), c);
		expect(e.isInjectiveIn(1).injective).to.equal(true);
		expect(e.monotonicityIn(1).monotonicity).to.equal('decreasing');
	});

	it('parameter on either side acts like a constant', () => {
		const c = colRef(1);
		const e = binOp('+', c, param(':p'));
		expect(e.isInjectiveIn(1).injective).to.equal(true);
		expect(e.monotonicityIn(1).monotonicity).to.equal('increasing');

		const e2 = binOp('-', param(':p'), c);
		expect(e2.isInjectiveIn(1).injective).to.equal(true);
		expect(e2.monotonicityIn(1).monotonicity).to.equal('decreasing');
	});

	it('two columns of same direction: monotone but not always injective', () => {
		// col1 + col2 (both increasing in their own attrId): not monotone in attrId=1 alone
		// because col2 is constant w.r.t. attrId=1 → fall-through to "right side flat" rule.
		const c1 = colRef(1);
		const c2 = colRef(2);
		const e = binOp('+', c1, c2);
		// c2 is monotonicity 'constant' in attrId=1 (it doesn't depend on attr 1)
		expect(e.monotonicityIn(1).monotonicity).to.equal('increasing');
		expect(e.isInjectiveIn(1).injective).to.equal(true);
	});

	it('col + col (same column twice): increasing (sum of two increasing) and injective', () => {
		const c1 = colRef(1);
		const c1b = colRef(1); // same attrId
		const e = binOp('+', c1, c1b);
		expect(e.monotonicityIn(1).monotonicity).to.equal('increasing');
		expect(e.isInjectiveIn(1).injective).to.equal(true);
	});

	it('col - col (same column twice): unknown monotonicity, not injective', () => {
		const c1 = colRef(1);
		const c1b = colRef(1);
		const e = binOp('-', c1, c1b);
		// increasing + negate(increasing) = increasing + decreasing = unknown
		expect(e.monotonicityIn(1).monotonicity).to.equal('unknown');
		expect(e.isInjectiveIn(1).injective).to.equal(false);
	});

	it('non-numeric BinaryOp returns unknown', () => {
		const a = colRef(1, 'a', 0, /*numeric*/ false);
		const b = lit('x');
		const e = binOp('||', a, b);
		expect(e.monotonicityIn(1).monotonicity).to.equal('unknown');
		expect(e.isInjectiveIn(1).injective).to.equal(false);
	});

	it('comparison and logical ops default to unknown / not injective', () => {
		const c = colRef(1);
		for (const op of ['=', '<', '>', 'AND', 'OR', '*', '/']) {
			const e = binOp(op, c, lit(2));
			expect(e.monotonicityIn(1).monotonicity, `${op} monotonicity`).to.equal('unknown');
			expect(e.isInjectiveIn(1).injective, `${op} injective`).to.equal(false);
		}
	});

	it('compositional: (col + 1) - 2 → injective + increasing in col', () => {
		const c = colRef(1);
		const e = binOp('-', binOp('+', c, lit(1)), lit(2));
		expect(e.monotonicityIn(1).monotonicity).to.equal('increasing');
		expect(e.isInjectiveIn(1).injective).to.equal(true);
	});

	it('compositional: -(col + 1) → injective + decreasing in col', () => {
		const c = colRef(1);
		const e = unaryOp('-', binOp('+', c, lit(1)));
		expect(e.monotonicityIn(1).monotonicity).to.equal('decreasing');
		expect(e.isInjectiveIn(1).injective).to.equal(true);
	});
});

// ---- ScalarFunctionCallNode ------------------------------------------------

describe('ScalarFunctionCallNode property inference via FunctionSchema traits', () => {
	it('untraited function: not injective, unknown monotonicity', () => {
		const f = makeFnSchema({ name: 'foo', numArgs: 1 });
		const c = colRef(1);
		const call = fnCall(f, [c]);
		expect(call.isInjectiveIn(1).injective).to.equal(false);
		expect(call.monotonicityIn(1).monotonicity).to.equal('unknown');
	});

	it('injectiveOnArgs propagates through child injectivity', () => {
		const f = makeFnSchema({ name: 'inj', numArgs: 1, injectiveOnArgs: [0] });
		const c = colRef(1);
		const call = fnCall(f, [c]);
		expect(call.isInjectiveIn(1).injective).to.equal(true);
	});

	it('injectiveOnArgs with non-injective child: not injective', () => {
		const f = makeFnSchema({ name: 'inj', numArgs: 1, injectiveOnArgs: [0] });
		const litArg = lit(7);
		const call = fnCall(f, [litArg]);
		// child literal is not injective in any attr; even though the function
		// is declared injective on arg 0, the *composition* isn't.
		expect(call.isInjectiveIn(1).injective).to.equal(false);
	});

	it('monotoneOnArgs (increasing) composes with increasing child → increasing', () => {
		const f = makeFnSchema({ name: 'g', numArgs: 1, monotoneOnArgs: { 0: 'increasing' } });
		const c = colRef(1);
		const call = fnCall(f, [c]);
		expect(call.monotonicityIn(1).monotonicity).to.equal('increasing');
	});

	it('monotoneOnArgs (decreasing) composes with increasing child → decreasing', () => {
		const f = makeFnSchema({ name: 'h', numArgs: 1, monotoneOnArgs: { 0: 'decreasing' } });
		const c = colRef(1);
		const call = fnCall(f, [c]);
		expect(call.monotonicityIn(1).monotonicity).to.equal('decreasing');
	});

	it('two-arg fn: injective only in the dependent arg (other args constant)', () => {
		const f = makeFnSchema({ name: 'h2', numArgs: 2, injectiveOnArgs: [0], monotoneOnArgs: { 0: 'increasing' } });
		const c = colRef(1);
		const k = lit(5);
		const call = fnCall(f, [c, k]);
		expect(call.isInjectiveIn(1).injective).to.equal(true);
		expect(call.monotonicityIn(1).monotonicity).to.equal('increasing');
	});

	it('two-arg fn with both args depending on attrId: unknown / not injective', () => {
		const f = makeFnSchema({ name: 'h2', numArgs: 2, injectiveOnArgs: [0], monotoneOnArgs: { 0: 'increasing' } });
		const c1 = colRef(1);
		const c2 = colRef(1); // both depend on attr 1
		const call = fnCall(f, [c1, c2]);
		expect(call.isInjectiveIn(1).injective).to.equal(false);
		expect(call.monotonicityIn(1).monotonicity).to.equal('unknown');
	});

	it('unrelated attrId where no operand depends → constant', () => {
		const f = makeFnSchema({ name: 'g', numArgs: 1, monotoneOnArgs: { 0: 'increasing' } });
		const c = colRef(1);
		const call = fnCall(f, [c]);
		// Asking about a different attribute (call doesn't depend on it).
		expect(call.monotonicityIn(99).monotonicity).to.equal('constant');
		expect(call.isInjectiveIn(99).injective).to.equal(false);
	});
});

// ---- Conservative defaults on other scalar nodes ---------------------------

describe('Conservative defaults on other scalar nodes', () => {
	it('CastNode falls back to base default (unknown / not injective)', () => {
		const c = colRef(1);
		const cn = castNode(c, 'TEXT');
		expect(cn.isInjectiveIn(1).injective).to.equal(false);
		expect(cn.monotonicityIn(1).monotonicity).to.equal('unknown');
	});

	it('BetweenNode falls back to base default', () => {
		const c = colRef(1);
		const b = new BetweenNode(scope, {
			type: 'between',
			expr: (c as unknown as { expression: AST.Expression }).expression,
			lower: (lit(0) as unknown as { expression: AST.Expression }).expression,
			upper: (lit(10) as unknown as { expression: AST.Expression }).expression,
			not: false,
		} as AST.BetweenExpr, c, lit(0), lit(10));
		expect(b.isInjectiveIn(1).injective).to.equal(false);
		expect(b.monotonicityIn(1).monotonicity).to.equal('unknown');
	});
});

// ---- rangeRewriteIn surface ------------------------------------------------

describe('rangeRewriteIn surface', () => {
	it('returns undefined when function has no rangeRewriteOnArg trait', () => {
		const f = makeFnSchema({ name: 'foo', numArgs: 1 });
		const c = colRef(1);
		const call = fnCall(f, [c]);
		expect(call.rangeRewriteIn(1, 0)).to.equal(undefined);
	});

	it('returns undefined when no operand depends on inputAttrId', () => {
		const f = makeFnSchema({ name: 'date_bucket_fn', numArgs: 1, rangeRewriteOnArg: { 0: { kind: 'date_bucket' } } });
		const k = lit(5);
		const call = fnCall(f, [k]);
		expect(call.rangeRewriteIn(1, 0)).to.equal(undefined);
	});

	it('returns undefined when the operand’s logical type lacks bucketBounds', () => {
		// INTEGER_TYPE has no bucketBounds — ensure we fail safe.
		const f = makeFnSchema({ name: 'date_bucket_fn', numArgs: 1, rangeRewriteOnArg: { 0: { kind: 'date_bucket' } } });
		const c = colRef(1); // INTEGER
		const call = fnCall(f, [c]);
		expect(call.rangeRewriteIn(1, 0)).to.equal(undefined);
	});

	it('returns undefined when the operand is not a bare column reference (identity-only)', () => {
		// Even when the operand is monotone-increasing in attrId, we only rewrite
		// f(x) op c — never f(g(x)) op c — because bucketBounds answers in the
		// operand's space, not attrId's. Build a logical type with bucketBounds
		// and feed it through a non-identity operand to ensure we still fail safe.
		const TYPED: typeof INTEGER_TYPE = {
			...INTEGER_TYPE,
			bucketBounds: () => ({ lowerInclusive: 0, upperExclusive: 1 }),
		};
		const TYPED_SCALAR = {
			typeClass: 'scalar' as const,
			logicalType: TYPED,
			nullable: false,
			isReadOnly: false,
		};
		// Inner function: monotone-increasing on its sole arg, returning the typed scalar.
		const inner = makeFnSchema({
			name: 'inner_fn', numArgs: 1,
			monotoneOnArgs: { 0: 'increasing' },
			returnType: TYPED_SCALAR,
		});
		// Outer function: declares range-rewrite on its sole arg.
		const outer = makeFnSchema({
			name: 'outer_fn', numArgs: 1,
			rangeRewriteOnArg: { 0: { kind: 'bucket' } },
			returnType: TYPED_SCALAR,
		});
		const c = colRef(1);
		const composed = fnCall(outer, [fnCall(inner, [c])]);
		// Inner is increasing in attr 1 and its return type has bucketBounds, but
		// the operand is fnCall(inner) — not a bare ColumnReferenceNode — so we must
		// refuse the rewrite.
		expect(composed.rangeRewriteIn(1, 0)).to.equal(undefined);
	});
});
