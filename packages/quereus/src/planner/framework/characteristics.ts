/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Characteristics-based plan node analysis
 *
 * This module provides utilities for analyzing plan nodes based on their capabilities
 * and characteristics rather than their specific types, enabling robust and extensible
 * optimization rules.
 */

import type { PlanNode, RelationalPlanNode, ScalarPlanNode, ConstantNode, TableDescriptor, MonotonicOnInfo } from '../nodes/plan-node.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import { hasAnyKey, hasSingletonFd } from '../util/fd-utils.js';

// Default row estimate when not available
const DEFAULT_ROW_ESTIMATE = 1000;

/**
 * Core physical property-based characteristics
 */
export class PlanNodeCharacteristics {
	// Physical property shortcuts
	static hasSideEffects(node: PlanNode): boolean {
		return node.physical.readonly === false;
	}

	/**
	 * True iff this node OR any descendant in its subtree has side effects.
	 *
	 * `PlanNode.physical.readonly` propagates as AND-of-children, so for any
	 * well-formed plan tree `hasSideEffects(node) ⇔ subtreeHasSideEffects(node)`.
	 * This helper exists for rules that want to express the audit intent
	 * explicitly ("refuse if any subtree I am about to move / drop / dedup
	 * carries a write") — and as a defensive belt against a node that fails to
	 * forward the property through its own `computePhysical` override.
	 */
	static subtreeHasSideEffects(node: PlanNode): boolean {
		if (this.hasSideEffects(node)) return true;
		for (const child of node.getChildren()) {
			if (this.subtreeHasSideEffects(child)) return true;
		}
		return false;
	}

	/**
	 * True iff the subtree rooted at `node` is safe to drive concurrently with a
	 * sibling subtree under a parallel-track operator (`EagerPrefetchNode`,
	 * `AsyncGatherNode`, `FanOutLookupJoinNode`).
	 *
	 * For now, the only gate is **side-effect freedom**: a subtree carrying a
	 * write violates the per-connection lock contract under every module
	 * concurrency mode except `'fully-reentrant'`, and no module currently
	 * advertises that level. The module-level concurrency contract
	 * (`'serial'` / `'reentrant-reads'` / `'fully-reentrant'`) is enforced
	 * separately via `PhysicalProperties.concurrencySafe`, which the parallel-
	 * track rules already consult; this predicate is the **side-effect** gate
	 * that pairs with it. Once a `'fully-reentrant'` module ships, this
	 * predicate can be refined to allow concurrent impure execution on it.
	 *
	 * Pairs with the parallel-track recognition rules' refusal discipline: any
	 * rule that introduces an `EagerPrefetchNode` / `AsyncGatherNode` /
	 * `FanOutLookupJoinNode` consults this predicate on every participating
	 * branch and refuses (leaves the serial plan in place) when any branch
	 * reports unsafe. See `docs/optimizer.md` § "Parallel-track side-effect
	 * refusal" for the cross-rule discipline.
	 */
	static isConcurrencySafe(node: PlanNode): boolean {
		return !this.subtreeHasSideEffects(node);
	}

	static isReadOnly(node: PlanNode): boolean {
		return node.physical.readonly !== false;
	}

	static isDeterministic(node: PlanNode): boolean {
		return node.physical.deterministic !== false;
	}

	static isIdempotent(node: PlanNode): boolean {
		return node.physical.idempotent !== false;
	}

	static isConstant(node: PlanNode): node is ConstantNode {
		return node.physical.constant === true && 'getValue' in node;
	}

	static isFunctional(node: PlanNode): boolean {
		return this.isDeterministic(node) && this.isReadOnly(node);
	}

	// Ordering capabilities
	static hasOrderedOutput(node: PlanNode): boolean {
		return node.physical.ordering !== undefined && node.physical.ordering.length > 0;
	}

	static preservesOrdering(node: PlanNode): boolean {
		// Check if node preserves input ordering (single child with ordered output)
		const children = node.getChildren();
		return children.length === 1 && this.hasOrderedOutput(children[0]);
	}

