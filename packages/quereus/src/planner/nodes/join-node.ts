import { isRelationalNode, PlanNode } from './plan-node.js';
import type { RelationalPlanNode, Attribute, BinaryRelationalNode, ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import { JoinCapable, type PredicateSourceCapable } from '../framework/characteristics.js';
import { normalizePredicate } from '../analysis/predicate-normalizer.js';
import { combineJoinKeys, analyzeJoinKeyCoverage } from '../util/key-utils.js';
import { BinaryOpNode } from './scalar.js';
import { ColumnReferenceNode } from './reference.js';
import { buildJoinAttributes, buildJoinRelationType, estimateJoinRows, propagateJoinMonotonicOn, propagateJoinFds } from './join-utils.js';

export type JoinType = 'inner' | 'left' | 'right' | 'full' | 'cross' | 'semi' | 'anti';

/**
 * Extract equi-join column index pairs from a join condition (AND-of-equalities).
 * Returns pairs of {left, right} column indices.
 */
export function extractEquiPairsFromCondition(
	condition: ScalarPlanNode | undefined,
	leftAttrs: readonly Attribute[],
	rightAttrs: readonly Attribute[],
): Array<{ left: number; right: number }> {
	const pairs: Array<{ left: number; right: number }> = [];
	const cond = condition ? normalizePredicate(condition) : undefined;
	if (!cond) return pairs;

	const leftIdToIndex = new Map<number, number>();
	leftAttrs.forEach((a, i) => leftIdToIndex.set(a.id, i));
	const rightIdToIndex = new Map<number, number>();
	rightAttrs.forEach((a, i) => rightIdToIndex.set(a.id, i));

	const stack: ScalarPlanNode[] = [cond];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode) {
			const op = n.expression.operator;
			if (op === 'AND') {
				stack.push(n.left, n.right);
				continue;
			}
			if (op === '=') {
				if (n.left instanceof ColumnReferenceNode && n.right instanceof ColumnReferenceNode) {
					let lIdx = leftIdToIndex.get(n.left.attributeId);
					let rIdx = rightIdToIndex.get(n.right.attributeId);
					if (lIdx !== undefined && rIdx !== undefined) {
						pairs.push({ left: lIdx, right: rIdx });
					} else {
						lIdx = leftIdToIndex.get(n.right.attributeId);
						rIdx = rightIdToIndex.get(n.left.attributeId);
						if (lIdx !== undefined && rIdx !== undefined) {
							pairs.push({ left: lIdx, right: rIdx });
						}
					}
				}
			}
		}
	}
	return pairs;
}

/**
 * Represents a logical JOIN operation between two relations.
 * This is a logical node that will be converted to physical join algorithms during optimization.
 */
