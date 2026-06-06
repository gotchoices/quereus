/**
 * Per-column constraint-satisfiability checker.
 *
 * Folds the conjunction of (predicate conjuncts ∧ source domain constraints ∧
 * literal constant bindings) into per-column accumulators, then asks:
 * "is there any value of every mentioned column that satisfies every fact?"
 *
 * The fragment is intentionally narrow:
 *   - Single-column comparisons against literals (= / == / != / < / <= / > / >=).
 *   - Single-column BETWEEN literal AND literal (positive form).
 *   - Single-column IN (lit, lit, ...) and intersection across IN-lists.
 *     The empty form `x IN ()` is also recognized as trivially `unsat`.
 *   - Range from `DomainConstraint { kind: 'range' }`.
 *   - Enum from `DomainConstraint { kind: 'enum' }`.
 *   - Literal `ConstantBinding`.
 *
 * Everything else (LIKE, function calls, cross-column comparisons, OR-trees,
 * CASE, IS NULL, NOT IN with non-literal RHS, …) marks the touched columns as
 * `sawUnknown`. The checker only ever returns `unsat` when an in-scope subset
 * proves a contradiction — false positives are never emitted.
 *
 * Used by `rule-filter-contradiction` to recognize `Filter(child, false)` cases
 * that const-folding can then collapse to `EmptyRelationNode`.
 */

import type {
	ScalarPlanNode,
	DomainConstraint,
	ConstantBinding,
} from '../nodes/plan-node.js';
import type { SqlValue } from '../../common/types.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import {
	BetweenNode,
	BinaryOpNode,
	CastNode,
	CollateNode,
	LiteralNode,
	UnaryOpNode,
} from '../nodes/scalar.js';
import { InNode } from '../nodes/subquery.js';
import { compareSqlValues } from '../../util/comparison.js';
import { flipComparison } from './predicate-shape.js';

export type SatResult = 'sat' | 'unsat' | 'unknown';

/**
 * Per-column fact bag built as we walk the conjuncts/domains/bindings.
 *
 * The range half is the same shape used by `DomainConstraint { range }` —
 * unbounded sides leave `minValue` / `maxValue` undefined and ignore the
 * corresponding inclusive flag.
 */
interface ColumnAccumulator {
	minValue?: SqlValue;
	minInclusive: boolean;
	maxValue?: SqlValue;
	maxInclusive: boolean;
	/** `undefined` ⇒ no membership constraint observed; `[]` ⇒ already collapsed. */
	allowedValues?: SqlValue[];
	excluded: SqlValue[];
	sawUnknown: boolean;
}

/** Cap on the number of conjuncts we attempt to absorb. Mirrors `MAX_FDS_PER_NODE`. */
const MAX_CONJUNCTS = 64;
/** Cap on |allowedValues| / |excluded| before we collapse to `sawUnknown`. */
const MAX_VALUES_PER_COL = 64;

/**
 * Returns `'unsat'` iff the conjunction is provably contradictory within the
 * supported fragment; `'sat'` when no contradiction is found and every
 * mentioned clause was in scope; `'unknown'` otherwise. Never returns false
 * `'unsat'`.
 *
 * `attrIndex(attrId)` maps an attribute id visible to the predicate's
 * `ColumnReferenceNode`s back to the physical column index used by
 * `domains` / `bindings`. Pass an identity-style mapper if the caller has
 * already aligned them.
 *
 * `getCollation(col)` is optional; when supplied, equality / range comparisons
 * for that column use the named collation (TEXT only — numeric comparisons are
 * collation-independent). Defaults to BINARY.
 */
