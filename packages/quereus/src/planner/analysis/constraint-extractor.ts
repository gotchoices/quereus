/**
 * Constraint extraction utilities for predicate analysis and pushdown optimization
 * Converts scalar expressions into constraints that can be pushed down to virtual tables
 */

import type { ScalarPlanNode, RelationalPlanNode, PlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';
import { BinaryOpNode, BetweenNode, CastNode, UnaryOpNode } from '../nodes/scalar.js';
import type { LiteralNode } from '../nodes/scalar.js';
import { InNode } from '../nodes/subquery.js';
import type { Row, SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type * as AST from '../../parser/ast.js';
import { getSyncLiteral } from '../../parser/utils.js';
import type { ConstraintOp, PredicateConstraint as VtabPredicateConstraint, RangeSpec as VtabRangeSpec } from '../../vtab/best-access-plan.js';
import { TableReferenceNode, ColumnReferenceNode as _ColumnRef } from '../nodes/reference.js';
import { CapabilityDetectors } from '../framework/characteristics.js';

const log = createLogger('planner:analysis:constraint-extractor');

// ConstraintOp is imported from vtab/best-access-plan.ts

/**
 * A single range specification within an OR_RANGE constraint.
 * Extends the vtab-level RangeSpec with planner-specific valueExpr fields.
 */
export interface RangeSpec extends VtabRangeSpec {
	lower?: { op: '>=' | '>'; value: SqlValue; valueExpr?: ScalarPlanNode };
	upper?: { op: '<=' | '<'; value: SqlValue; valueExpr?: ScalarPlanNode };
}

/**
 * A constraint extracted from a predicate expression
 * Extends the vtab PredicateConstraint with additional metadata for the planner
 */
export interface PredicateConstraint extends VtabPredicateConstraint {
	/** Attribute ID of the column reference */
	attributeId: number;
	/** Original expression node for debugging */
	sourceExpression: ScalarPlanNode;
	/** Target table relation (for multi-table predicates) */
	targetRelation?: string;
	/** Dynamic value expression for parameterized/correlated constraints (or IN lists) */
	valueExpr?: ScalarPlanNode | ScalarPlanNode[];
	/** Binding kind describing how value is supplied */
	bindingKind?: 'literal' | 'parameter' | 'correlated' | 'expression' | 'mixed';
	/** Range specifications for OR_RANGE constraints */
	ranges?: RangeSpec[];
}

/**
 * Result of constraint extraction
 */
export interface ConstraintExtractionResult {
	/** Extracted constraints grouped by target table relation */
	constraintsByTable: Map<string, PredicateConstraint[]>;
	/** Residual predicate that couldn't be converted to constraints */
	residualPredicate?: ScalarPlanNode;
	/** All constraints in a flat list */
	allConstraints: PredicateConstraint[];
  /** Predicate comprised only of supported fragments for a specific table (optional) */
  supportedPredicateByTable?: Map<string, ScalarPlanNode>;
  /** For each table, which unique key(s) are fully covered by equality constraints (by column indexes). Empty if none. */
  coveredKeysByTable?: Map<string, number[][]>;
}

/**
 * Table information for constraint mapping
 */
export interface TableInfo {
	relationName: string; // human-readable (e.g., schema.table)
	relationKey: string;  // instance-unique (e.g., schema.table#<nodeId>)
	attributes: Array<{ id: number; name: string }>;
	columnIndexMap: Map<number, number>; // attributeId -> columnIndex
  /** Logical unique keys for the relation, expressed as output column indexes */
  uniqueKeys?: number[][];
}

/**
 * Extract constraints from a scalar predicate expression
 * Handles binary comparisons, boolean logic (AND/OR), and complex expressions
 */
export function extractConstraints(
	predicate: ScalarPlanNode,
	tableInfos: TableInfo[] = []
): ConstraintExtractionResult {
	const constraintsByTable = new Map<string, PredicateConstraint[]>();
	const allConstraints: PredicateConstraint[] = [];
	const residualExpressions: ScalarPlanNode[] = [];

	log('Extracting constraints from predicate: %s', predicate.toString());

	// Build attribute-to-table mapping for quick lookups
	const tableByAttribute = new Map<number, TableInfo>();
	for (const tableInfo of tableInfos) {
		for (const attr of tableInfo.attributes) {
			tableByAttribute.set(attr.id, tableInfo);
		}
	}

  // Start extraction process & build supported fragments per table
  const perTableParts = new Map<string, ScalarPlanNode[]>();
  extractFromExpression(predicate, allConstraints, residualExpressions, tableByAttribute, perTableParts);

	// Group constraints by table instance key
	for (const constraint of allConstraints) {
		if (constraint.targetRelation) {
			if (!constraintsByTable.has(constraint.targetRelation)) {
				constraintsByTable.set(constraint.targetRelation, []);
			}
			constraintsByTable.get(constraint.targetRelation)!.push(constraint);
		}
	}

	// Build residual predicate from unmatched expressions (combine with AND)
	let residualPredicate: ScalarPlanNode | undefined;
	if (residualExpressions.length === 1) {
		residualPredicate = residualExpressions[0];
	} else if (residualExpressions.length > 1) {
		let acc = residualExpressions[0];
		for (let i = 1; i < residualExpressions.length; i++) {
			const right = residualExpressions[i];
			const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
			acc = new BinaryOpNode(acc.scope, ast, acc, right);
		}
		residualPredicate = acc;
	}

	log('Extracted %d constraints across %d tables, %d residual expressions',
		allConstraints.length, constraintsByTable.size, residualExpressions.length);

  const supportedPredicateByTable = new Map<string, ScalarPlanNode>();
  for (const [rel, parts] of perTableParts) {
    const combined = combineParts(parts);
    if (combined) supportedPredicateByTable.set(rel, combined);
  }

  // Compute covered keys per table: collect equality constraints and check against table unique keys
  const coveredKeysByTable = new Map<string, number[][]>();
  for (const [rel, constraints] of constraintsByTable) {
    const tInfo = tableInfos.find(t => t.relationKey === rel || t.relationName === rel);
    if (!tInfo || !tInfo.uniqueKeys || tInfo.uniqueKeys.length === 0) {
      coveredKeysByTable.set(rel, []);
      continue;
    }
    const eqCols = new Set<number>();
    for (const c of constraints) {
      if (c.op === '=') {
        eqCols.add(c.columnIndex);
      }
      // Single-value IN could be treated as equality
      if (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length === 1) {
        eqCols.add(c.columnIndex);
      }
    }
    const covered: number[][] = [];
    for (const key of tInfo.uniqueKeys) {
      if (key.length === 0) {
        // Zero-length key means at most one row; trivially covered
        covered.push([]);
        continue;
      }
      const allCovered = key.every(idx => eqCols.has(idx));
      if (allCovered) covered.push([...key]);
    }
    coveredKeysByTable.set(rel, covered);
  }

  return {
		constraintsByTable,
		residualPredicate,
    allConstraints,
    supportedPredicateByTable,
    coveredKeysByTable
	};
}

/**
 * Recursively extract constraints from an expression
 */
function extractFromExpression(
	expr: ScalarPlanNode,
	constraints: PredicateConstraint[],
	residual: ScalarPlanNode[],
  attributeToTableMap: Map<number, TableInfo>,
  perTableParts: Map<string, ScalarPlanNode[]>
): void {
	// Handle AND expressions - recurse on both sides
	if (isAndExpression(expr)) {
		const binaryOp = expr as BinaryOpNode;
    extractFromExpression(binaryOp.left, constraints, residual, attributeToTableMap, perTableParts);
    extractFromExpression(binaryOp.right, constraints, residual, attributeToTableMap, perTableParts);
		return;
	}

	// Handle OR expressions: try to extract as IN or OR constraint group
	if (isOrExpression(expr)) {
		const orResult = tryExtractOrBranches(expr, attributeToTableMap);
		if (orResult) {
			for (const c of orResult.constraints) {
				constraints.push(c);
			}
			addSupportedPart(expr, attributeToTableMap, perTableParts);
			log('OR expression extracted %d constraints', orResult.constraints.length);
			return;
		}
		log('OR expression not extractable, treating as residual');
		residual.push(expr);
		return;
	}

  // BETWEEN → range constraints
  if (expr.nodeType === PlanNodeType.Between) {
    const c = extractBetweenConstraints(expr as BetweenNode, attributeToTableMap);
    if (c) {
      constraints.push(...c);
      addSupportedPart(expr, attributeToTableMap, perTableParts);
      return;
    }
  }

  // IN list → IN constraint (literals only)
  if (expr.nodeType === PlanNodeType.In) {
    const c = extractInConstraint(expr as InNode, attributeToTableMap);
    if (c) {
      constraints.push(c);
      addSupportedPart(expr, attributeToTableMap, perTableParts);
      return;
    }
  }

  // IS NULL / IS NOT NULL → unary constraint
  if (expr.nodeType === PlanNodeType.UnaryOp) {
    const unaryOp = expr as UnaryOpNode;
    if (unaryOp.expression.operator === 'IS NULL' || unaryOp.expression.operator === 'IS NOT NULL') {
      const c = extractNullConstraint(unaryOp, attributeToTableMap);
      if (c) {
        constraints.push(c);
        addSupportedPart(expr, attributeToTableMap, perTableParts);
        return;
      }
    }
  }

  // Try to extract constraint from binary comparison
  const constraint = extractBinaryConstraint(expr, attributeToTableMap);
	if (constraint) {
		constraints.push(constraint);
    addSupportedPart(expr, attributeToTableMap, perTableParts);
		log('Extracted constraint: %s %s %s (table: %s)',
			constraint.attributeId, constraint.op, constraint.value, constraint.targetRelation);
	} else {
		// Cannot convert to constraint - add to residual
		log('Cannot extract constraint from expression, adding to residual: %s', expr.toString());
		residual.push(expr);
	}
}

function addSupportedPart(expr: ScalarPlanNode, attributeToTableMap: Map<number, TableInfo>, perTableParts: Map<string, ScalarPlanNode[]>): void {
  // Determine target table by first column reference in expr; if absent, skip
  const relKey = findTargetRelationKey(expr, attributeToTableMap);
  if (!relKey) return;
  if (!perTableParts.has(relKey)) perTableParts.set(relKey, []);
  perTableParts.get(relKey)!.push(expr);
}

function findTargetRelationKey(expr: ScalarPlanNode, attributeToTableMap: Map<number, TableInfo>): string | undefined {
  const stack: ScalarPlanNode[] = [expr];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === PlanNodeType.ColumnReference) {
      const attrId = (n as unknown as _ColumnRef).attributeId;
      const info = attributeToTableMap.get(attrId);
      if (info) return info.relationKey ?? info.relationName;
    }
    for (const c of n.getChildren()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stack.push(c as any);
    }
  }
  return undefined;
}

