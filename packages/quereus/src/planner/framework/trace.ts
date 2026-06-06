/**
 * Trace framework for Titan optimizer rule execution
 * Provides debugging hooks and performance monitoring
 */

import { createLogger } from '../../common/logger.js';
import type { PlanNode } from '../nodes/plan-node.js';
import type { RuleHandle } from './registry.js';
import { isLoggingEnabled } from '../../common/logger.js';
import { isFeatureEnabled } from '../../util/environment.js';

const log = createLogger('optimizer:framework:trace');

/**
 * Trace hooks for optimizer rule execution
 */
export interface TraceHook {
	/** Called when a rule starts execution */
	onRuleStart?(handle: RuleHandle, node: PlanNode): void;

	/** Called when a rule completes execution */
	onRuleEnd?(handle: RuleHandle, before: PlanNode, after: PlanNode | null): void;

	/** Called when optimizer starts processing a node */
	onNodeStart?(node: PlanNode): void;

	/** Called when optimizer finishes processing a node */
	onNodeEnd?(before: PlanNode, after: PlanNode): void;

	/** Called when optimization phase starts */
	onPhaseStart?(phase: string): void;

	/** Called when optimization phase ends */
	onPhaseEnd?(phase: string): void;
}

/**
 * Default trace hook that logs to debug channels
 */
export class DebugTraceHook implements TraceHook {
	private readonly ruleLog = createLogger('optimizer:trace:rules');
	private readonly nodeLog = createLogger('optimizer:trace:nodes');
	private readonly phaseLog = createLogger('optimizer:trace:phases');

	onRuleStart(handle: RuleHandle, node: PlanNode): void {
		this.ruleLog('→ %s starting on %s#%s', handle.id, node.nodeType, node.id);
	}

	onRuleEnd(handle: RuleHandle, before: PlanNode, after: PlanNode | null): void {
		if (after && after !== before) {
			this.ruleLog('✓ %s transformed %s#%s → %s#%s',
				handle.id, before.nodeType, before.id, after.nodeType, after.id);
		} else {
			this.ruleLog('– %s not applicable to %s#%s', handle.id, before.nodeType, before.id);
		}
	}

	onNodeStart(node: PlanNode): void {
		this.nodeLog('Processing node %s#%s', node.nodeType, node.id);
	}

	onNodeEnd(before: PlanNode, after: PlanNode): void {
		if (before !== after) {
			this.nodeLog('Node %s#%s → %s#%s',
				before.nodeType, before.id, after.nodeType, after.id);
		}
	}

	onPhaseStart(phase: string): void {
		this.phaseLog('Starting phase: %s', phase);
	}

	onPhaseEnd(phase: string): void {
		this.phaseLog('Completed phase: %s', phase);
	}
}

/**
 * Performance monitoring trace hook
 */
export class PerformanceTraceHook implements TraceHook {
	private readonly perfLog = createLogger('optimizer:trace:performance');
	private ruleStartTimes = new Map<string, number>();
	private phaseStartTimes = new Map<string, number>();

	onRuleStart(handle: RuleHandle, node: PlanNode): void {
		const key = `${handle.id}:${node.id}`;
		this.ruleStartTimes.set(key, performance.now());
	}

	onRuleEnd(handle: RuleHandle, before: PlanNode, _after: PlanNode | null): void {
		const key = `${handle.id}:${before.id}`;
		const startTime = this.ruleStartTimes.get(key);
		if (startTime !== undefined) {
			const duration = performance.now() - startTime;
			this.perfLog('Rule %s took %.2fms on %s#%s',
				handle.id, duration, before.nodeType, before.id);
			this.ruleStartTimes.delete(key);
		}
	}

	onPhaseStart(phase: string): void {
		this.phaseStartTimes.set(phase, performance.now());
	}

	onPhaseEnd(phase: string): void {
		const startTime = this.phaseStartTimes.get(phase);
		if (startTime !== undefined) {
			const duration = performance.now() - startTime;
			this.perfLog('Phase %s took %.2fms', phase, duration);
			this.phaseStartTimes.delete(phase);
		}
	}
}

