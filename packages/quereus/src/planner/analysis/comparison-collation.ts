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
import type * as AST from '../../parser/ast.js';
import type { LogicalType } from '../../types/logical-type.js';
import { normalizeCollationName } from '../../util/comparison.js';
import { PhysicalType } from '../../types/logical-type.js';
import { collectCollateNames, collectColumnNames, columnIndexFromExpr } from './predicate-shape.js';

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
 * True when a logical type can never produce a text value at runtime. `ANY`
 * validates every value (it can hold text), so it is treated as potentially
 * textual despite carrying no `isTextual` marker. An absent type is unknown —
 * potentially textual.
 */
function isNonTextualLogicalType(lt: LogicalType | undefined): boolean {
	if (lt === undefined) return false;
	return lt.isTextual !== true && lt.physicalType !== PhysicalType.TEXT && lt.name !== 'ANY';
}

/**
 * True when the operand's static type can never produce a text value at
 * runtime.
 */
function isStaticallyNonTextual(node: ScalarPlanNode): boolean {
	return isNonTextualLogicalType(node.getType().logicalType);
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

/**
 * Per-column declared metadata consumed by the schema-level (AST) variant of
 * the value-discrimination gate. `ColumnSchema` is structurally assignable;
 * unit tests construct minimal literals. Absent collation means BINARY; absent
 * logical type means textuality unknown (treated as textual).
 */
export interface DeclaredColumnInfo {
	readonly collation?: string;
	readonly logicalType?: LogicalType;
}

/**
 * The collation(s) and textuality one AST comparison operand contributes,
 * resolved against declared column metadata.
 */
interface AstOperandContribution {
	/** Every collation this operand could contribute to the comparison is BINARY. */
	readonly binary: boolean;
	/** The operand's static type can never produce a text value at runtime. */
	readonly nonTextual: boolean;
}

function astOperandContribution(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
): AstOperandContribution {
	const colIdx = columnIndexFromExpr(expr, columnIndexMap);
	if (colIdx !== undefined) {
		const meta = columns[colIdx];
		return {
			binary: normalizeCollationName(meta?.collation ?? 'BINARY') === 'BINARY',
			nonTextual: isNonTextualLogicalType(meta?.logicalType),
		};
	}
	if (expr.type === 'literal') {
		// A bare literal carries no collation. Deferred (Promise) literal values
		// have unknown textuality.
		const v = (expr as AST.LiteralExpr).value;
		return { binary: true, nonTextual: !(v instanceof Promise) && typeof v !== 'string' };
	}
	// Any other expression contributes BINARY only when nothing in its subtree
	// could inject a non-BINARY collation: no non-BINARY COLLATE wrapper, and
	// every column referenced inside is BINARY-declared or non-textual (robust
	// to however collation propagates through planner node types). Textuality
	// of the result is unknown — treat as textual.
	for (const name of collectCollateNames(expr)) {
		if (normalizeCollationName(name) !== 'BINARY') {
			return { binary: false, nonTextual: false };
		}
	}
	for (const idx of collectColumnNames(expr, columnIndexMap)) {
		const meta = columns[idx];
		if (normalizeCollationName(meta?.collation ?? 'BINARY') !== 'BINARY'
			&& !isNonTextualLogicalType(meta?.logicalType)) {
			return { binary: false, nonTextual: false };
		}
	}
	return { binary: true, nonTextual: false };
}

/**
 * Schema-level (AST + declared column metadata) variant of
 * {@link isValueDiscriminatingEquality}, for fact producers that run on raw
 * AST before any plan nodes exist (`check-extraction.ts`, assertion hoist).
 *
 * Mirrors **enforcement** semantics: write-time CHECK / assertion evaluation
 * resolves declared column collations (constraint-builder threads
 * `collationName` into the CHECK scope types) plus explicit COLLATE wrappers —
 * so the comparison a declared constraint actually enforces is
 * value-discriminating exactly when every collation either operand could
 * contribute is BINARY, or both operands are statically non-textual.
 *
 * Used for ALL value-level CHECK contributions — equality facts (FDs, EC
 * pairs, constant pins/bindings) AND domain facts (ranges, BETWEEN, IN enums):
 * a text-typed domain extracted from a non-BINARY enforcement comparison
 * over-claims just like an equality fact (`check (c in ('a','b'))` under
 * NOCASE admits 'A'). Guard *scopes* are not gated here — discharge soundness
 * lives in `buildPredicateFacts`' per-conjunct gate, which assumes guard
 * scopes are evaluated under declared collations (true of enforcement).
 */
export function isValueDiscriminatingAstComparison(
	left: AST.Expression,
	right: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	columns: ReadonlyArray<DeclaredColumnInfo>,
): boolean {
	const l = astOperandContribution(left, columnIndexMap, columns);
	const r = astOperandContribution(right, columnIndexMap, columns);
	if (l.binary && r.binary) return true;
	return l.nonTextual && r.nonTextual;
}