	static getOrdering(node: PlanNode): { column: number; desc: boolean }[] | undefined {
		return node.physical.ordering;
	}

	// MonotonicOn capabilities
	static getMonotonicOn(node: PlanNode): readonly MonotonicOnInfo[] {
		return node.physical.monotonicOn ?? [];
	}

	static isMonotonicOn(node: PlanNode, attrId: number): MonotonicOnInfo | undefined {
		return node.physical.monotonicOn?.find(m => m.attrId === attrId);
	}

	// Cardinality analysis
	static estimatesRows(node: PlanNode): number {
		return node.physical.estimatedRows ?? DEFAULT_ROW_ESTIMATE;
	}

	/**
	 * True iff the relation is guaranteed to produce at most one row — i.e.,
	 * the singleton FD `∅ → all_cols` holds. (Replaces the legacy `[[]]`
	 * uniqueKeys marker.)
	 */
	static guaranteesUniqueRows(node: PlanNode): boolean {
		if (!isRelationalNode(node)) return false;
		const colCount = node.getAttributes().length;
		if (colCount === 0) {
			// Zero-column relation: at-most-one-row claim comes via estimatedRows
			// since the singleton FD isn't representable.
			return node.physical.estimatedRows === 1;
		}
		return hasSingletonFd(node.physical.fds, colCount);
	}

	/**
	 * True iff the relation has at least one non-trivial unique key — i.e., an
	 * FD whose determinants form a superkey of all output columns, with the
	 * determinant set strictly smaller than the full column list.
	 */
	static hasUniqueKeys(node: PlanNode): boolean {
		if (!isRelationalNode(node)) return false;
		const colCount = node.getAttributes().length;
		return hasAnyKey(node.physical.fds, colCount);
	}

	// Relational capabilities
	static isRelational(node: PlanNode): node is RelationalPlanNode {
		return isRelationalNode(node);
	}

	static producesRows(node: PlanNode): node is RelationalPlanNode {
		return isRelationalNode(node);
	}

	static isScalar(node: PlanNode): boolean {
		return node.getType().typeClass === 'scalar';
	}

	static isVoid(node: PlanNode): boolean {
		return node.getType().typeClass === 'void';
	}

	// Performance characteristics
	static isExpensive(node: PlanNode): boolean {
		const estimatedRows = this.estimatesRows(node);
		return estimatedRows > 10000; // Tunable threshold
	}

	static isLikelyRepeated(node: PlanNode): boolean {
		// Heuristic: nodes with side effects are likely to be repeated in joins
		return this.hasSideEffects(node);
	}
}

/**
 * Interface for nodes that can provide predicates (WHERE clauses, join conditions)
 */
export interface PredicateCapable extends PlanNode {
	getPredicate(): ScalarPlanNode | null;
	withPredicate(newPredicate: ScalarPlanNode | null): PlanNode;
}

/**
 * Interface for nodes that can expose one or more local predicates (e.g., WHERE, ON)
 */
export interface PredicateSourceCapable extends PlanNode {
	getPredicates(): readonly ScalarPlanNode[];
}

/**
 * Interface for nodes that can combine predicates (for pushdown optimization)
 */
export interface PredicateCombinable extends PredicateCapable {
	canCombinePredicates(): boolean;
	combineWith(other: ScalarPlanNode): ScalarPlanNode;
}

/**
 * Interface for table access nodes
 */
export interface TableAccessCapable extends RelationalPlanNode {
	readonly tableSchema: TableSchema;
	getAccessMethod(): 'sequential' | 'index-scan' | 'index-seek' | 'virtual';
}

/**
 * Interface for aggregation operations
 */
export interface AggregationCapable extends RelationalPlanNode {
	getGroupingKeys(): readonly ScalarPlanNode[];
	getAggregateExpressions(): readonly { expr: ScalarPlanNode; alias: string; attributeId: number }[];
	requiresOrdering(): boolean;
	canStreamAggregate(): boolean;
	getSource(): RelationalPlanNode;
}

/**
 * Interface for sorting operations
 */