function combineParts(parts: ScalarPlanNode[]): ScalarPlanNode | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  // Combine with AND
  let acc = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const right = parts[i];
    const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
    acc = new BinaryOpNode(acc.scope, ast, acc, right);
  }
  return acc;
}

/**
 * Extract constraint from binary comparison expression
 */
function extractBinaryConstraint(
	expr: ScalarPlanNode,
	attributeToTableMap: Map<number, TableInfo>
): PredicateConstraint | null {
	// Must be a binary operation
	if (expr.nodeType !== PlanNodeType.BinaryOp) {
		return null;
	}

	const binaryOp = expr as BinaryOpNode;
	const { left, right } = binaryOp;
  const operator = binaryOp.expression.operator;

	// Try column-constant pattern (column op constant)
	let columnRef: ColumnReferenceNode | null = null;
	let constant: SqlValue | undefined;
  let finalOp: ConstraintOp | null = null;
  let columnIsLeft = false;

  if (isColumnReference(left) && (isLiteralConstant(right) || isDynamicValue(right))) {
		columnRef = getColumnReference(left);
		columnIsLeft = true;
		if (isLiteralConstant(right)) {
			constant = getLiteralValue(right);
		}
    finalOp = mapOperatorToConstraint(operator, constant);
  } else if ((isLiteralConstant(left) || isDynamicValue(left)) && isColumnReference(right)) {
		// Reverse pattern (constant op column) - flip operator
		columnRef = getColumnReference(right);
		if (isLiteralConstant(left)) {
			constant = getLiteralValue(left);
		}
    const baseOp = mapOperatorToConstraint(operator, constant);
    finalOp = baseOp ? flipOperator(baseOp) : null;
	}

  if (!columnRef || !finalOp) {
		log('No column-constant pattern found in binary expression');
		return null;
	}

	// Map attribute ID to table and column index
	const tableInfo = attributeToTableMap.get(columnRef.attributeId);
	if (!tableInfo) {
		log('No table mapping found for attribute ID %d', columnRef.attributeId);
		return null;
	}

	const columnIndex = tableInfo.columnIndexMap.get(columnRef.attributeId);
	if (columnIndex === undefined) {
		log('No column index found for attribute ID %d', columnRef.attributeId);
		return null;
	}

  const result: PredicateConstraint = {
		columnIndex,
		attributeId: columnRef.attributeId,
		op: finalOp,
		value: constant,
		usable: true, // Usable since we found table mapping
		sourceExpression: expr,
		targetRelation: tableInfo.relationKey
  };

  // Attach dynamic binding metadata when RHS/LHS is not a literal
  const rhs = (expr as BinaryOpNode).right;
  const lhs = (expr as BinaryOpNode).left;
  const nonLiteral = !isLiteralConstant(lhs) || !isLiteralConstant(rhs);
  if (nonLiteral) {
    // Determine which side is the value side
    const valueSide = (columnIsLeft ? rhs : lhs) as ScalarPlanNode;
    if (!isLiteralConstant(valueSide)) {
      result.valueExpr = valueSide;
      const innerValue = unwrapCast(valueSide);
      if (innerValue.nodeType === PlanNodeType.ParameterReference) {
        result.bindingKind = 'parameter';
      } else if (innerValue.nodeType === PlanNodeType.ColumnReference) {
        const rhsAttrId = (innerValue as unknown as ColumnReferenceNode).attributeId;
        const sameTable = tableInfo.columnIndexMap.has(rhsAttrId);
        result.bindingKind = sameTable ? 'expression' : 'correlated';
      } else {
        result.bindingKind = 'expression';
      }
    } else {
      result.bindingKind = 'literal';
    }
  } else {
    result.bindingKind = 'literal';
  }

  return result;
}