/**
 * Composite trace hook that combines multiple hooks
 */
export class CompositeTraceHook implements TraceHook {
	constructor(private readonly hooks: TraceHook[]) {}

	onRuleStart(handle: RuleHandle, node: PlanNode): void {
		for (const hook of this.hooks) {
			hook.onRuleStart?.(handle, node);
		}
	}

	onRuleEnd(handle: RuleHandle, before: PlanNode, after: PlanNode | null): void {
		for (const hook of this.hooks) {
			hook.onRuleEnd?.(handle, before, after);
		}
	}

	onNodeStart(node: PlanNode): void {
		for (const hook of this.hooks) {
			hook.onNodeStart?.(node);
		}
	}

	onNodeEnd(before: PlanNode, after: PlanNode): void {
		for (const hook of this.hooks) {
			hook.onNodeEnd?.(before, after);
		}
	}

	onPhaseStart(phase: string): void {
		for (const hook of this.hooks) {
			hook.onPhaseStart?.(phase);
		}
	}

	onPhaseEnd(phase: string): void {
		for (const hook of this.hooks) {
			hook.onPhaseEnd?.(phase);
		}
	}
}

/**
 * Global trace hook registry
 */
class TraceRegistry {
	private currentHook: TraceHook | undefined;

	setTraceHook(hook: TraceHook | undefined): void {
		this.currentHook = hook;
		if (hook) {
			log('Trace hook activated');
		} else {
			log('Trace hook deactivated');
		}
	}

	getCurrentHook(): TraceHook | undefined {
		return this.currentHook;
	}

	/**
	 * Set up default tracing based on environment variables
	 */
	setupDefaultTracing(): void {
		const hooks: TraceHook[] = [];

		// Enable debug tracing if debug logging is enabled
		if (isLoggingEnabled('optimizer')) {
			hooks.push(new DebugTraceHook());
		}

		// Enable performance tracing if requested
		if (isFeatureEnabled('QUEREUS_OPTIMIZER_PERF')) {
			hooks.push(new PerformanceTraceHook());
		}

		if (hooks.length > 0) {
			this.setTraceHook(new CompositeTraceHook(hooks));
		}
	}
}

/**
 * Global trace registry instance
 */
const globalTraceRegistry = new TraceRegistry();

/**
 * Set the global trace hook
 */
export function setTraceHook(hook: TraceHook | undefined): void {
	globalTraceRegistry.setTraceHook(hook);
}

/**
 * Get the current trace hook
 */
export function getCurrentTraceHook(): TraceHook | undefined {
	return globalTraceRegistry.getCurrentHook();
}

/**
 * Set up default tracing based on environment
 */
export function setupDefaultTracing(): void {
	globalTraceRegistry.setupDefaultTracing();
}

/**
 * Helper functions for calling trace hooks
 */
export function traceRuleStart(handle: RuleHandle, node: PlanNode): void {
	const hook = getCurrentTraceHook();
	hook?.onRuleStart?.(handle, node);
}

export function traceRuleEnd(handle: RuleHandle, before: PlanNode, after: PlanNode | null): void {
	const hook = getCurrentTraceHook();
	hook?.onRuleEnd?.(handle, before, after);
}

export function traceNodeStart(node: PlanNode): void {
	const hook = getCurrentTraceHook();
	hook?.onNodeStart?.(node);
}

export function traceNodeEnd(before: PlanNode, after: PlanNode): void {
	const hook = getCurrentTraceHook();
	hook?.onNodeEnd?.(before, after);
}

export function tracePhaseStart(phase: string): void {
	const hook = getCurrentTraceHook();
	hook?.onPhaseStart?.(phase);
}

export function tracePhaseEnd(phase: string): void {
	const hook = getCurrentTraceHook();
	hook?.onPhaseEnd?.(phase);
}

// Initialize default tracing on module load
setupDefaultTracing();
