/**
 * Rule registration and management framework for the Titan optimizer
 * Provides centralized rule registry with tracing and loop detection
 */

import { createLogger } from '../../common/logger.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { OptContext } from './context.js';
import { traceRuleStart, traceRuleEnd } from './trace.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';

const log = createLogger('optimizer:framework:registry');

/**
 * Rule function signature for optimization transformations
 */
export type RuleFn = (node: PlanNode, context: OptContext) => PlanNode | null;

/**
 * Rule phases for categorizing optimization rules
 */
export type RulePhase = 'rewrite' | 'impl';

/**
 * Required side-effect awareness declaration for every registered rule.
 *
 * - `'safe'` — the rule never moves, duplicates, drops, or merges any
 *   subtree it does not separately verify pure. Reordering scalar properties
 *   on an existing node, replacing a logical node with a physical one whose
 *   children survive in the same positions, and annotation-only transforms
 *   all qualify. The rule does not need to consult
 *   `PlanNodeCharacteristics.hasSideEffects` because its own structural shape
 *   guarantees side-effect preservation.
 *
 * - `'aware'` — the rule DOES move, duplicate, drop, or merge subtrees, and
 *   explicitly consults `PlanNodeCharacteristics.hasSideEffects` (or
 *   `subtreeHasSideEffects`) to refuse / weaken when any participating
 *   subtree carries a write. Includes rules that *intentionally* preserve
 *   side effects through run-once memoization (e.g. mutating-subquery-cache).
 *
 * This field is intentionally not optional: every future rule author has to
 * actively pick one. The registry validates the choice at registration time
 * and rejects rules that fail to declare. See `docs/optimizer.md` § Audit
 * discipline.
 */
export type SideEffectMode = 'safe' | 'aware';

/**
 * Handle for registered optimization rules
 */
export interface RuleHandle {
	/** Unique identifier for this rule */
	id: string;
	/** Node type this rule applies to */
	nodeType: PlanNodeType;
	/** Phase classification */
	phase: RulePhase;
	/** Rule implementation function */
	fn: RuleFn;
	/** Optional priority (lower numbers run first) */
	priority?: number;
	/**
	 * Side-effect awareness declaration — see {@link SideEffectMode}. Required:
	 * registration fails when omitted, so every rule author has to make an
	 * active choice rather than silently dropping a write.
	 */
	sideEffectMode: SideEffectMode;
}

/**
 * Global rule registry
 */
class RuleRegistry {
	private rules = new Map<PlanNodeType, RuleHandle[]>();

	/**
	 * Register a new optimization rule
	 */
	registerRule(handle: RuleHandle): void {
		validateSideEffectMode(handle);

		if (!this.rules.has(handle.nodeType)) {
			this.rules.set(handle.nodeType, []);
		}

		const nodeRules = this.rules.get(handle.nodeType)!;

		// Check for duplicate rule IDs
		if (nodeRules.some(r => r.id === handle.id)) {
			quereusError(`Optimization rule '${handle.id}' already registered for node type ${handle.nodeType}`, StatusCode.INTERNAL);
		}

		// Insert rule maintaining priority order (lower priority first)
		const priority = handle.priority ?? 100;
		const insertIndex = nodeRules.findIndex(r => (r.priority ?? 100) > priority);
		if (insertIndex === -1) {
			nodeRules.push(handle);
		} else {
			nodeRules.splice(insertIndex, 0, handle);
		}

		log('Registered rule %s for %s (phase: %s, priority: %d)',
			handle.id, handle.nodeType, handle.phase, priority);
	}

	/**
	 * Get all rules for a specific node type
	 */
	rulesFor(nodeType: PlanNodeType): readonly RuleHandle[] {
		return this.rules.get(nodeType) ?? [];
	}

	/**
	 * Check if a rule has already been applied to a node
	 */
	hasRuleBeenApplied(nodeId: string, ruleId: string, context: OptContext): boolean {
		const nodeVisited = context.visitedRules.get(nodeId);
		return nodeVisited?.has(ruleId) ?? false;
	}

	/**
	 * Mark a rule as applied to a node
	 */
	markRuleApplied(nodeId: string, ruleId: string, context: OptContext): void {
		if (!context.visitedRules.has(nodeId)) {
			context.visitedRules.set(nodeId, new Set());
		}
		context.visitedRules.get(nodeId)!.add(ruleId);
	}

	/**
	 * Get all registered rules (for debugging)
	 */
	getAllRules(): Map<PlanNodeType, readonly RuleHandle[]> {
		const result = new Map<PlanNodeType, readonly RuleHandle[]>();
		for (const [nodeType, rules] of this.rules) {
			result.set(nodeType, [...rules]);
		}
		return result;
	}