function extractBetweenConstraints(
  expr: BetweenNode,
  attributeToTableMap: Map<number, TableInfo>
): PredicateConstraint[] | null {
  // Only support column BETWEEN literal AND literal
  const col = expr.expr;
  const low = expr.lower;
  const up = expr.upper;
  const not = !!expr.expression.not;

  if (!isColumnReference(col)) return null;
  if (!isLiteralConstant(low) || !isLiteralConstant(up)) return null;

  const columnRef = getColumnReference(col);
  const tableInfo = attributeToTableMap.get(columnRef.attributeId);
  if (!tableInfo) return null;
  const columnIndex = tableInfo.columnIndexMap.get(columnRef.attributeId);
  if (columnIndex === undefined) return null;

  if (not) {
    // NOT BETWEEN not expressible as single contiguous range; leave as residual
    return null;
  }

  const lowVal = getLiteralValue(low);
  const upVal = getLiteralValue(up);
  return [
    {
      columnIndex,
      attributeId: columnRef.attributeId,
      op: '>=',
      value: lowVal,
      usable: true,
      sourceExpression: expr,
      targetRelation: tableInfo.relationKey
    },
    {
      columnIndex,
      attributeId: columnRef.attributeId,
      op: '<=',
      value: upVal,
      usable: true,
      sourceExpression: expr,
      targetRelation: tableInfo.relationKey
    }
  ];
}