export function checkSatisfiability(
	conjuncts: ReadonlyArray<ScalarPlanNode>,
	domains: ReadonlyArray<DomainConstraint>,
	bindings: ReadonlyArray<ConstantBinding>,
	attrIndex: (attrId: number) => number | undefined,
	getCollation?: (col: number) => string | undefined,
): SatResult {
	if (conjuncts.length > MAX_CONJUNCTS) return 'unknown';

	const accs = new Map<number, ColumnAccumulator>();
	const collationOf = (col: number): string => getCollation?.(col) ?? 'BINARY';
	const cmp = (a: SqlValue, b: SqlValue, col: number): number =>
		compareSqlValues(a, b, collationOf(col));

	// 1) Seed accumulators from declared domains.
	for (const d of domains) {
		const acc = getOrCreate(accs, d.column);
		if (d.kind === 'range') {
			if (d.min !== undefined && d.min !== null) {
				tightenLower(acc, d.min, d.minInclusive, d.column, cmp);
			}
			if (d.max !== undefined && d.max !== null) {
				tightenUpper(acc, d.max, d.maxInclusive, d.column, cmp);
			}
		} else {
			intersectAllowed(acc, d.values, d.column, cmp);
		}
	}

	// 2) Seed accumulators from literal constant bindings. Parameter bindings
	// carry no compile-time value, so they cannot prove a contradiction.
	for (const b of bindings) {
		if (b.value.kind !== 'literal') continue;
		const v = b.value.value;
		if (v === null) continue;
		for (const col of b.attrs) {
			const acc = getOrCreate(accs, col);
			tightenLower(acc, v, true, col, cmp);
			tightenUpper(acc, v, true, col, cmp);
			intersectAllowed(acc, [v], col, cmp);
		}
	}

	// 3) Absorb each conjunct.
	for (const conj of conjuncts) {
		absorb(conj, accs, attrIndex, cmp);
	}

	// 4) Decide per-column.
	let anyUnknown = false;
	for (const [col, acc] of accs) {
		// Collapse allowedValues with the range.
		if (acc.allowedValues !== undefined) {
			const filtered: SqlValue[] = [];
			for (const v of acc.allowedValues) {
				if (!withinRange(acc, v, col, cmp)) continue;
				if (containsValue(acc.excluded, v, col, cmp)) continue;
				filtered.push(v);
			}
			if (filtered.length === 0) return 'unsat';
			acc.allowedValues = filtered;
		}

		// Range emptiness.
		if (acc.minValue !== undefined && acc.maxValue !== undefined) {
			const c = cmp(acc.minValue, acc.maxValue, col);
			if (c > 0) return 'unsat';
			if (c === 0 && (!acc.minInclusive || !acc.maxInclusive)) return 'unsat';
			// Point range pinched by an exclusion.
			if (c === 0 && acc.minInclusive && acc.maxInclusive && containsValue(acc.excluded, acc.minValue, col, cmp)) {
				return 'unsat';
			}
		}

		// Singleton allowed value excluded.
		if (acc.allowedValues && acc.allowedValues.length === 1) {
			if (containsValue(acc.excluded, acc.allowedValues[0], col, cmp)) return 'unsat';
		}

		if (acc.sawUnknown) anyUnknown = true;
	}

	return anyUnknown ? 'unknown' : 'sat';
}

function getOrCreate(accs: Map<number, ColumnAccumulator>, col: number): ColumnAccumulator {
	let acc = accs.get(col);
	if (!acc) {
		acc = {
			minInclusive: false,
			maxInclusive: false,
			excluded: [],
			sawUnknown: false,
		};
		accs.set(col, acc);
	}
	return acc;
}

function tightenLower(
	acc: ColumnAccumulator,
	value: SqlValue,
	inclusive: boolean,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	if (acc.minValue === undefined) {
		acc.minValue = value;
		acc.minInclusive = inclusive;
		return;
	}
	const c = cmp(value, acc.minValue, col);
	if (c > 0) {
		acc.minValue = value;
		acc.minInclusive = inclusive;
	} else if (c === 0 && acc.minInclusive && !inclusive) {
		acc.minInclusive = false;
	}
}

function tightenUpper(
	acc: ColumnAccumulator,
	value: SqlValue,
	inclusive: boolean,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	if (acc.maxValue === undefined) {
		acc.maxValue = value;
		acc.maxInclusive = inclusive;
		return;
	}
	const c = cmp(value, acc.maxValue, col);
	if (c < 0) {
		acc.maxValue = value;
		acc.maxInclusive = inclusive;
	} else if (c === 0 && acc.maxInclusive && !inclusive) {
		acc.maxInclusive = false;
	}
}