export interface SortCapable extends PlanNode {
	getSortKeys(): readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }[];
	withSortKeys(keys: readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }[]): PlanNode;
}

/**
 * Interface for limit/offset capability
 */
export interface LimitCapable extends PlanNode {
	getLimitExpression(): ScalarPlanNode | undefined;
	getOffsetExpression(): ScalarPlanNode | undefined;
}

/**
 * Interface for nodes that can provide stable attribute→column bindings for constraint mapping
 */
export interface ColumnBindingProvider extends PlanNode {
	/** Relation name used for mapping/presentation (e.g., schema.table or alias) */
	getBindingRelationName(): string;
	/** Attributes (id/name) visible at this binding boundary */
	getBindingAttributes(): ReadonlyArray<{ id: number; name: string }>;
	/** Column index in the output row for a given attribute id */
	getColumnIndexForAttribute(attributeId: number): number | undefined;
}

/**
 * Interface for projection operations
 */
export interface ProjectionCapable extends RelationalPlanNode {
	getProjections(): readonly { node: ScalarPlanNode; alias: string; attributeId: number }[];
	withProjections(projections: readonly { node: ScalarPlanNode; alias: string; attributeId: number }[]): PlanNode;
}

/**
 * Interface for join operations
 */
export interface JoinCapable extends RelationalPlanNode {
	getJoinType(): 'inner' | 'left' | 'right' | 'full' | 'cross' | 'semi' | 'anti';
	getJoinCondition(): ScalarPlanNode | undefined;
	getLeftSource(): RelationalPlanNode;
	getRightSource(): RelationalPlanNode;
	getUsingColumns(): readonly string[] | undefined;
}

/**
 * Interface for cached operations
 */
export interface CacheCapable extends PlanNode {
	getCacheStrategy(): string | null;
	isCached(): boolean;
}

/**
 * Interface for Common Table Expression operations
 */
export interface CTECapable extends RelationalPlanNode {
	readonly cteName: string;
	readonly columns: string[] | undefined;
	readonly materializationHint: 'materialized' | 'not_materialized' | undefined;
	readonly isRecursive: boolean;
	getCTESource(): RelationalPlanNode;
}

/**
 * Interface for column reference nodes
 */
export interface ColumnReferenceCapable extends ScalarPlanNode {
	readonly attributeId: number;
	readonly columnIndex: number;
	readonly expression: AST.ColumnExpr;
}

/**
 * Interface for window function call nodes
 */
export interface WindowFunctionCapable extends ScalarPlanNode {
	readonly functionName: string;
	readonly isDistinct: boolean;
	readonly alias?: string;
}

/**
 * Interface for aggregate function call nodes
 */
export interface AggregateFunctionCapable extends ScalarPlanNode {
	readonly functionName: string;
	readonly isDistinct: boolean;
	readonly args: ReadonlyArray<ScalarPlanNode>;
}

/**
 * Interface for internal recursive CTE reference nodes
 */
export interface RecursiveCTERefCapable extends RelationalPlanNode {
	readonly cteName: string;
	readonly workingTableDescriptor: TableDescriptor;
}

/**
 * Type guards for capability detection
 */
export class CapabilityDetectors {
	static canPushDownPredicate(node: PlanNode): node is PredicateCapable {
		return 'getPredicate' in node &&
			typeof (node as any).getPredicate === 'function' &&
			'withPredicate' in node &&
			typeof (node as any).withPredicate === 'function';
	}

	static canCombinePredicates(node: PlanNode): node is PredicateCombinable {
		return this.canPushDownPredicate(node) &&
			'canCombinePredicates' in node &&
			typeof (node as any).canCombinePredicates === 'function';
	}

	static isPredicateSource(node: PlanNode): node is PredicateSourceCapable {
		return 'getPredicates' in node && typeof (node as any).getPredicates === 'function';
	}

	static isTableAccess(node: PlanNode): node is TableAccessCapable {
		return PlanNodeCharacteristics.isRelational(node) &&
			'tableSchema' in node &&
			'getAccessMethod' in node &&
			typeof (node as any).getAccessMethod === 'function';
	}

