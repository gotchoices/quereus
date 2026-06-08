/**
 * Rule: Monotonic LIMIT/OFFSET pushdown
 *
 * Pattern (the rule peels through these in order, top-down from the
 * LimitOffsetNode toward the leaf):
 *
 *   LimitOffsetNode
 *     └─ SortNode?           (single trivial column ref matching leaf monotonicOn)
 *           └─ (ProjectNode | AliasNode)*   (only trivial column-reference projections)
 *                 └─ IndexScan / IndexSeek / SeqScan
 *                       (advertises monotonicOn AND accessCapabilities.ordinalSeek)
 *
 * On a successful match, the entire `LimitOffset[/Sort]/.../leaf` subtree is
 * replaced with `…/OrdinalSlice(leaf)` — the OrdinalSlice slots in directly
 * above the leaf, threading the resolved offset/limit into the leaf's
 * FilterInfo so the vtab can seek directly to the kth row in O(log N)
 * instead of buffering k+n rows.
 *
 * Trivial Project nodes (all projections are bare ColumnReferenceNodes) and
 * Alias wrappers preserve row count and order, so we can descend through
 * them — the OrdinalSlice still slices the leaf in monotonic order.
 *
 * The rule rejects all of:
 *   - `Sort` whose key isn't a single trivial column ref into the leaf
 *   - `Sort` direction mismatching the advertised `monotonicOn.direction`
 *   - any non-trivial intermediate node (Filter, Distinct, Aggregate, etc.)
 *   - leaf advertising `monotonicOn` but not `ordinalSeek`
 *   - multi-key `ORDER BY`
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { SortNode } from '../../nodes/sort.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode } from '../../nodes/table-access-nodes.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { OrdinalSliceNode } from '../../nodes/ordinal-slice-node.js';

const log = createLogger('optimizer:rule:monotonic-limit-pushdown');

type AccessLeaf = SeqScanNode | IndexScanNode | IndexSeekNode;

function isAccessLeaf(node: PlanNode): node is AccessLeaf {
	return node instanceof SeqScanNode || node instanceof IndexScanNode || node instanceof IndexSeekNode;
}

/**
 * A Project is "trivial" iff every projection is a bare ColumnReferenceNode.
 * Trivial projects preserve row count, order, and per-row identity, so an
 * OrdinalSlice underneath them still computes the right slice indices.
 *
 * Computed/expression projections might mutate cardinality (impossible for
 * pure scalars, but the conservative check keeps the rule simple) or change
 * the meaning of "kth row" if combined with subqueries; we exclude them.
 */
function isTrivialProject(project: ProjectNode): boolean {
	return project.projections.every(p => p.node instanceof ColumnReferenceNode);
}

interface PeelResult {
	leaf: AccessLeaf;
	/** Original chain root (the node directly under the LimitOffset, possibly Sort).
	 *  This is the source we'll rewrite to embed the OrdinalSlice. */
	chainRoot: RelationalPlanNode;
	/** SortNode found between LimitOffset and leaf (if any). */
	sort: SortNode | undefined;
}

/**
 * Walk down from `chainRoot` toward the access leaf, descending only through
 * trivial Project / Alias wrappers. Returns null if we hit a non-trivial node
 * before reaching the leaf.
 */
function peelToLeaf(chainRoot: RelationalPlanNode): PeelResult | null {
	let cursor: RelationalPlanNode = chainRoot;
	let sort: SortNode | undefined;

	if (cursor instanceof SortNode) {
		sort = cursor;
		cursor = cursor.source;
	}

	let safety = 16;
	while (safety-- > 0) {
		if (isAccessLeaf(cursor)) {
			return { leaf: cursor, chainRoot, sort };
		}
		if (cursor instanceof AliasNode) {
			cursor = cursor.source;
			continue;
		}
		if (cursor instanceof ProjectNode && isTrivialProject(cursor)) {
			cursor = cursor.source;
			continue;
		}
		return null;
	}
	return null;
}

/**
 * Rebuild the chain `chainRoot → … → oldLeaf` with `oldLeaf` replaced by
 * `newLeaf`. Each intermediate node is reconstructed via `withChildren`,
 * preserving its other children (scalar inputs to Project / Sort).
 */
function rebuildChain(
	chainRoot: RelationalPlanNode,
	oldLeaf: AccessLeaf,
	newLeaf: RelationalPlanNode,
): RelationalPlanNode {
	if (chainRoot === (oldLeaf as unknown as RelationalPlanNode)) {
		return newLeaf;
	}

	const originalChildren = chainRoot.getChildren();
	const newChildren: PlanNode[] = originalChildren.map(child => {
		if (isRelationalNode(child)) {
			return rebuildChain(child, oldLeaf, newLeaf);
		}
		return child;
	});
	return chainRoot.withChildren(newChildren) as RelationalPlanNode;
}

export function ruleMonotonicLimitPushdown(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof LimitOffsetNode)) return null;

	// Degenerate LimitOffset (no bounds) — nothing to push down.
	if (!node.limit && !node.offset) return null;

	const peeled = peelToLeaf(node.source);
	if (!peeled) {
		log('Could not peel down to a physical access leaf from %s', node.source.nodeType);
		return null;
	}

	const physical = peeled.leaf.physical;
	if (!physical.accessCapabilities?.ordinalSeek) {
		log('Leaf does not advertise ordinalSeek; skipping');
		return null;
	}
	const monotonicOn = physical.monotonicOn;
	if (!monotonicOn || monotonicOn.length === 0) {
		log('Leaf advertises ordinalSeek but no monotonicOn; skipping');
		return null;
	}

	const leafMonotonic = monotonicOn[0];

	// If a Sort is present, it must be a single trivial column ref whose
	// attribute id and direction match the leaf's monotonicOn[0].
	if (peeled.sort) {
		if (peeled.sort.sortKeys.length !== 1) {
			log('Sort has %d keys; multi-key ORDER BY not supported', peeled.sort.sortKeys.length);
			return null;
		}
		const key = peeled.sort.sortKeys[0];
		if (!(key.expression instanceof ColumnReferenceNode)) {
			log('Sort key is not a trivial column reference');
			return null;
		}
		if (key.expression.attributeId !== leafMonotonic.attrId) {
			log('Sort key attr=%d does not match leaf monotonicOn attr=%d',
				key.expression.attributeId, leafMonotonic.attrId);
			return null;
		}
		if (key.direction !== leafMonotonic.direction) {
			log('Sort direction %s does not match leaf monotonicOn direction %s',
				key.direction, leafMonotonic.direction);
			return null;
		}
	}

	// Build OrdinalSlice over the leaf, then re-stitch the chain above it.
	const slice = new OrdinalSliceNode(
		node.scope,
		peeled.leaf,
		leafMonotonic.attrId,
		node.offset,
		node.limit,
		leafMonotonic.direction,
	);

	// `chainRoot` is the original LimitOffset.source — could be Sort, Project,
	// Alias, or the leaf itself. We replace the leaf in that chain with the
	// slice and drop the Sort if present (the slice preserves emit order).
	let rewrittenSource: RelationalPlanNode;
	if (peeled.sort) {
		// Drop the Sort entirely: the slice's source already emits in the
		// requested order, so re-sorting would be wasteful.
		rewrittenSource = rebuildChain(peeled.sort.source, peeled.leaf, slice);
	} else {
		rewrittenSource = rebuildChain(peeled.chainRoot, peeled.leaf, slice);
	}

	log('Replaced LimitOffset[/Sort]/leaf with OrdinalSlice (attr=%d, %s)',
		leafMonotonic.attrId, leafMonotonic.direction);
	return rewrittenSource;
}
