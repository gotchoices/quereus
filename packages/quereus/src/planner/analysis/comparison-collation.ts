/**
 * Plan-time resolution of a comparison's *effective collation*, mirroring the
 * runtime resolution exactly so plan-time facts and runtime behavior cannot
 * drift:
 *
 *   - `emitComparisonOp` (runtime/emit/binary.ts): the right operand's
 *     collation, else the left's, else BINARY.
 *   - `emitIn` (runtime/emit/subquery.ts): the condition (LHS) operand's
 *     collation, else BINARY.
 *   - `emitBetween` (runtime/emit/between.ts): per-bound — the bound's
 *     collation, else the tested expression's, else BINARY.
 *
 * Consumers: the access-path rule (`rule-select-access-path.ts` collation-cover
 * analysis) and the equality-fact extractors (`fd-utils.ts`), which must only
 * mint VALUE-level facts from comparisons whose effective collation is
 * value-discriminating (see {@link isValueDiscriminatingEquality}).
 */

import type { ScalarPlanNode } from '../nodes/plan-node.js';
import { normalizeCollationName } from '../../util/comparison.js';
import { PhysicalType } from '../../types/logical-type.js';

/**
 * The collation a single operand contributes to a comparison, normalized.
 * `'BINARY'` when the operand's type carries none.
 */
export function operandCollation(node: ScalarPlanNode): string {
	return normalizeCollationName(node.getType().collationName ?? 'BINARY');
}

/**
 * Effective collation of a binary comparison `left <op> right`, in *written*
 * operand order. Mirrors `emitComparisonOp`: right precedence, then left,
 * then BINARY.
 */
export function effectiveComparisonCollation(left: ScalarPlanNode, right: ScalarPlanNode): string {
	return normalizeCollationName(
		right.getType().collationName ?? left.getType().collationName ?? 'BINARY',
	);
}

/**
 * Effective collation of `condition IN (...)`. Mirrors `emitIn`: the
 * condition (LHS) operand's collation, else BINARY — the listed values'
 * collations never participate.
 */
export function effectiveInCollation(condition: ScalarPlanNode): string {
	return normalizeCollationName(condition.getType().collationName ?? 'BINARY');
}

/**
 * Effective collation of one BETWEEN bound comparison. Mirrors `emitBetween`:
 * the bound's collation wins over the tested expression's, else BINARY.
 */
export function effectiveBetweenBoundCollation(expr: ScalarPlanNode, bound: ScalarPlanNode): string {
	return normalizeCollationName(
		bound.getType().collationName ?? expr.getType().collationName ?? 'BINARY',
	);
}

/**
 * True when the operand's static type can never produce a text value at
 * runtime. `ANY` validates every value (it can hold text), so it is treated
 * as potentially textual despite carrying no `isTextual` marker.
 */
function isStaticallyNonTextual(node: ScalarPlanNode): boolean {
	const lt = node.getType().logicalType;
	if (lt === undefined) return false;
	return lt.isTextual !== true && lt.physicalType !== PhysicalType.TEXT && lt.name !== 'ANY';
}

/**
 * True iff an equality `left = right` is **value-discriminating**: rows it
 * passes are genuinely value-equal on the compared operands, so the conjunct
 * may mint value-level facts (constant pins `∅ → col`, `col1 = col2` mirror
 * FDs, equivalence classes, constant bindings, join equi-pairs).
 *
 * Rule (the soundness gate from ticket
 * `collation-blind-equality-fact-extraction`):
 *   - non-textual operands: always — collation does not apply to non-text
 *     comparisons (`compareSqlValuesFast` only consults the collation function
 *     for text/text; cross-class comparisons order by storage class);
 *   - textual (or statically unknown) operands: every collation either
 *     operand could contribute must be BINARY. A NOCASE/RTRIM comparison
 *     passes value-DIFFERENT rows ('Bob' = 'bob' NOCASE), so any value-level
 *     fact minted from it over-claims.
 *
 * Both sides are checked (not just the right-precedence winner of
 * `effectiveComparisonCollation`) so the gate stays robust to per-algorithm
 * resolution-order differences among runtime comparison sites
 * (`emitComparisonOp` resolves right-first; the merge/bloom join emitters
 * resolve left-first).
 */
export function isValueDiscriminatingEquality(left: ScalarPlanNode, right: ScalarPlanNode): boolean {
	if (operandCollation(left) === 'BINARY' && operandCollation(right) === 'BINARY') return true;
	// A non-BINARY collation is in play; it is inert only when text values can
	// never meet at runtime.
	return isStaticallyNonTextual(left) && isStaticallyNonTextual(right);
}