	static isAggregating(node: PlanNode): node is AggregationCapable {
		return PlanNodeCharacteristics.isRelational(node) &&
			'getGroupingKeys' in node &&
			typeof (node as any).getGroupingKeys === 'function' &&
			'getAggregateExpressions' in node &&
			typeof (node as any).getAggregateExpressions === 'function';
	}

	static isSortable(node: PlanNode): node is SortCapable {
		return 'getSortKeys' in node &&
			typeof (node as any).getSortKeys === 'function' &&
			'withSortKeys' in node &&
			typeof (node as any).withSortKeys === 'function';
	}

	static isLimit(node: PlanNode): node is LimitCapable {
		return 'getLimitExpression' in node &&
			typeof (node as any).getLimitExpression === 'function' &&
			'getOffsetExpression' in node &&
			typeof (node as any).getOffsetExpression === 'function';
	}

	static isColumnBindingProvider(node: PlanNode): node is ColumnBindingProvider {
		return 'getBindingRelationName' in node &&
			(typeof (node as any).getBindingRelationName === 'string' || typeof (node as any).getBindingRelationName === 'function');
	}

	static canProject(node: PlanNode): node is ProjectionCapable {
		return PlanNodeCharacteristics.isRelational(node) &&
			'getProjections' in node &&
			typeof (node as any).getProjections === 'function';
	}

	static isJoin(node: PlanNode): node is JoinCapable {
		return PlanNodeCharacteristics.isRelational(node) &&
			'getJoinType' in node &&
			typeof (node as any).getJoinType === 'function' &&
			'getLeftSource' in node &&
			'getRightSource' in node;
	}

	static isCached(node: PlanNode): node is CacheCapable {
		return 'getCacheStrategy' in node &&
			typeof (node as any).getCacheStrategy === 'function';
	}

	static isCTE(node: PlanNode): node is CTECapable {
		return PlanNodeCharacteristics.isRelational(node) &&
			'cteName' in node &&
			typeof (node as any).cteName === 'string' &&
			'getCTESource' in node &&
			typeof (node as any).getCTESource === 'function';
	}

	static isColumnReference(node: PlanNode): node is ColumnReferenceCapable {
		if (!node) return false;
		return PlanNodeCharacteristics.isScalar(node) &&
			'attributeId' in node &&
			typeof (node as any).attributeId === 'number' &&
			'columnIndex' in node &&
			typeof (node as any).columnIndex === 'number' &&
			'expression' in node;
	}

	static isWindowFunction(node: PlanNode): node is WindowFunctionCapable {
		if (!node) return false;
		// Check nodeType specifically to distinguish from AggregateFunctionCallNode
		return node.nodeType === 'WindowFunctionCall' &&
			PlanNodeCharacteristics.isScalar(node) &&
			'functionName' in node &&
			typeof (node as any).functionName === 'string' &&
			'isDistinct' in node &&
			typeof (node as any).isDistinct === 'boolean';
	}

	static isAggregateFunction(node: PlanNode): node is AggregateFunctionCapable {
		if (!node) return false;
		// Check for AggregateFunctionCallNode - it uses ScalarFunctionCall nodeType but has args property
		return PlanNodeCharacteristics.isScalar(node) &&
			'functionName' in node &&
			typeof (node as any).functionName === 'string' &&
			'isDistinct' in node &&
			typeof (node as any).isDistinct === 'boolean' &&
			'args' in node &&
			Array.isArray((node as any).args) &&
			'functionSchema' in node;
	}

	static isRecursiveCTERef(node: PlanNode): node is RecursiveCTERefCapable {
		if (!node) return false;
		return PlanNodeCharacteristics.isRelational(node) &&
			'cteName' in node &&
			typeof (node as any).cteName === 'string' &&
			'workingTableDescriptor' in node;
	}
}

/**
 * Extensible capability registry for custom characteristics
 */
export class CapabilityRegistry {
	private static readonly detectors = new Map<string, (node: PlanNode) => boolean>();

