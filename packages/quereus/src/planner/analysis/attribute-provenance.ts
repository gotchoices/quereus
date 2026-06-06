/**
 * Attribute provenance: a derived map from attribute id to the relational node
 * that *originated* (minted) it.
 *
 * Attribute ids have two distinct lifecycle operations that `getAttributes()`
 * smears together:
 *
 *  - **Origination** — a node mints a fresh id via `PlanNode.nextAttrId()`
 *    (scans, computed projections, aggregate outputs, VALUES rows).
 *  - **Forwarding** — a node re-publishes an id one of its children already
 *    produced (SetOperation, Join concatenation, EagerPrefetch, AsyncGather,
 *    simple column-ref projections, ...).
 *
 * The real invariant of the attribute model is "each id is *originated* exactly
 * once", NOT "each id appears at most once in the tree" — forwarding the same id
 * up through N ancestors is the whole point of stable ids.
 *
 * Origination is derivable structurally with no per-node declaration: an id is
 * originated at the deepest relational node that outputs it and whose direct
 * relational children do **not**. A single post-order walk over the existing
 * `getAttributes()` surface yields the complete provenance map.
 */

import { isRelationalNode, type PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export interface ProvenanceEntry {
	/** The relational node that originated (minted) this attribute id. */
	readonly originNode: RelationalPlanNode;
	/** Tree path to the origin (node-type chain), for diagnostics. */
	readonly path: string;
}

/**
 * Compute the attribute-provenance surface for a plan tree in one post-order
 * walk. An attribute id is *originated* at the deepest relational node that
 * outputs it and whose direct relational children do not; ancestors that
 * re-publish the id are forwards, not new origins.
 *
 * The returned map contains an entry for every id that appears anywhere in the
 * tree (forwarded ids resolve to their origin), so membership answers "is this
 * id in scope?" exactly as the old global-set check did.
 *
 * @throws QuereusError(INTERNAL) when two distinct relational nodes originate
 *   the same id (the genuine-bug case the old validator caught) or when a single
 *   node lists the same id more than once. Forwarding never throws.
 */
export function computeAttributeProvenance(root: PlanNode): Map<number, ProvenanceEntry> {
	const provenance = new Map<number, ProvenanceEntry>();
	const visited = new Set<PlanNode>();

	const walk = (node: PlanNode, path: readonly string[]): void => {
		// Dedupe by node identity: plan trees are DAGs (shared CTE/common
		// subexpression instances). Visiting a shared instance once keeps the
		// walk linear and avoids treating its single origin as a collision.
		if (visited.has(node)) return;
		visited.add(node);

		const nodeChain = [...path, node.nodeType];

		// Post-order: process children before deciding what this node originates.
		for (const child of node.getChildren()) {
			walk(child, nodeChain);
		}

		if (!isRelationalNode(node)) return;

		// Ids output by direct relational children are forwarded, not originated here.
		const childIds = new Set<number>();
		for (const rel of node.getRelations()) {
			for (const attr of rel.getAttributes()) {
				childIds.add(attr.id);
			}
		}

		const nodePath = nodeChain.join(' > ');
		for (const attr of node.getAttributes()) {
			if (childIds.has(attr.id)) continue; // forwarded — not an origin

			const existing = provenance.get(attr.id);
			if (existing) {
				if (existing.originNode === node) {
					throw new QuereusError(
						`Duplicate attribute ID ${attr.id} within the output of ${nodePath}`,
						StatusCode.INTERNAL,
					);
				}
				throw new QuereusError(
					`Attribute ID ${attr.id} originated at two distinct nodes (${existing.path} and ${nodePath})`,
					StatusCode.INTERNAL,
				);
			}

			provenance.set(attr.id, { originNode: node, path: nodePath });
		}
	};

	walk(root, []);
	return provenance;
}