function extractInConstraint(
  expr: InNode,
  attributeToTableMap: Map<number, TableInfo>
): PredicateConstraint | null {
  // Only support column IN (value-list), not subqueries
  if (expr.source) return null;
  if (!expr.values || expr.values.length === 0) return null;
  const col = expr.condition;
  if (col.nodeType !== PlanNodeType.ColumnReference) return null;

  const columnRef = col as unknown as ColumnReferenceNode;
  const tableInfo = attributeToTableMap.get(columnRef.attributeId);
  if (!tableInfo) return null;
  const columnIndex = tableInfo.columnIndexMap.get(columnRef.attributeId);
  if (columnIndex === undefined) return null;

  // Check if all values are literals, or if some are dynamic (parameters/expressions)
  const allLiteral = expr.values.every(v => isLiteralConstant(v));
  const allUsable = expr.values.every(v => isLiteralConstant(v) || isDynamicValue(v));
  if (!allUsable) return null;

  const values = allLiteral
    ? expr.values.map(v => getLiteralValue(v))
    : expr.values.map(v => isLiteralConstant(v) ? getLiteralValue(v) : undefined);

  const result: PredicateConstraint = {
    columnIndex,
    attributeId: columnRef.attributeId,
    op: 'IN',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: values as any,
    usable: true,
    sourceExpression: expr,
    targetRelation: tableInfo.relationKey
  };

  // Attach dynamic binding metadata when not all values are literals
  if (!allLiteral) {
    result.valueExpr = expr.values as ScalarPlanNode[];
    result.bindingKind = 'mixed';
  }

  return result;
}

/**
 * Extract constraint from IS NULL / IS NOT NULL unary expression
 */
function extractNullConstraint(
	expr: UnaryOpNode,
	attributeToTableMap: Map<number, TableInfo>
): PredicateConstraint | null {
	const operand = expr.operand;
	if (!isColumnReference(operand)) return null;

	const columnRef = getColumnReference(operand);
	const tableInfo = attributeToTableMap.get(columnRef.attributeId);
	if (!tableInfo) return null;

	const columnIndex = tableInfo.columnIndexMap.get(columnRef.attributeId);
	if (columnIndex === undefined) return null;

	const op = expr.expression.operator as 'IS NULL' | 'IS NOT NULL';
	return {
		columnIndex,
		attributeId: columnRef.attributeId,
		op,
		value: undefined,
		usable: true,
		sourceExpression: expr,
		targetRelation: tableInfo.relationKey,
		bindingKind: 'literal'
	};
}

/**
 * Map AST operators to constraint operators
 */
function mapOperatorToConstraint(operator: string, _rightValue?: SqlValue): ConstraintOp | null {
  switch (operator) {
    case '=': return '=';
    case '>': return '>';
    case '>=': return '>=';
    case '<': return '<';
    case '<=': return '<=';
    case 'LIKE': return 'LIKE';
    case 'GLOB': return 'GLOB';
    case 'MATCH': return 'MATCH';
    case 'IN': return 'IN';
    case 'NOT IN': return 'NOT IN';
    default: return null;
  }
}

/**
 * Flatten an OR expression tree into a list of disjuncts.
 */
function flattenOrDisjuncts(expr: ScalarPlanNode): ScalarPlanNode[] {
	const result: ScalarPlanNode[] = [];
	const stack: ScalarPlanNode[] = [expr];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (isOrExpression(node)) {
			const binary = node as BinaryOpNode;
			stack.push(binary.right, binary.left);
		} else {
			result.push(node);
		}
	}
	return result;
}

/**
 * Attempt to extract index-friendly constraints from an OR expression.
 *
 * Handles two cases:
 * 1. All branches are equality on the same column → collapse to IN constraint
 * 2. All branches target the same table with extractable constraints → OR constraint group
 *
 * Returns null if the OR cannot be extracted (remains residual).
 */
function tryExtractOrBranches(
	expr: ScalarPlanNode,
	attributeToTableMap: Map<number, TableInfo>
): { constraints: PredicateConstraint[] } | null {
	const disjuncts = flattenOrDisjuncts(expr);
	if (disjuncts.length < 2) return null;

	// Extract constraints from each branch independently
	const branches: { constraints: PredicateConstraint[]; hasResidual: boolean }[] = [];
	for (const d of disjuncts) {
		const branchConstraints: PredicateConstraint[] = [];
		const branchResidual: ScalarPlanNode[] = [];
		const branchParts = new Map<string, ScalarPlanNode[]>();
		extractFromExpression(d, branchConstraints, branchResidual, attributeToTableMap, branchParts);
		branches.push({
			constraints: branchConstraints,
			hasResidual: branchResidual.length > 0
		});
	}

	// If any branch has residual (not fully extractable), the entire OR must be residual.
	// We can't partially push down an OR — all branches must be handled.
	if (branches.some(b => b.hasResidual || b.constraints.length === 0)) {
		return null;
	}

	// Check if all branches target the same table
	const allRelations = new Set<string>();
	for (const b of branches) {
		for (const c of b.constraints) {
			if (c.targetRelation) allRelations.add(c.targetRelation);
		}
	}
	if (allRelations.size !== 1) return null;

	// Case 1: All branches are single equality or IN on the same column → collapse to IN
	const allEqOrIn = branches.every(b =>
		b.constraints.length === 1 &&
		(b.constraints[0].op === '=' || b.constraints[0].op === 'IN')
	);
	if (allEqOrIn) {
		const firstConstraint = branches[0].constraints[0];
		const sameColumn = branches.every(b =>
			b.constraints[0].columnIndex === firstConstraint.columnIndex &&
			b.constraints[0].attributeId === firstConstraint.attributeId
		);
		if (sameColumn) {
			return collapseBranchesToIn(branches, firstConstraint, expr);
		}
	}

	// Case 2: All branches are range (or equality) on the same column → OR_RANGE
	const orRangeResult = tryCollapseToOrRange(branches, expr);
	if (orRangeResult) return orRangeResult;

	return null;
}