	static register(
		capability: string,
		detector: (node: PlanNode) => boolean
	): void {
		this.detectors.set(capability, detector);
	}

	static hasCapability(node: PlanNode, capability: string): boolean {
		const detector = this.detectors.get(capability);
		return detector ? detector(node) : false;
	}

	static getCapable(
		nodes: readonly PlanNode[],
		capability: string
	): PlanNode[] {
		const detector = this.detectors.get(capability);
		if (!detector) return [];
		return nodes.filter(detector);
	}

	static getAllCapabilities(): string[] {
		return Array.from(this.detectors.keys());
	}

	static unregister(capability: string): boolean {
		return this.detectors.delete(capability);
	}
}

/**
 * Caching analysis utilities
 */
export class CachingAnalysis {
	static isCacheable(node: PlanNode): boolean {
		// Must be relational to cache results
		if (!PlanNodeCharacteristics.isRelational(node)) {
			return false;
		}

		// Already cached nodes don't need re-caching
		if (CapabilityDetectors.isCached(node) && (node as any).isCached()) {
			return false;
		}

		// Check physical properties for side effects
		if (PlanNodeCharacteristics.hasSideEffects(node)) {
			// Only cache if execution would be expensive and repeated
			return this.isExpensiveRepeatedOperation(node);
		}

		return true;
	}

	static shouldCache(node: PlanNode): boolean {
		if (!this.isCacheable(node)) {
			return false;
		}

		// Cache expensive operations
		if (PlanNodeCharacteristics.isExpensive(node)) {
			return true;
		}

		// Cache likely repeated operations
		if (PlanNodeCharacteristics.isLikelyRepeated(node)) {
			return true;
		}

		return false;
	}

	private static isExpensiveRepeatedOperation(node: PlanNode): boolean {
		return PlanNodeCharacteristics.isExpensive(node) &&
			PlanNodeCharacteristics.isLikelyRepeated(node);
	}

	static getCacheThreshold(node: PlanNode): number {
		const estimatedRows = PlanNodeCharacteristics.estimatesRows(node);
		return Math.min(Math.max(estimatedRows * 0.1, 1000), 100000);
	}
}

/**
 * Predicate analysis utilities
 */
export class PredicateAnalysis {
	static canPushDown(predicate: ScalarPlanNode, targetNode: PlanNode): boolean {
		if (!CapabilityDetectors.canPushDownPredicate(targetNode)) {
			return false;
		}

		// Check if predicate only references columns from target
		return this.predicateReferencesOnly(predicate, targetNode);
	}

	static canCombine(pred1: ScalarPlanNode, pred2: ScalarPlanNode): boolean {
		// Basic heuristic: both must be deterministic
		return PlanNodeCharacteristics.isDeterministic(pred1) &&
			PlanNodeCharacteristics.isDeterministic(pred2);
	}

	private static predicateReferencesOnly(_predicate: ScalarPlanNode, _targetNode: PlanNode): boolean {
		// TODO: Implement column reference analysis
		// For now, conservatively return true
		return true;
	}
}

// Register built-in capabilities
CapabilityRegistry.register('predicate-pushdown', CapabilityDetectors.canPushDownPredicate);
CapabilityRegistry.register('table-access', CapabilityDetectors.isTableAccess);
CapabilityRegistry.register('aggregation', CapabilityDetectors.isAggregating);
CapabilityRegistry.register('sort', CapabilityDetectors.isSortable);
CapabilityRegistry.register('projection', CapabilityDetectors.canProject);
CapabilityRegistry.register('join', CapabilityDetectors.isJoin);
CapabilityRegistry.register('cache', CapabilityDetectors.isCached);
CapabilityRegistry.register('cte', CapabilityDetectors.isCTE);
CapabilityRegistry.register('column-reference', CapabilityDetectors.isColumnReference);
CapabilityRegistry.register('window-function', CapabilityDetectors.isWindowFunction);
CapabilityRegistry.register('aggregate-function', CapabilityDetectors.isAggregateFunction);
CapabilityRegistry.register('recursive-cte-ref', CapabilityDetectors.isRecursiveCTERef);