function intersectAllowed(
	acc: ColumnAccumulator,
	values: ReadonlyArray<SqlValue>,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	const nonNull: SqlValue[] = [];
	for (const v of values) if (v !== null) nonNull.push(v);
	if (nonNull.length > MAX_VALUES_PER_COL) {
		acc.sawUnknown = true;
		return;
	}
	if (acc.allowedValues === undefined) {
		acc.allowedValues = nonNull.slice();
		return;
	}
	const intersected: SqlValue[] = [];
	for (const v of acc.allowedValues) {
		if (containsValue(nonNull, v, col, cmp)) intersected.push(v);
	}
	acc.allowedValues = intersected;
}

function containsValue(
	arr: ReadonlyArray<SqlValue>,
	value: SqlValue,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): boolean {
	for (const v of arr) {
		if (cmp(v, value, col) === 0) return true;
	}
	return false;
}

function withinRange(
	acc: ColumnAccumulator,
	value: SqlValue,
	col: number,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): boolean {
	if (acc.minValue !== undefined) {
		const c = cmp(value, acc.minValue, col);
		if (c < 0) return false;
		if (c === 0 && !acc.minInclusive) return false;
	}
	if (acc.maxValue !== undefined) {
		const c = cmp(value, acc.maxValue, col);
		if (c > 0) return false;
		if (c === 0 && !acc.maxInclusive) return false;
	}
	return true;
}

/**
 * Strip type-preserving wrappers (CAST, COLLATE) to expose the underlying
 * literal / column reference for shape matching.
 */
function unwrap(n: ScalarPlanNode): ScalarPlanNode {
	let cur = n;
	while (cur instanceof CastNode || cur instanceof CollateNode) cur = cur.operand;
	return cur;
}

function literalOf(n: ScalarPlanNode): SqlValue | undefined {
	const u = unwrap(n);
	if (!(u instanceof LiteralNode)) return undefined;
	const v = u.expression.value;
	if (v instanceof Promise) return undefined;
	return v;
}

function columnOf(
	n: ScalarPlanNode,
	attrIndex: (attrId: number) => number | undefined,
): number | undefined {
	const u = unwrap(n);
	if (!(u instanceof ColumnReferenceNode)) return undefined;
	return attrIndex(u.attributeId);
}

/**
 * Walk every column reference inside `n` and mark its accumulator `sawUnknown`.
 * Used when a sub-expression doesn't fit the recognized shape — we still flag
 * "we saw something about this column" so callers don't claim a clean `sat`.
 */
function markUnknownForColumns(
	n: ScalarPlanNode,
	accs: Map<number, ColumnAccumulator>,
	attrIndex: (attrId: number) => number | undefined,
): void {
	const stack: ScalarPlanNode[] = [n];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (cur instanceof ColumnReferenceNode) {
			const idx = attrIndex(cur.attributeId);
			if (idx !== undefined) getOrCreate(accs, idx).sawUnknown = true;
			continue;
		}
		for (const child of cur.getChildren()) {
			if ('expression' in child) stack.push(child as ScalarPlanNode);
		}
	}
}

