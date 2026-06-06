/**
 * Constant folding analysis for the Titan optimizer
 *
 * This module implements efficient single-pass constant folding:
 * 1. Bottom-up classification: Assign ConstInfo to every node during post-order DFS
 * 2. Top-down border detection: Identify const nodes whose parents are non-const
 * 3. Replacement: Replace border nodes with appropriate literals
 */

import { PlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { type SqlValue, type MaybePromise, OutputValue } from '../../common/types.js';
import { LiteralNode } from '../nodes/scalar.js';
import { createLogger } from '../../common/logger.js';
import type { ScalarType } from '../../common/datatype.js';
import { ColumnReferenceNode } from '../nodes/reference.js';

const log = createLogger('optimizer:folding');

/**
 * Constant information classification for plan nodes
 */
interface ConstInfoConst {
	kind: 'const';
	node: PlanNode; // Store the const node itself, not its value
}

interface ConstInfoDep {
	kind: 'dep';
	deps: Set<number>; // Set of AttributeId
}

interface ConstInfoVar {
	kind: 'non-const';
}

type ConstInfo = ConstInfoConst | ConstInfoDep | ConstInfoVar;

/**
 * Context for constant folding analysis
 */
export interface ConstFoldingContext {
	/** Map from node ID to ConstInfo classification */
	constInfo: Map<string, ConstInfo>;
	/** Border nodes that need evaluation (nodeId -> node) */
	borderNodes: Map<string, PlanNode>;
	/** Evaluation function for border expressions */
	evaluateExpression: (node: PlanNode) => MaybePromise<OutputValue>;
	/** Evaluation function for relational border nodes */
	evaluateRelation?: (node: PlanNode) => PlanNode;
}

/**
 * Create a new constant folding context
 */
export function createConstFoldingContext(
	evaluateExpression: (node: PlanNode) => MaybePromise<OutputValue>,
	evaluateRelation?: (node: PlanNode) => PlanNode
): ConstFoldingContext {
	return {
		constInfo: new Map(),
		borderNodes: new Map(),
		evaluateExpression,
		evaluateRelation
	};
}

/**
 * Perform complete single-pass constant folding on a plan tree
 * This is the main entry point for efficient constant folding
 */
export function performConstantFolding(
	root: PlanNode,
	evaluateExpression: (node: PlanNode) => MaybePromise<OutputValue>,
	evaluateRelation?: (node: PlanNode) => PlanNode
): PlanNode {
	const ctx = createConstFoldingContext(evaluateExpression, evaluateRelation);

	// Phase 1: Bottom-up classification
	classifyConstants(root, ctx);

	// Phase 2: Top-down border detection with dependency resolution
	detectBorderNodes(root, ctx, new Set());

	// Phase 3: Replace border nodes
	return replaceBorderNodes(root, ctx);
}

/**
 * Perform bottom-up constant classification on a plan tree
 */
export function classifyConstants(root: PlanNode, ctx: ConstFoldingContext): void {
	// Post-order DFS - classify children before parent
	const children = root.getChildren();
	for (const child of children) {
		classifyConstants(child, ctx);
	}

	// Classify this node based on its type and children
	const constInfo = classifyNode(root, ctx);
	ctx.constInfo.set(root.id, constInfo);

	log('Classified node %s (%s): %s', root.id, root.nodeType,
		constInfo.kind === 'const' ? `const` :
		constInfo.kind === 'dep' ? `dep([${Array.from(constInfo.deps).join(',')}])` :
		'non-const');
}

/**
 * Classify a single node - works for ANY node type
 */
function classifyNode(node: PlanNode, ctx: ConstFoldingContext): ConstInfo {
	// Rule 1: Any node with physical.constant === true
	if (node.physical.constant) {
		if ('getValue' in node) {
			return { kind: 'const', node: node };
		}
		throw new Error(`Node ${node} is constant but does not implement getValue()`);
	}

	// Rule 2: ColumnReference → dep with {attrId}
	if (node.nodeType === PlanNodeType.ColumnReference) {
		const colRef = node as ColumnReferenceNode
		return { kind: 'dep', deps: new Set([colRef.attributeId]) };
	}

	// Rule 3: Any other node - check if functional and inspect children
	if (!PlanNode.isFunctional(node.physical)) {
		return { kind: 'non-const' };
	}

	// Inspect children (works for both scalar and relational children)
	const childConstInfos = node.getChildren().map(child => {
		const childInfo = ctx.constInfo.get(child.id);
		if (!childInfo) {
			throw new Error(`No ConstInfo found for child node ${child.id}`);
		}
		return childInfo;
	});

	// If all children are const → this node is const
	// IMPORTANT: Only nodes with children can inherit const status
	if (childConstInfos.length > 0 && childConstInfos.every(info => info.kind === 'const')) {
		return { kind: 'const', node: node };
	}

	// If all children ∈ {const, dep} → dep with union of child deps
	if (childConstInfos.length > 0 && childConstInfos.every(info => info.kind === 'const' || info.kind === 'dep')) {
		const allDeps = new Set<number>();
		for (const info of childConstInfos) {
			if (info.kind === 'dep') {
				for (const dep of info.deps) {
					allDeps.add(dep);
				}
			}
		}
		return { kind: 'dep', deps: allDeps };
	}

	// Otherwise → non-const
	return { kind: 'non-const' };
}

/**
 * Top-down border detection with dependency resolution
 * A border node is:
 * - A const node (always foldable)
 * - A dep node whose dependencies are all resolved by known constant attributes
 */
function detectBorderNodes(
	node: PlanNode,
	ctx: ConstFoldingContext,
	knownConstAttrs: Set<number> = new Set()
): void {
	const nodeInfo = ctx.constInfo.get(node.id);

	// Check if this node is a border node
	if (nodeInfo?.kind === 'const') {
		const typeClass = node.getType().typeClass;
		if (!node.physical.constant && (typeClass === 'scalar' || typeClass === 'relation')) {
			// Foldable const border node (scalar or relational)
			ctx.borderNodes.set(node.id, node);
			log('Detected const border node: %s (%s)', node.id, node.nodeType);
			// Don't recurse into const subtrees - they'll all be replaced
			return;
		}
		if (node.physical.constant) {
			// Already a physical constant (e.g. LiteralNode) - no folding needed
			return;
		}
		// Non-foldable const node (e.g. Block with void type) - recurse to find inner borders
	} else if (nodeInfo?.kind === 'dep') {
		// Dep nodes become border nodes if all dependencies are resolved
		if (isSubsetOf(nodeInfo.deps, knownConstAttrs)) {
			ctx.borderNodes.set(node.id, node);
			log('Detected resolved dep border node: %s (%s) - deps %s resolved by %s',
				node.id, node.nodeType,
				Array.from(nodeInfo.deps).join(','),
				Array.from(knownConstAttrs).join(','));
			// Don't recurse - this entire subtree will be replaced
			return;
		}
	}

	// Update known constant attributes for this scope
	const updatedKnownAttrs = new Set(knownConstAttrs);

	// If this is a relational node that produces expressions, check what new constants it introduces
	if (node.getType().typeClass === 'relation' && 'getProducingExprs' in node) {
		const producingExprs = node.getProducingExprs!();

		if (producingExprs) {
			for (const [attrId, expr] of producingExprs) {
				const exprInfo = ctx.constInfo.get(expr.id);

				if (exprInfo?.kind === 'const') {
					// This expression produces a constant attribute
					updatedKnownAttrs.add(attrId);
					log('Node %s produces constant attribute %d', node.id, attrId);
				} else if (exprInfo?.kind === 'dep' && isSubsetOf(exprInfo.deps, knownConstAttrs)) {
					// This expression's dependencies are resolved, so it produces a constant
					updatedKnownAttrs.add(attrId);
					log('Node %s produces resolved constant attribute %d (was dep on %s)',
						node.id, attrId, Array.from(exprInfo.deps).join(','));
				}
			}
		}
	}

	// Recurse to children with updated known constant attributes
	for (const child of node.getChildren()) {
		detectBorderNodes(child, ctx, updatedKnownAttrs);
	}
}

/**
 * Utility function to check if set A is a subset of set B
 */
function isSubsetOf<T>(setA: Set<T>, setB: Set<T>): boolean {
	if (setA.size === 0) return true; // Empty set is subset of everything
	for (const elem of setA) {
		if (!setB.has(elem)) {
			return false;
		}
	}
	return true;
}

/**
 * Replace border nodes with appropriate literals
 */
function replaceBorderNodes(node: PlanNode, ctx: ConstFoldingContext): PlanNode {
	// If this node is a border node, replace it
	if (ctx.borderNodes.has(node.id)) {
		try {
			if (node.getType().typeClass === 'scalar') {
				const evaluatedValue = ctx.evaluateExpression(node);
				const literalExpr = { type: 'literal' as const, value: evaluatedValue as SqlValue };

				const replacement = new LiteralNode(
					node.scope,
					literalExpr,
					// Preserve the original node's type metadata so that information like
					// collation sequences survives the folding pass.
					node.getType() as ScalarType
				);
				log('Replaced scalar border node %s with LiteralNode', node.id);
				return replacement;
			} else if (ctx.evaluateRelation) {
				// Relational node - replace with TableLiteralNode
				const replacement = ctx.evaluateRelation(node);
				log('Replaced relational border node %s with TableLiteralNode', node.id);
				return replacement;
			} else {
				log('Relational border node %s skipped (no relational evaluator)', node.id);
				return node;
			}
		} catch (error) {
			log('Failed to evaluate border node %s: %s', node.id, error);
			return node;
		}
	}

	// Recursively replace children
	const children = node.getChildren();
	const replacedChildren = children.map(child => replaceBorderNodes(child, ctx));

	// If any children changed, create new node
	if (replacedChildren.some((child, i) => child !== children[i])) {
		return node.withChildren(replacedChildren);
	}

	return node;
}