/**
 * Collapse OR branches (equality and/or IN) on the same column into a single IN constraint.
 * Handles mixed equality + IN branches (e.g., from nested OR normalization)
 * and both literal and non-literal (parameter, expression) values.
 */
function collapseBranchesToIn(
	branches: { constraints: PredicateConstraint[] }[],
	template: PredicateConstraint,
	sourceExpr: ScalarPlanNode
): { constraints: PredicateConstraint[] } {
	const values: SqlValue[] = [];
	const valueExprs: ScalarPlanNode[] = [];
	let hasNonLiteral = false;

	for (const b of branches) {
		const c = b.constraints[0];
		if (c.op === 'IN' && Array.isArray(c.value)) {
			// IN branch: merge all its values
			for (const v of c.value as SqlValue[]) {
				values.push(v);
			}
			if (Array.isArray(c.valueExpr)) {
				for (const ve of c.valueExpr as ScalarPlanNode[]) {
					valueExprs.push(ve);
				}
				hasNonLiteral = true;
			} else {
				// All literal IN — push placeholder source expressions
				for (const _v of c.value as SqlValue[]) {
					valueExprs.push(c.sourceExpression);
				}
			}
		} else {
			// Equality branch: single value
			values.push(c.value as SqlValue);
			if (c.valueExpr && !Array.isArray(c.valueExpr)) {
				valueExprs.push(c.valueExpr as ScalarPlanNode);
				hasNonLiteral = true;
			} else {
				valueExprs.push(c.sourceExpression);
			}
		}
	}

	const result: PredicateConstraint = {
		columnIndex: template.columnIndex,
		attributeId: template.attributeId,
		op: 'IN',
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		value: values as any,
		usable: true,
		sourceExpression: sourceExpr,
		targetRelation: template.targetRelation,
		valueExpr: hasNonLiteral ? valueExprs : undefined,
		bindingKind: hasNonLiteral ? 'mixed' : 'literal'
	};
	return { constraints: [result] };
}

/**
 * Collapse OR branches that are all range/equality constraints on the same column
 * into a single OR_RANGE constraint with multiple range specs.
 */
function tryCollapseToOrRange(
	branches: { constraints: PredicateConstraint[] }[],
	sourceExpr: ScalarPlanNode
): { constraints: PredicateConstraint[] } | null {
	// All branches must have constraints on a single column (possibly multiple for BETWEEN-style ranges)
	let targetColumnIndex: number | undefined;
	let targetAttributeId: number | undefined;
	let targetRelation: string | undefined;

	const rangeSpecs: RangeSpec[] = [];

	for (const b of branches) {
		// A branch may have 1 constraint (single bound or equality) or 2 constraints (lower + upper on same col)
		if (b.constraints.length === 0 || b.constraints.length > 2) return null;

		// All constraints in this branch must target the same column
		const firstCol = b.constraints[0].columnIndex;
		const firstAttr = b.constraints[0].attributeId;
		const firstRel = b.constraints[0].targetRelation;
		if (!b.constraints.every(c => c.columnIndex === firstCol)) return null;

		// Initialize target or verify consistency across branches
		if (targetColumnIndex === undefined) {
			targetColumnIndex = firstCol;
			targetAttributeId = firstAttr;
			targetRelation = firstRel;
		} else if (targetColumnIndex !== firstCol || targetAttributeId !== firstAttr) {
			return null;
		}

		// Build range spec from branch constraints
		const spec: RangeSpec = {};
		for (const c of b.constraints) {
			const dynExpr = c.valueExpr && !Array.isArray(c.valueExpr) ? c.valueExpr : undefined;
			if (c.op === '=') {
				// Equality: treat as >= v AND <= v
				spec.lower = { op: '>=', value: c.value as SqlValue, valueExpr: dynExpr };
				spec.upper = { op: '<=', value: c.value as SqlValue, valueExpr: dynExpr };
			} else if (c.op === '>' || c.op === '>=') {
				spec.lower = { op: c.op, value: c.value as SqlValue, valueExpr: dynExpr };
			} else if (c.op === '<' || c.op === '<=') {
				spec.upper = { op: c.op, value: c.value as SqlValue, valueExpr: dynExpr };
			} else {
				// Non-range, non-equality op → can't collapse
				return null;
			}
		}

		// Each branch must define at least one bound
		if (!spec.lower && !spec.upper) return null;

		rangeSpecs.push(spec);
	}

	if (targetColumnIndex === undefined || targetAttributeId === undefined || rangeSpecs.length < 2) {
		return null;
	}

	const result: PredicateConstraint = {
		columnIndex: targetColumnIndex,
		attributeId: targetAttributeId,
		op: 'OR_RANGE',
		value: undefined,
		usable: true,
		sourceExpression: sourceExpr,
		targetRelation: targetRelation,
		bindingKind: 'literal',
		ranges: rangeSpecs,
	};

	return { constraints: [result] };
}

