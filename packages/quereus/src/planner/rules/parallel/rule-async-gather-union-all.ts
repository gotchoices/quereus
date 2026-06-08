/**
 * Rule: Async Gather UNION ALL
 *
 * Recognizes a chain of `SetOperationNode(op='unionAll')` and folds the entire
 * left-deep (or arbitrary nesting) tree into a single N-ary
 * `AsyncGatherNode({ kind: 'unionAll' })` that drives the N branches
 * concurrently.
 *
 * Two gates must clear for the rewrite to fire:
 *
 *   1. **Concurrency safety.** Every flattened child must declare
 *      `physical.concurrencySafe === true`. Any non-safe branch (mutating
 *      subplan, serial-module read without a per-branch connection, holding a
 *      non-reentrant cursor) poisons the rewrite — leave the chain as
 *      sequential `SetOperationNode`s.
 *
 *   2. **Latency win.** The slowest child's `physical.expectedLatencyMs` must
 *      meet `tuning.parallel.gatherThresholdMs`. `expectedLatencyMs` is 0 on
 *      all in-process / memory-vtab paths, so the rule is inert by design in
 *      local-only configurations (the no-rewrite invariant is locked by the
 *      golden-plan sweep).
 *
 * The rule fires in `PassId.PostOptimization` after physical-property
 * selection has finalized `expectedLatencyMs` / `concurrencySafe` on the
 * leaves but before `materialization-advisory` so any cache wrapping the
 * advisory would inject sits *inside* the gather's branches (preserving the
 * parallel-drive intent of overlapping high-latency I/O with branch-local
 * compute).
 *
 * Attribute IDs are preserved: the rewritten gather node inherits the
 * outermost `SetOperationNode`'s attributes via `preserveAttributeIds`,
 * which already mirrors the leftmost child's attributes per
 * `SetOperationNode.buildAttributes`. Downstream consumers that referenced
 * the SetOp's output (e.g. an enclosing `ORDER BY x`) continue to resolve
 * unchanged.
 *
 * Idempotence: after the rewrite the root node is an `AsyncGatherNode`, not
 * a `SetOperationNode`, so a second firing's matcher rejects immediately.
 */

import { createLogger } from '../../../common/logger.js';
import type { OptContext } from '../../framework/context.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { SetOperationNode } from '../../nodes/set-operation-node.js';
import { AsyncGatherNode } from '../../nodes/async-gather-node.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:async-gather-union-all');

export function ruleAsyncGatherUnionAll(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof SetOperationNode)) return null;
	if (node.op !== 'unionAll') return null;

	const tuning = context.tuning.parallel;
	if (tuning.minBranches < 2) return null;

	// Flatten the entire unionAll tree (any shape — left-deep, right-deep,
	// balanced). Stops at the first non-unionAll-SetOperation child.
	const children: RelationalPlanNode[] = [];
	collectUnionAllChildren(node, children);
	if (children.length < tuning.minBranches) return null;

	// Gate 1: every child must be concurrency-safe. A single unsafe branch
	// poisons the rewrite. Side-effect freedom (`isConcurrencySafe`) is the
	// connection-lock gate that pairs with the module-level `concurrencySafe`
	// physical flag: an impure subtree on a `'serial'` / `'reentrant-reads'`
	// module would violate the connection lock under concurrent execution.
	for (const child of children) {
		if (child.physical.concurrencySafe !== true) {
			log('Aborting rewrite: child %s is not concurrencySafe', child.id);
			return null;
		}
		if (!PlanNodeCharacteristics.isConcurrencySafe(child)) {
			log('Aborting rewrite: child %s has side effects', child.id);
			return null;
		}
	}

	// Gate 2: max-of-children latency must meet the threshold. Memory-vtab /
	// in-process leaves declare expectedLatencyMs=0, so this skips the
	// rewrite for purely local plans (the no-rewrite invariant under the
	// golden-plan sweep).
	let maxLatency = 0;
	for (const child of children) {
		const l = child.physical.expectedLatencyMs ?? 0;
		if (l > maxLatency) maxLatency = l;
	}
	if (maxLatency < tuning.gatherThresholdMs) return null;

	const concurrencyCap = Math.max(1, Math.min(tuning.concurrency, children.length));

	log(
		'Folding unionAll chain of %d branches into AsyncGather (cap=%d, maxLatency=%d ms, threshold=%d ms)',
		children.length, concurrencyCap, maxLatency, tuning.gatherThresholdMs,
	);

	return new AsyncGatherNode(
		node.scope,
		children,
		{ kind: 'unionAll' },
		concurrencyCap,
		node.getAttributes(),
	);
}

/**
 * Walk an arbitrary tree of unionAll-`SetOperationNode`s and push the leaves
 * (first non-unionAll-SetOp descendant on each branch) into `out`. Recursion is
 * bounded by the unionAll chain depth, which is the same depth bound the
 * optimizer's pass already enforces.
 *
 * Also absorbs nested `AsyncGatherNode({ kind: 'unionAll' })` children — the
 * rule is registered for bottom-up traversal, so the inner `SetOperation` of
 * `(A unionAll B) unionAll C` will already have been rewritten into a
 * 2-branch gather by the time the outer `SetOperation` fires. Without this
 * absorption the outer rewrite would produce a 2-branch gather whose first
 * child is itself a gather, defeating the "single gather per chain"
 * invariant the tests pin.
 */
function collectUnionAllChildren(node: RelationalPlanNode, out: RelationalPlanNode[]): void {
	if (node.nodeType === PlanNodeType.SetOperation && (node as SetOperationNode).op === 'unionAll') {
		const setOp = node as SetOperationNode;
		collectUnionAllChildren(setOp.left, out);
		collectUnionAllChildren(setOp.right, out);
		return;
	}
	if (node.nodeType === PlanNodeType.AsyncGather) {
		const gather = node as AsyncGatherNode;
		if (gather.combinator.kind === 'unionAll') {
			for (const child of gather.children) {
				collectUnionAllChildren(child, out);
			}
			return;
		}
	}
	out.push(node);
}