	/**
	 * Get statistics about rule application
	 */
	getStats(context?: OptContext): { totalRules: number; nodesWithRules: number; appliedRules: number } {
		let totalRules = 0;
		for (const rules of this.rules.values()) {
			totalRules += rules.length;
		}

		let appliedRules = 0;
		if (context) {
			for (const ruleSet of context.visitedRules.values()) {
				appliedRules += ruleSet.size;
			}
		}

		return {
			totalRules,
			nodesWithRules: context?.visitedRules.size ?? 0,
			appliedRules
		};
	}
}

/**
 * Global registry instance
 */
const globalRegistry = new RuleRegistry();

/**
 * Register an optimization rule
 */
export function registerRule(handle: RuleHandle): void {
	globalRegistry.registerRule(handle);
}

/**
 * Get rules for a specific node type
 */
export function rulesFor(nodeType: PlanNodeType): readonly RuleHandle[] {
	return globalRegistry.rulesFor(nodeType);
}

/**
 * Check if a rule has been applied to a node
 */
export function hasRuleBeenApplied(nodeId: string, ruleId: string, context: OptContext): boolean {
	return globalRegistry.hasRuleBeenApplied(nodeId, ruleId, context);
}

/**
 * Mark a rule as applied to a node
 */
export function markRuleApplied(nodeId: string, ruleId: string, context: OptContext): void {
	globalRegistry.markRuleApplied(nodeId, ruleId, context);
}

/**
 * Get registry statistics
 */
export function getRegistryStats(context?: OptContext): { totalRules: number; nodesWithRules: number; appliedRules: number } {
	return globalRegistry.getStats(context);
}

/**
 * Get all registered rules (for debugging/tooling)
 */
export function getAllRules(): Map<PlanNodeType, readonly RuleHandle[]> {
	return globalRegistry.getAllRules();
}

/**
 * Apply rules to a node with tracing and loop detection
 */
export function applyRules(node: PlanNode, context: OptContext): PlanNode {
	const applicableRules = rulesFor(node.nodeType);

	if (applicableRules.length === 0) {
		return node;
	}

	let currentNode = node;
	let appliedAnyRule = false;

	for (const rule of applicableRules) {
		// Skip if rule is disabled
		if (context.tuning.disabledRules?.has(rule.id)) continue;
		// Skip if rule already applied to this node
		if (hasRuleBeenApplied(currentNode.id, rule.id, context)) {
			log('Skipping rule %s for node %s (already applied)', rule.id, currentNode.id);
			continue;
		}

		try {
			const ruleLog = createLogger(`optimizer:rule:${rule.id}`);

			// Trace rule start
			traceRuleStart(rule, currentNode);
			ruleLog('Applying rule to node %s', currentNode.id);

			const result = rule.fn(currentNode, context);

			if (result && result !== currentNode) {
				ruleLog('Rule transformed %s to %s', currentNode.nodeType, result.nodeType);
				markRuleApplied(currentNode.id, rule.id, context);

				// Trace successful transformation
				traceRuleEnd(rule, currentNode, result);

				currentNode = result;
				appliedAnyRule = true;
			} else {
				ruleLog('Rule not applicable to node %s', currentNode.id);

				// Trace rule not applicable
				traceRuleEnd(rule, currentNode, null);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			log('Rule %s failed on node %s: %s', rule.id, currentNode.id, errorMsg);
			// Continue with other rules rather than failing entire optimization
		}
	}

	if (appliedAnyRule) {
		log('Applied rules to node %s, result: %s', node.id, currentNode.nodeType);
	}

	return currentNode;
}

/**
 * Convenience function to register multiple rules at once
 */
export function registerRules(rules: RuleHandle[]): void {
	for (const rule of rules) {
		registerRule(rule);
	}
}

/**
 * Helper to create rule handles with common patterns
 */
export function createRule(
	id: string,
	nodeType: PlanNodeType,
	phase: RulePhase,
	fn: RuleFn,
	sideEffectMode: SideEffectMode,
	priority?: number
): RuleHandle {
	return { id, nodeType, phase, fn, sideEffectMode, priority };
}

/**
 * Reject any rule registration that fails to declare `sideEffectMode`. The
 * field is typed as required, but plenty of call sites build rule handles
 * dynamically (object spreads, generated registries) where TypeScript can't
 * see through — this runtime check is the load-bearing audit gate. Exported
 * so the PassManager can apply the same validation when rules are pushed
 * directly into a pass's `rules` array (bypassing the global registry).
 */
export function validateSideEffectMode(handle: RuleHandle): void {
	const mode = (handle as { sideEffectMode?: unknown }).sideEffectMode;
	if (mode !== 'safe' && mode !== 'aware') {
		quereusError(
			`Optimization rule '${handle.id}' is missing or has invalid sideEffectMode (got ${JSON.stringify(mode)}); ` +
			`every rule must declare 'safe' or 'aware'. See docs/optimizer.md § Audit discipline.`,
			StatusCode.INTERNAL,
		);
	}
}