/**
 * Check if expression is an AND operation
 */
function isAndExpression(expr: ScalarPlanNode): boolean {
	return expr.nodeType === PlanNodeType.BinaryOp &&
		   (expr as BinaryOpNode).expression.operator === 'AND';
}

/**
 * Check if expression is an OR operation
 */
function isOrExpression(expr: ScalarPlanNode): boolean {
	return expr.nodeType === PlanNodeType.BinaryOp &&
		   (expr as BinaryOpNode).expression.operator === 'OR';
}

/**
 * Check if node is a column reference
 */
/**
 * Unwrap a CastNode inserted by the planner for cross-category coercion.
 * Returns the inner operand if node is a Cast, otherwise returns the node itself.
 */
function unwrapCast(node: ScalarPlanNode): ScalarPlanNode {
	return node.nodeType === PlanNodeType.Cast ? (node as CastNode).operand : node;
}

function isColumnReference(node: ScalarPlanNode): node is ColumnReferenceNode {
	return CapabilityDetectors.isColumnReference(unwrapCast(node));
}

/**
 * Extract the underlying ColumnReferenceNode, unwrapping a planner-inserted
 * CastNode if present.
 */
function getColumnReference(node: ScalarPlanNode): ColumnReferenceNode {
	return unwrapCast(node) as unknown as ColumnReferenceNode;
}

/**
 * Check if node is a literal constant (sees through planner-inserted CastNodes).
 */
function isLiteralConstant(node: ScalarPlanNode): node is LiteralNode {
	return unwrapCast(node).nodeType === PlanNodeType.Literal;
}

function isDynamicValue(node: ScalarPlanNode): boolean {
  const inner = unwrapCast(node);
  // Parameter or column reference from any table (correlation handled later)
  return inner.nodeType === PlanNodeType.ParameterReference || inner.nodeType === PlanNodeType.ColumnReference;
}

/**
 * Get literal value from literal node (sees through planner-inserted CastNodes).
 */
function getLiteralValue(node: ScalarPlanNode): SqlValue {
	const literalNode = unwrapCast(node) as LiteralNode;
	return getSyncLiteral(literalNode.expression);
}

/**
 * Flip comparison operator for reversed operand order
 */
function flipOperator(op: ConstraintOp): ConstraintOp {
	switch (op) {
		case '<': return '>';
		case '<=': return '>=';
		case '>': return '<';
		case '>=': return '<=';
		case '=': return '=';
		case 'LIKE': return 'LIKE'; // Not flippable
		case 'GLOB': return 'GLOB'; // Not flippable
		case 'MATCH': return 'MATCH'; // Not flippable
		case 'IN': return 'IN'; // Not flippable in this context
		case 'NOT IN': return 'NOT IN'; // Not flippable in this context
		default: return op;
	}
}

/**
 * Extract constraints for a specific table from a relational plan
 * Analyzes all Filter nodes and join conditions that reference the table
 */
export function extractConstraintsForTable(
	plan: RelationalPlanNode,
	targetTableRelationKey: string
): PredicateConstraint[] {
	const constraints: PredicateConstraint[] = [];

	// Walk the plan tree looking for filter predicates
	walkPlanForPredicates(plan, (predicate, sourceNode) => {
		// Create table info for the target table only
		const tableInfos = createTableInfosFromPlan(plan).filter(
			info => info.relationKey === targetTableRelationKey
		);

		if (tableInfos.length > 0) {
			const result = extractConstraints(predicate, tableInfos);
			const tableConstraints = result.constraintsByTable.get(targetTableRelationKey);
			if (tableConstraints) {
				constraints.push(...tableConstraints);
				log('Found %d constraints for table %s from %s',
					tableConstraints.length, targetTableRelationKey, sourceNode);
			}
		}
	});

	return constraints;
}

/**
 * Extract constraints and combined residual predicate for a specific table
 */
export function extractConstraintsAndResidualForTable(
    plan: RelationalPlanNode,
    targetTableRelationKey: string
): { constraints: PredicateConstraint[]; residualPredicate?: ScalarPlanNode } {
    const constraints: PredicateConstraint[] = [];
    const residuals: ScalarPlanNode[] = [];

    walkPlanForPredicates(plan, (predicate) => {
        const tableInfos = createTableInfosFromPlan(plan).filter(
            info => info.relationKey === targetTableRelationKey
        );
        if (tableInfos.length === 0) return;
        const result = extractConstraints(predicate, tableInfos);
        const tableConstraints = result.constraintsByTable.get(targetTableRelationKey);
        if (tableConstraints && tableConstraints.length) {
            constraints.push(...tableConstraints);
        }
        if (result.residualPredicate) {
            residuals.push(result.residualPredicate);
        }
    });

    return { constraints, residualPredicate: combineResiduals(residuals) };
}

/**
 * Compute which unique keys are fully covered by equality constraints for a table within a plan.
 * Returns a list of covered keys (each key is a list of column indexes in the table output order).
 */