function absorb(
	conj: ScalarPlanNode,
	accs: Map<number, ColumnAccumulator>,
	attrIndex: (attrId: number) => number | undefined,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	if (conj instanceof BinaryOpNode) {
		const op = conj.expression.operator;
		switch (op) {
			case '=':
			case '==':
			case '!=':
			case '<>':
			case '<':
			case '<=':
			case '>':
			case '>=': {
				absorbBinary(conj, op, accs, attrIndex, cmp);
				return;
			}
			default: {
				markUnknownForColumns(conj, accs, attrIndex);
				return;
			}
		}
	}
	if (conj instanceof BetweenNode) {
		if (conj.expression.not === true) {
			markUnknownForColumns(conj, accs, attrIndex);
			return;
		}
		const col = columnOf(conj.expr, attrIndex);
		const lo = literalOf(conj.lower);
		const hi = literalOf(conj.upper);
		if (col === undefined || lo === undefined || hi === undefined || lo === null || hi === null) {
			markUnknownForColumns(conj, accs, attrIndex);
			return;
		}
		const acc = getOrCreate(accs, col);
		tightenLower(acc, lo, true, col, cmp);
		tightenUpper(acc, hi, true, col, cmp);
		return;
	}
	if (conj instanceof InNode) {
		// Only literal-only IN-lists with a column-reference condition can
		// contribute to the enum/intersection reasoning.
		if (conj.source !== undefined) {
			markUnknownForColumns(conj, accs, attrIndex);
			return;
		}
		const col = columnOf(conj.condition, attrIndex);
		if (col === undefined) {
			// Non-column LHS (e.g. `(a + b) IN (...)`) — out of scope.
			markUnknownForColumns(conj, accs, attrIndex);
			return;
		}
		if (!conj.values || conj.values.length === 0) {
			// `x IN ()` is always false → empty allowedValues forces the decision
			// loop's `filtered.length === 0` step to return `unsat`.
			intersectAllowed(getOrCreate(accs, col), [], col, cmp);
			return;
		}
		const values: SqlValue[] = [];
		for (const v of conj.values) {
			const lit = literalOf(v);
			if (lit === undefined) {
				markUnknownForColumns(conj, accs, attrIndex);
				return;
			}
			values.push(lit);
		}
		intersectAllowed(getOrCreate(accs, col), values, col, cmp);
		return;
	}
	if (conj instanceof UnaryOpNode) {
		// `IS NULL` / `IS NOT NULL` / `NOT (...)` — out of scope for v1.
		markUnknownForColumns(conj, accs, attrIndex);
		return;
	}
	// Anything else: literal-bool / CASE / function call / etc.
	markUnknownForColumns(conj, accs, attrIndex);
}

function absorbBinary(
	conj: BinaryOpNode,
	op: string,
	accs: Map<number, ColumnAccumulator>,
	attrIndex: (attrId: number) => number | undefined,
	cmp: (a: SqlValue, b: SqlValue, col: number) => number,
): void {
	// Normalize `lit op col` → `col flipped lit`.
	let col = columnOf(conj.left, attrIndex);
	let lit = literalOf(conj.right);
	let normOp = op;
	if (col === undefined) {
		col = columnOf(conj.right, attrIndex);
		lit = literalOf(conj.left);
		normOp = flipComparison(op);
	}
	if (col === undefined || lit === undefined) {
		markUnknownForColumns(conj, accs, attrIndex);
		return;
	}
	// NULL literal in a comparison → result is NULL/UNKNOWN; treat as
	// out-of-scope. Domain reasoning here would over-conclude unsat.
	if (lit === null) {
		markUnknownForColumns(conj, accs, attrIndex);
		return;
	}
	const acc = getOrCreate(accs, col);
	switch (normOp) {
		case '=':
		case '==':
			tightenLower(acc, lit, true, col, cmp);
			tightenUpper(acc, lit, true, col, cmp);
			intersectAllowed(acc, [lit], col, cmp);
			return;
		case '!=':
		case '<>':
			if (acc.excluded.length < MAX_VALUES_PER_COL) {
				if (!containsValue(acc.excluded, lit, col, cmp)) acc.excluded.push(lit);
			} else {
				acc.sawUnknown = true;
			}
			return;
		case '<':
			tightenUpper(acc, lit, false, col, cmp);
			return;
		case '<=':
			tightenUpper(acc, lit, true, col, cmp);
			return;
		case '>':
			tightenLower(acc, lit, false, col, cmp);
			return;
		case '>=':
			tightenLower(acc, lit, true, col, cmp);
			return;
		default:
			markUnknownForColumns(conj, accs, attrIndex);
			return;
	}
}