export class JoinNode extends PlanNode implements BinaryRelationalNode, JoinCapable, PredicateSourceCapable {
	readonly nodeType = PlanNodeType.Join;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly left: RelationalPlanNode,
		public readonly right: RelationalPlanNode,
		public readonly joinType: JoinType,
		public readonly condition?: ScalarPlanNode,
		public readonly usingColumns?: readonly string[]
	) {
		// Cost estimate: base cost is sum of children plus join cost
		const leftCost = left.getTotalCost();
		const rightCost = right.getTotalCost();
		const leftRows = left.estimatedRows ?? 100;
		const rightRows = right.estimatedRows ?? 100;

		// Simple join cost heuristic - nested loop cost
		const joinCost = leftRows * rightRows;
		super(scope, leftCost + rightCost + joinCost);

		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const leftPhys = childrenPhysical[0];
		const rightPhys = childrenPhysical[1];
		const leftType = this.left.getType();
		const rightType = this.right.getType();
		const leftAttrs = this.left.getAttributes();
		const rightAttrs = this.right.getAttributes();

		// Extract equi-join index pairs from condition
		const pairs = extractEquiPairsFromCondition(
			this.condition, leftAttrs, rightAttrs
		);

		const result = analyzeJoinKeyCoverage(
			this.joinType, leftPhys, rightPhys, leftType, rightType,
			pairs, this.left.estimatedRows, this.right.estimatedRows,
			leftType.columns.length,
		);

		// Map column-index equi-pairs to attribute-id pairs for monotonicOn propagation.
		const attrIdPairs = pairs.map(p => ({
			leftAttrId: leftAttrs[p.left]?.id,
			rightAttrId: rightAttrs[p.right]?.id,
		})).filter(p => p.leftAttrId !== undefined && p.rightAttrId !== undefined) as
			Array<{ leftAttrId: number; rightAttrId: number }>;

		const totalCols = this.getAttributes().length;
		const fdResult = propagateJoinFds(
			this.joinType, leftPhys, rightPhys, pairs,
			leftType.columns.length, totalCols, result.preservedKeys,
		);

		return {
			estimatedRows: result.estimatedRows,
			monotonicOn: propagateJoinMonotonicOn(this.joinType, leftPhys, rightPhys, attrIdPairs),
			fds: fdResult.fds,
			equivClasses: fdResult.equivClasses,
			constantBindings: fdResult.constantBindings,
			domainConstraints: fdResult.domainConstraints,
		};
	}

	private buildAttributes(): Attribute[] {
		return buildJoinAttributes(this.left.getAttributes(), this.right.getAttributes(), this.joinType);
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		const leftType = this.left.getType();
		const rightType = this.right.getType();
		// Equi-pairs are needed for LEFT/RIGHT outer key propagation (preserved-side
		// keys only survive when the other side's key is covered by the pairs).
		const pairs = extractEquiPairsFromCondition(
			this.condition, this.left.getAttributes(), this.right.getAttributes(),
		);
		const keys = combineJoinKeys(leftType.keys, rightType.keys, this.joinType, leftType.columns.length, pairs);
		return buildJoinRelationType(leftType, rightType, this.joinType, keys);
	}

	getChildren(): readonly PlanNode[] {
		return this.condition ? [this.left, this.right, this.condition] : [this.left, this.right];
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.left, this.right];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.condition ? 3 : 2;
		if (newChildren.length !== expectedLength) {
			quereusError(`JoinNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight, newCondition] = newChildren;

		// Type check
		if (!isRelationalNode(newLeft)) {
			quereusError('JoinNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isRelationalNode(newRight)) {
			quereusError('JoinNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (newCondition && !('expression' in newCondition)) {
			quereusError('JoinNode: third child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Check if anything changed
		const leftChanged = newLeft !== this.left;
		const rightChanged = newRight !== this.right;
		const conditionChanged = newCondition !== this.condition;

		if (!leftChanged && !rightChanged && !conditionChanged) {
			return this;
		}

		// Create new instance - JoinNode creates new attributes by combining left and right
		return new JoinNode(
			this.scope,
			newLeft as RelationalPlanNode,
			newRight as RelationalPlanNode,
			this.joinType,
			newCondition as ScalarPlanNode | undefined,
			this.usingColumns
		);
	}

	get estimatedRows(): number | undefined {
		return estimateJoinRows(this.left.estimatedRows, this.right.estimatedRows, this.joinType);
	}

	override toString(): string {
		const joinTypeDisplay = this.joinType.toUpperCase();
		if (this.condition) {
			return `${joinTypeDisplay} JOIN ON condition`;
		} else if (this.usingColumns) {
			return `${joinTypeDisplay} JOIN USING(${this.usingColumns.join(', ')})`;
		} else {
			return `${joinTypeDisplay} JOIN`;
		}
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			joinType: this.joinType,
			hasCondition: !!this.condition,
			usingColumns: this.usingColumns,
			leftRows: this.left.estimatedRows,
			rightRows: this.right.estimatedRows
		};
	}

	public getJoinType(): JoinType {
		return this.joinType;
	}

	public getJoinCondition(): ScalarPlanNode | undefined {
		return this.condition;
	}

	public getLeftSource(): RelationalPlanNode {
		return this.left;
	}

	public getRightSource(): RelationalPlanNode {
		return this.right;
	}

	public getUsingColumns(): readonly string[] | undefined {
		return this.usingColumns;
	}

	// PredicateSourceCapable: Expose ON condition (if present) as a predicate source
	getPredicates(): readonly ScalarPlanNode[] {
		return this.condition ? [normalizePredicate(this.condition)] : [];
	}
}