export function extractCoveredKeysForTable(
    plan: RelationalPlanNode,
    targetTableRelationKey: string
): number[][] {
    const constraints: PredicateConstraint[] = extractConstraintsForTable(plan, targetTableRelationKey);
    const tInfos = createTableInfosFromPlan(plan).filter(info => info.relationKey === targetTableRelationKey);
    if (tInfos.length === 0) return [];
    const uniqueKeys = tInfos[0].uniqueKeys ?? [];
    return computeCoveredKeysForConstraints(constraints, uniqueKeys);
}

/**
 * Given a set of constraints and a table's unique keys, compute which keys are fully covered by equality.
 */
export function computeCoveredKeysForConstraints(
    constraints: readonly PredicateConstraint[],
    tableUniqueKeys: readonly number[][]
): number[][] {
    const eqCols = new Set<number>();
    for (const c of constraints) {
        if (c.op === '=') {
            eqCols.add(c.columnIndex);
        }
        if (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length === 1) {
            eqCols.add(c.columnIndex);
        }
    }
    const covered: number[][] = [];
    for (const key of tableUniqueKeys) {
        if (key.length === 0) {
            covered.push([]);
            continue;
        }
        const allCovered = key.every(idx => eqCols.has(idx));
        if (allCovered) covered.push([...key]);
    }
    return covered;
}

/**
 * Analyze plan to classify each TableReference instance as 'row' (row-specific) or 'global'.
 * Row-specific means equality constraints fully cover at least one unique key at that reference,
 * AND no identity-breaking node (aggregate without PK grouping, set operation, window) sits above it.
 */
export function analyzeRowSpecific(
    plan: RelationalPlanNode | PlanNode
): Map<string, 'row' | 'global'> {
    const result = new Map<string, 'row' | 'global'>();
    const infos = createTableInfosFromPlan(plan as RelationalPlanNode);
    for (const info of infos) {
        const covered = extractCoveredKeysForTable(plan as RelationalPlanNode, info.relationKey);
        result.set(info.relationKey, covered.length > 0 ? 'row' : 'global');
    }

    // Post-process: demote 'row' to 'global' for table references beneath identity-breaking nodes
    demoteForIdentityBreakingNodes(plan as unknown as PlanNode, result, infos);

    return result;
}

/**
 * Walk the plan tree and demote table reference classifications to 'global' when they
 * appear beneath identity-breaking nodes:
 * - AggregateNode: unless GROUP BY exactly covers a unique key of the table
 * - SetOperationNode: always demotes (conservative)
 * - WindowNode: always demotes (conservative)
 */
function demoteForIdentityBreakingNodes(
    node: PlanNode,
    classifications: Map<string, 'row' | 'global'>,
    tableInfos: TableInfo[]
): void {
    if (!node) return;

    const nodeType = node.nodeType;

    // SetOperation: demote all table references beneath to 'global'
    if (nodeType === PlanNodeType.SetOperation) {
        demoteAllBeneath(node, classifications);
        return; // No need to recurse further — everything below is already demoted
    }

    // Window: demote all table references beneath to 'global'
    if (nodeType === PlanNodeType.Window) {
        demoteAllBeneath(node, classifications);
        return;
    }

    // Aggregate: check if GROUP BY covers a unique key per table reference beneath
    if (nodeType === PlanNodeType.Aggregate) {
        demoteForAggregate(node, classifications, tableInfos);
        return; // Already recurses into source
    }

    // Recurse into children
    for (const child of node.getChildren()) {
        demoteForIdentityBreakingNodes(child as unknown as PlanNode, classifications, tableInfos);
    }
}

/** Collect all TableReference relationKeys beneath a node */
function collectRelationKeysBeneath(node: PlanNode): Set<string> {
    const keys = new Set<string>();
    function walk(n: PlanNode): void {
        if (n instanceof TableReferenceNode) {
            const schema = n.tableSchema;
            const baseName = `${schema.schemaName}.${schema.name}`.toLowerCase();
            keys.add(`${baseName}#${n.id ?? 'unknown'}`);
        }
        for (const child of n.getChildren()) {
            walk(child as unknown as PlanNode);
        }
    }
    walk(node);
    return keys;
}

/** Demote all table references beneath a node to 'global' */
function demoteAllBeneath(node: PlanNode, classifications: Map<string, 'row' | 'global'>): void {
    const keys = collectRelationKeysBeneath(node);
    for (const key of keys) {
        if (classifications.has(key)) {
            classifications.set(key, 'global');
        }
    }
}

/**
 * For an AggregateNode, check if GROUP BY columns cover a unique key of each table reference
 * beneath the aggregate's source. If not, demote that table reference to 'global'.
 */
