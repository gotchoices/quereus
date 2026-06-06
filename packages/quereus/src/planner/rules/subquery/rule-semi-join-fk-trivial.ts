/**
 * Rule: Semi-Join FK → Trivial
 *
 * Inclusion-dependency folding for `EXISTS` / `IN` patterns after
 * `rule-subquery-decorrelation` has materialized them as semi-joins.
 *
 * Pattern:
 *   SemiJoin(L, R, p)
 *     where p is an AND-of-column-equalities,
 *     L's equi columns form a declared FK referencing R's PK, and
 *     R is a row-preserving path to its base table.
 *
 * Rewrite:
 *   - FK columns all NOT NULL → replace the SemiJoin with L (every L row matches
 *     in R by the IND `L.fk ⊆ R.pk`).
 *   - FK has any nullable column → replace with `Filter(L, fk_col_1 IS NOT NULL
 *     AND … AND fk_col_n IS NOT NULL)`. Rows with NULL in any FK column would
 *     not match the equi-condition (NULL compares to UNKNOWN, never `true`)
 *     and so would not survive the semi-join.
 *
 * Either way the R side never executes — a meaningful win for federated vtabs
 * where R is a remote table.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, Attribute } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import type { Scope } from '../../scopes/scope.js';
import type * as AST from '../../../parser/ast.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { UnaryOpNode, BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { lookupCoveringFK, isRowPreservingPathToTable, tableSchemaOf } from '../../util/ind-utils.js';
import { isAndOfColumnEqualities } from '../join/rule-join-elimination.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:semi-join-fk-trivial');

export function ruleSemiJoinFkTrivial(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof JoinNode)) return null;
	if (node.joinType !== 'semi') return null;
	if (!node.condition) return null;

	const normalized = normalizePredicate(node.condition);
	if (!isAndOfColumnEqualities(normalized)) return null;

	const leftAttrs = node.left.getAttributes();
	const rightAttrs = node.right.getAttributes();
	const pairs = extractEquiPairsFromCondition(node.condition, leftAttrs, rightAttrs);
	if (pairs.length === 0) return null;

	const leftSchema = tableSchemaOf(node.left);
	const rightSchema = tableSchemaOf(node.right);
	if (!leftSchema || !rightSchema) return null;

	const childEquiCols = pairs.map(p => p.left);
	const parentEquiCols = pairs.map(p => p.right);
	const match = lookupCoveringFK(leftSchema, rightSchema, childEquiCols, parentEquiCols);
	if (!match) return null;

	// The parent side must be the full table — if rows were filtered out, the
	// IND inclusion doesn't preserve "every L row has a match" under filtering.
	if (!isRowPreservingPathToTable(node.right)) return null;

	// Refuse to drop the R side when it carries a write — the rewrite replaces
	// the semi-join with L (or Filter(L)) and the R subtree is dropped entirely.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(node.right)) {
		log('Semi-join trivialization skipped: R side has side effects');
		return null;
	}

	if (!match.nullable) {
		log('Dropping semi-join over non-null FK %s → %s; left side survives unchanged',
			leftSchema.name, rightSchema.name);
		return node.left;
	}

	// Nullable FK: rows with NULL in any FK column never match in the semi-join.
	// Replace the join with `Filter(L, fk IS NOT NULL AND …)`.
	const predicate = buildIsNotNullPredicate(node.scope, leftAttrs, childEquiCols);
	if (!predicate) return null;

	log('Trivializing semi-join over nullable FK %s → %s to Filter(L, fk IS NOT NULL)',
		leftSchema.name, rightSchema.name);
	return new FilterNode(node.scope, node.left, predicate);
}

/**
 * Build `col_1 IS NOT NULL AND col_2 IS NOT NULL AND …` over the given
 * attribute indices into `leftAttrs`. Returns null if `cols` is empty.
 */
function buildIsNotNullPredicate(
	scope: Scope,
	leftAttrs: readonly Attribute[],
	cols: ReadonlyArray<number>,
): ScalarPlanNode | null {
	if (cols.length === 0) return null;

	const conjuncts: ScalarPlanNode[] = cols.map(idx => {
		const attr = leftAttrs[idx];
		const colExpr: AST.ColumnExpr = attr.relationName
			? { type: 'column', name: attr.name, table: attr.relationName }
			: { type: 'column', name: attr.name };
		const colRef = new ColumnReferenceNode(scope, colExpr, attr.type, attr.id, idx);
		const notNullAst: AST.UnaryExpr = {
			type: 'unary',
			operator: 'IS NOT NULL',
			expr: colExpr,
		};
		return new UnaryOpNode(scope, notNullAst, colRef);
	});

	return conjuncts.reduce((acc, cur) => {
		const andAst: AST.BinaryExpr = {
			type: 'binary',
			operator: 'AND',
			left: acc.expression,
			right: cur.expression,
		};
		return new BinaryOpNode(scope, andAst, acc, cur);
	});
}
