import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:validation:determinism');

/**
 * Result of determinism validation. If valid, `error` is undefined.
 * If invalid, contains the information needed to construct an error message.
 */
export interface DeterminismValidationResult {
	/** True if the expression is deterministic */
	valid: boolean;
	/** String representation of the offending expression (if invalid) */
	expression?: string;
}

/**
 * Checks if an expression is deterministic (suitable for constraints and defaults).
 * Returns a result object instead of throwing, allowing the caller to decide how to handle.
 *
 * @param expr The expression plan node to check
 * @returns Validation result indicating if deterministic
 */
export function checkDeterministic(expr: ScalarPlanNode): DeterminismValidationResult {
	const physical = expr.physical;

	if (physical.deterministic === false) {
		log('Non-deterministic expression detected: %s', expr.toString());
		return {
			valid: false,
			expression: expr.toString()
		};
	}

	return { valid: true };
}

/**
 * Validates that an expression is deterministic (suitable for constraints and defaults).
 * Non-deterministic expressions must be passed via mutation context instead.
 *
 * @param expr The expression plan node to validate
 * @param context Description of where the expression is used (e.g., "DEFAULT for column 'created_at'")
 * @throws QuereusError if the expression is non-deterministic
 */
export function validateDeterministicExpression(
	expr: ScalarPlanNode,
	context: string
): void {
	log('Validating determinism for: %s', context);

	const result = checkDeterministic(expr);

	if (!result.valid) {
		throw new QuereusError(
			`Non-deterministic expression not allowed in ${context}. ` +
			`Expression: ${result.expression}. ` +
			`Use mutation context to pass non-deterministic values (e.g., WITH CONTEXT (timestamp = datetime('now'))).`,
			StatusCode.ERROR
		);
	}

	log('Expression is deterministic: %s', expr.toString());
}

/**
 * Validates that a CHECK constraint expression is deterministic.
 *
 * @param expr The constraint expression plan node
 * @param constraintName The name of the constraint (for error messages)
 * @param tableName The name of the table (for error messages)
 * @throws QuereusError if the expression is non-deterministic
 */
export function validateDeterministicConstraint(
	expr: ScalarPlanNode,
	constraintName: string,
	tableName: string
): void {
	validateDeterministicExpression(
		expr,
		`CHECK constraint '${constraintName}' on table '${tableName}'`
	);
}

/**
 * Validates that a GENERATED ALWAYS AS expression is deterministic.
 *
 * @param expr The generated column expression plan node
 * @param columnName The name of the column (for error messages)
 * @param tableName The name of the table (for error messages)
 * @throws QuereusError if the expression is non-deterministic
 */
export function validateDeterministicGenerated(
	expr: ScalarPlanNode,
	columnName: string,
	tableName: string
): void {
	validateDeterministicExpression(
		expr,
		`GENERATED ALWAYS AS for column '${columnName}' in table '${tableName}'`
	);
}

/**
 * Validates that a DEFAULT expression is deterministic.
 *
 * @param expr The default value expression plan node
 * @param columnName The name of the column (for error messages)
 * @param tableName The name of the table (for error messages)
 * @throws QuereusError if the expression is non-deterministic
 */
export function validateDeterministicDefault(
	expr: ScalarPlanNode,
	columnName: string,
	tableName: string
): void {
	validateDeterministicExpression(
		expr,
		`DEFAULT for column '${columnName}' in table '${tableName}'`
	);
}
