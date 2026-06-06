/**
 * Rule: Eager Prefetch Probe
 *
 * Wraps the probe (`left`) input of a physical hash join in an
 * `EagerPrefetchNode` when the build (`right`) side advertises high first-row
 * latency, so the buffered pump can pipeline its probe-side reads with the
 * parent emit's per-row work.
 *
 * Target shape: `BloomJoinNode` (physical, `PlanNodeType.HashJoin`). Per the
 * node contract, **`left` is the probe (streamed) side** and `right` is the
 * build (materialized) side — opposite of the textbook convention. The wrap
 * target is therefore `left`.
 *
 * Cost gate: anchored on `node.right.physical.expectedLatencyMs`, the same
 * field consumed by `rule-fanout-lookup-join` and `rule-async-gather-union-all`.
 * That field is 0 on every in-process / memory-vtab leaf and non-zero only
 * when a remote vtab plugin declares `expectedLatencyMs` at a leaf. As a
 * consequence the rule is **inert by design on memory-vtab plans**, preserving
 * the local-only golden-plan invariant the parallel rules already lock. We gate
 * on the build side specifically: if `left` were the slow one the consumer
 * above the join takes the latency hit regardless, so prefetching it doesn't
 * change first-row time meaningfully.
 *
 * Skip predicates (the probe is already pump-driven or pre-materialized):
 *   - `left` is an `EagerPrefetchNode` — already wrapped (idempotence).
 *   - `left` is a `Cache` — pre-materialized; a prefetch over a cache buys
 *     nothing and confuses plan output.
 *   - `left` is an `AsyncGather` — already drives its branches concurrently;
 *     inserting a prefetch buffer just adds latency-of-first-row.
 *
 * Concurrency gate: as of the eager-start change, the prefetch pump begins on
 * `run()` (scheduler arg-assembly), so the probe (`left`) subtree iterates
 * **concurrently** with the build's for-await over `right`. If either side sits
 * over a non-reentrant (`'serial'`) cursor, concurrent iteration corrupts state.
 * We therefore only wrap when **both** `node.left` and `node.right` advertise
 * `physical.concurrencySafe === true` (mirroring `rule-async-gather-union-all`'s
 * strict `=== true` check — wrap only when *proven* safe; `undefined` blocks).
 *
 * Idempotence: after the rewrite `left` is an `EagerPrefetchNode`, so a second
 * firing hits the first skip predicate and no-ops.
 */

import { createLogger } from '../../../common/logger.js';
import type { OptContext } from '../../framework/context.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { BloomJoinNode } from '../../nodes/bloom-join-node.js';
import { EagerPrefetchNode } from '../../nodes/eager-prefetch-node.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:eager-prefetch-probe');

export function ruleEagerPrefetchProbe(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof BloomJoinNode)) return null;

	const probe = node.left;

	// Skip predicates: probe is already pump-driven or pre-materialized.
	if (probe.nodeType === PlanNodeType.EagerPrefetch) return null;
	if (probe.nodeType === PlanNodeType.Cache) return null;
	if (probe.nodeType === PlanNodeType.AsyncGather) return null;

	// Concurrency gate: the eager pump iterates the probe concurrently with the
	// build's for-await, so both sides must be proven concurrency-safe. The
	// `physical.concurrencySafe` flag is the module-level (lock-contract) gate;
	// `PlanNodeCharacteristics.isConcurrencySafe` is the side-effect gate the
	// connection lock additionally requires (an impure subtree on a
	// `'serial'` / `'reentrant-reads'` module would violate the lock).
	if (probe.physical.concurrencySafe !== true) return null;
	if (node.right.physical.concurrencySafe !== true) return null;
	if (!PlanNodeCharacteristics.isConcurrencySafe(probe)
		|| !PlanNodeCharacteristics.isConcurrencySafe(node.right)) {
		return null;
	}

	// Cost gate: only fire when the build (right) side is high-latency. Inert
	// on memory-vtab plans where expectedLatencyMs is 0 throughout.
	const buildLatency = node.right.physical.expectedLatencyMs ?? 0;
	if (buildLatency < context.tuning.parallel.prefetchProbeThresholdMs) return null;

	const bufferSize = context.tuning.parallel.prefetchBufferSize;

	log(
		'Wrapping probe side of hash join %s in EagerPrefetch (buildLatency=%d ms, threshold=%d ms, buffer=%d)',
		node.id, buildLatency, context.tuning.parallel.prefetchProbeThresholdMs, bufferSize,
	);

	const wrappedProbe = new EagerPrefetchNode(node.scope, probe, bufferSize);

	// withChildren expects [left, right, residual?]; preserve the residual.
	const newChildren: PlanNode[] = [wrappedProbe, node.right];
	if (node.residualCondition) newChildren.push(node.residualCondition);

	return node.withChildren(newChildren);
}
