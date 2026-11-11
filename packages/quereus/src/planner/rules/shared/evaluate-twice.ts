import type { ScalarPlanNode } from '../../nodes/plan-node.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { hasRelationalDescendant } from '../../analysis/scalar-subqueries.js';

/**
 * True when `expr` gives the same value each time it is evaluated in one execution,
 * without re-reading a table: deterministic, writes nothing and holds no subquery.
 *
 * A rule that hands a `LimitOffset`'s own LIMIT / OFFSET expressions to a node below it
 * (`rule-key-set-seek-row-bound`, the run-time limit choice in `rule-grow-retrieve`) has
 * both nodes evaluate the same instance once each, so the two must agree. A correlated
 * expression passes: both evaluations read the same outer row from the same runtime
 * context.
 */
export function safeToEvaluateTwice(expr: ScalarPlanNode): boolean {
	return PlanNodeCharacteristics.isDeterministic(expr)
		&& !PlanNodeCharacteristics.subtreeHasSideEffects(expr)
		&& !hasRelationalDescendant(expr);
}