function demoteForAggregate(
    node: PlanNode,
    classifications: Map<string, 'row' | 'global'>,
    tableInfos: TableInfo[]
): void {
    const aggNode = node as unknown as { source: RelationalPlanNode; groupBy: readonly ScalarPlanNode[] };
    if (!aggNode.groupBy || !aggNode.source) return;

    // Collect attribute IDs from GROUP BY expressions (only ColumnReference expressions count)
    const groupByAttrIds = new Set<number>();
    for (const expr of aggNode.groupBy) {
        if (expr.nodeType === PlanNodeType.ColumnReference) {
            groupByAttrIds.add((expr as unknown as _ColumnRef).attributeId);
        }
    }

    // Check each table reference beneath the aggregate's source
    const keysBelow = collectRelationKeysBeneath(aggNode.source as unknown as PlanNode);
    for (const relKey of keysBelow) {
        if (classifications.get(relKey) !== 'row') continue; // Already global

        // Find this table's unique keys
        const tInfo = tableInfos.find(t => t.relationKey === relKey);
        if (!tInfo || !tInfo.uniqueKeys || tInfo.uniqueKeys.length === 0) {
            classifications.set(relKey, 'global');
            continue;
        }

        // Check if any unique key is fully covered by GROUP BY attribute IDs
        const attrIdsByColIndex = new Map<number, number>();
        for (const attr of tInfo.attributes) {
            const colIdx = tInfo.columnIndexMap.get(attr.id);
            if (colIdx !== undefined) {
                attrIdsByColIndex.set(colIdx, attr.id);
            }
        }

        let anyCovered = false;
        for (const key of tInfo.uniqueKeys) {
            if (key.length === 0) { anyCovered = true; break; }
            const allCovered = key.every(colIdx => {
                const attrId = attrIdsByColIndex.get(colIdx);
                return attrId !== undefined && groupByAttrIds.has(attrId);
            });
            if (allCovered) { anyCovered = true; break; }
        }

        if (!anyCovered) {
            classifications.set(relKey, 'global');
        }
    }

    // Recurse into the aggregate's source for further nested identity-breaking nodes
    demoteForIdentityBreakingNodes(aggNode.source as unknown as PlanNode, classifications, tableInfos);
}

function combineResiduals(predicates: ScalarPlanNode[]): ScalarPlanNode | undefined {
    if (predicates.length === 0) return undefined;
    if (predicates.length === 1) return predicates[0];
    let acc = predicates[0];
    for (let i = 1; i < predicates.length; i++) {
        const right = predicates[i];
        const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
        acc = new BinaryOpNode(acc.scope, ast, acc, right);
    }
    return acc;
}

/**
 * Walk a plan tree and call callback for each predicate found
 */
function walkPlanForPredicates(
  plan: PlanNode,
  callback: (predicate: ScalarPlanNode, sourceNode: string) => void
): void {
  if (!plan) return;
  // If node exposes predicates via characteristic, collect them
  if (CapabilityDetectors.isPredicateSource(plan)) {
    const preds = plan.getPredicates() as ReadonlyArray<ScalarPlanNode>;
    for (const p of preds) {
      callback(p, 'PredicateSource');
    }
  }

  // Recurse into all children (scalar and relational)
  for (const child of plan.getChildren()) {
    walkPlanForPredicates(child as unknown as PlanNode, callback);
  }
}

/**
 * Create table information from a relational plan
 */
function createTableInfosFromPlan(plan: RelationalPlanNode | PlanNode): TableInfo[] {
  const tableInfos: TableInfo[] = [];

  const seen = new Set<string>();

  function visitAny(node: PlanNode): void {
    const id = node.id ?? null;
    if (id !== null) {
      const k = String(id);
      if (seen.has(k)) return;
      seen.add(k);
    }

    if (node instanceof TableReferenceNode) {
      const tr = node as unknown as { tableSchema: { schemaName: string; name: string } };
      tableInfos.push(createTableInfoFromNode(node as unknown as RelationalPlanNode, `${tr.tableSchema.schemaName}.${tr.tableSchema.name}`));
    }

    for (const rel of node.getRelations()) {
      visitAny(rel as unknown as PlanNode);
    }

    for (const child of node.getChildren()) {
      visitAny(child as unknown as PlanNode);
    }
  }

  visitAny(plan as unknown as PlanNode);
  return tableInfos;
}

/**
 * Utility to create table info from a table reference node
 */
export function createTableInfoFromNode(node: RelationalPlanNode, relationName?: string): TableInfo {
	const attributes = node.getAttributes();
	const columnIndexMap = new Map<number, number>();

	// Map attribute IDs to column indices
	attributes.forEach((attr, index) => {
		columnIndexMap.set(attr.id, index);
	});

	// Extract logical unique keys from relation type, map ColRef[] to plain column indexes
	const relType = (node as unknown as { getType: () => { keys: { index: number }[][] } }).getType();
	const uniqueKeys: number[][] | undefined = Array.isArray(relType?.keys)
		? relType.keys.map(key => key.map(ref => ref.index))
		: undefined;

	const relName = relationName || node.toString();
	const relationKey = `${relName}#${node.id ?? 'unknown'}`;

	return {
		relationName: relName,
		relationKey,
		attributes: attributes.map(attr => ({ id: attr.id, name: attr.name })),
		columnIndexMap,
		uniqueKeys
	};
}

/**
 * Create a residual filter predicate from constraints that weren't handled
 * This allows creating a filter function that can be applied at runtime
 */
export function createResidualFilter(
	originalPredicate: ScalarPlanNode,
	handledConstraints: PredicateConstraint[]
): ((row: Row) => boolean) | undefined {
	// If no constraints were handled, return undefined (original predicate still needed)
	if (handledConstraints.length === 0) {
		return undefined;
	}

	// TODO: Implement sophisticated residual filter construction
	// This would need to:
	// 1. Identify which parts of the original predicate were handled
	// 2. Construct a new predicate with only the unhandled parts
	// 3. Compile that predicate to a runtime function

	log('Residual filter construction not yet implemented - using original predicate');
	return undefined;
}
