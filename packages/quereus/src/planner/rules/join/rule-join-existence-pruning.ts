/**
 * Rule: Join Existence-Flag Pruning (demand-gated)
 *
 * The read half (`outer-join-existence-read`) appends a `{true,false}` match
 * flag to a `JoinNode`'s output per `exists [<side>] as <name>` clause and
 * guards five join rules with `if (node.hasExistenceColumns) return null`
 * (join-elimination, fanout-lookup-join, join-physical-selection,
 * monotonic-merge-join, lateral-top1-asof). Those guards are load-bearing
 * *while the flag is live* — the flag's attr id is not a column of either side,
 * so the per-rule demand scans cannot see its dependency on the non-preserved
 * side, and eliminating/rewriting the join out from under a live flag would be
 * unsound.
 *
 * But when **nothing demands the flag**, the whole mechanism is dead weight: the
 * join is pinned to a nested-loop shape and cannot be eliminated, purely to
 * compute a column no one reads. This rule detects an existence flag whose
 * output attribute id is not demanded by any ancestor and rebuilds the
 * `JoinNode` without that `ExistenceColumnSpec`. Once the last spec is dropped,
 * `existence` becomes `undefined`, `hasExistenceColumns` flips to `false`, and
 * the five guarded rules re-enable automatically on the now flag-free join (in
 * the same pass — see optimizer.ts § registration).
 *
 * **Demand analysis (mirrors `ruleJoinElimination`).** The rule fires on a
 * ProjectNode, collects demanded attr ids from the projection expressions, and
 * `walkChain`s a whitelisted pass-through chain (Filter / Sort add their
 * referenced attrs; LimitOffset / Distinct / Alias pass through) down to the
 * first JoinNode. A node above the anchoring Project can only reference attr ids
 * the Project outputs, and the Project outputs exactly its projections' ids — so
 * a flag absent from `demanded` is provably dead. When the join is not reachable
 * through a clean Project+chain, `walkChain` returns null and the rule no-ops
 * (the flag is retained — correct, just unoptimized).
 *
 * **Why dropping even a middle flag is runtime-safe.** Runtime column resolution
 * is by attribute id, not a stored column index: `emitColumnReference` calls
 * `resolveAttribute(rctx, plan.attributeId, …)`, which indexes the row via a
 * `RowDescriptor` (attrId → columnIndex) rebuilt from the node's
 * `getAttributes()`. The join emitter builds the flag rows from `plan.existence`
 * in array order and `buildJoinAttributes` appends the flag attributes in the
 * same order — so the kept flags' relative order and the rebuilt descriptor stay
 * consistent after a middle-flag drop, and downstream `ColumnReferenceNode`s
 * resolve to the correct slot.
 *
 * **Why this is `sideEffectMode: 'safe'`.** The rewrite drops only a derived,
 * read-only `{true,false}` boolean column; both join sides are preserved
 * verbatim, so no write can be skipped or reordered. (Contrast join-elimination,
 * which is `'aware'` because it drops a whole side.)
 *
 * **Write-half safety is by construction.** An existence column writable through
 * a view is always SELECTed by that view's Project — every UPDATE/INSERT-through
 * -view routing path flows through a Project whose projection list names the
 * flag, so `collectAttrIds` marks it demanded and the rule retains it. The
 * unused case arises only when the flag is never selected (a pure read-side dead
 * column). No statement-level context is needed; the demand gate is the complete
 * and correct mechanism.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { collectAttrIds, walkChain, rebuildChain, rebuildProject } from './rule-join-elimination.js';

const log = createLogger('optimizer:rule:join-existence-pruning');

export function ruleJoinExistencePruning(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	const demanded = new Set<number>();
	for (const proj of node.projections) {
		collectAttrIds(proj.node, demanded);
	}

	const walk = walkChain(node.source, demanded);
	if (!walk) return null;

	const { join, chain } = walk;
	if (!join.hasExistenceColumns) return null;

	const existence = join.existence!;
	const kept = existence.filter(spec => demanded.has(spec.attrId));
	if (kept.length === existence.length) return null; // every flag is demanded — nothing to prune

	log('Pruning %d unused existence flag(s) from %s join (%d kept)',
		existence.length - kept.length, join.joinType, kept.length);

	const newJoin: RelationalPlanNode = new JoinNode(
		join.scope,
		join.left,
		join.right,
		join.joinType,
		join.condition,
		join.usingColumns,
		kept.length > 0 ? kept : undefined,
	);

	const newSource = rebuildChain(chain, newJoin);
	return rebuildProject(node, newSource);
}
