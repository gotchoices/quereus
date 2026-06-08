/**
 * Optimizer context that wraps Optimizer with StatsProvider and other utilities
 * Provides unified interface for optimization rules
 */

import type { Optimizer } from '../optimizer.js';
import type { StatsProvider } from '../stats/index.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';
import { createLogger } from '../../common/logger.js';
import { Database } from '../../core/database.js';
import type { PlanNode } from '../nodes/plan-node.js';

const log = createLogger('optimizer:framework:context');

/**
 * Context object passed to optimization rules
 * Contains all the utilities and data sources rules need
 */
export interface OptContext {
	/** The optimizer instance */
	readonly optimizer: Optimizer;

	/** Statistics provider for cardinality and selectivity estimates */
	readonly stats: StatsProvider;

	/** Optimizer tuning parameters */
	readonly tuning: OptimizerTuning;

	/** Current optimization phase */
	readonly phase: 'rewrite' | 'impl';

	/** Additional context data that rules can use */
	readonly context: Map<string, unknown>;

	/** Diagnostics bag that rules can populate (emitted after optimization) */
	readonly diagnostics: OptimizerDiagnostics;

	/** Database instance */
	readonly db: Database;

	/** Context-scoped visited rules tracking (nodeId → ruleIds) */
	readonly visitedRules: Map<string, Set<string>>;

	/** Cache of already-optimized nodes within this context (nodeId → optimized result) */
	readonly optimizedNodes: Map<string, PlanNode>;
}

/** Optimizer diagnostics structure */
export interface OptimizerDiagnostics {
	// QuickPick join enumeration
	quickpick?: {
		tours?: number;
		bestCost?: number;
	};
	// Extensible for future diagnostics
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
}

/**
 * Implementation of optimization context
 */
export class OptimizationContext implements OptContext {
	readonly context = new Map<string, unknown>();
	readonly visitedRules = new Map<string, Set<string>>();
	readonly optimizedNodes = new Map<string, PlanNode>();
	readonly diagnostics = {} as OptimizerDiagnostics;

	constructor(
		public readonly optimizer: Optimizer,
		public readonly stats: StatsProvider,
		public readonly tuning: OptimizerTuning,
		public readonly phase: 'rewrite' | 'impl' = 'rewrite',
		public readonly db: Database,
	) {
		log('Created optimization context (phase: %s)', phase);
	}

	/**
	 * Create a new context for a different phase
	 */
	withPhase(phase: 'rewrite' | 'impl'): OptimizationContext {
		const newContext = new OptimizationContext(
			this.optimizer,
			this.stats,
			this.tuning,
			phase,
			this.db,
		);

		// Copy visited tracking state
		this.copyTrackingState(newContext);
		return newContext;
	}

	/**
	 * Create a new context with additional context data
	 */
	withContext(key: string, value: unknown): OptimizationContext {
		const newContext = new OptimizationContext(
			this.optimizer,
			this.stats,
			this.tuning,
			this.phase,
			this.db,
		);

		// Copy existing context
		for (const [k, v] of this.context) {
			newContext.context.set(k, v);
		}

		// Add new context
		newContext.context.set(key, value);

		// Copy visited tracking state
		this.copyTrackingState(newContext);
		return newContext;
	}

	/**
	 * Copy visited tracking state to another context
	 */
	private copyTrackingState(target: OptimizationContext): void {
		// Copy visitedRules
		for (const [nodeId, ruleIds] of this.visitedRules) {
			target.visitedRules.set(nodeId, new Set(ruleIds));
		}

		// Copy optimizedNodes
		for (const [nodeId, node] of this.optimizedNodes) {
			target.optimizedNodes.set(nodeId, node);
		}
	}

	/**
	 * Get context value
	 */
	getContext<T>(key: string): T | undefined {
		return this.context.get(key) as T | undefined;
	}

	/**
	 * Check if context has a key
	 */
	hasContext(key: string): boolean {
		return this.context.has(key);
	}

	/**
	 * Set context value (mutates current context)
	 */
	setContext(key: string, value: unknown): void {
		this.context.set(key, value);
	}

	/**
	 * Remove context value (mutates current context)
	 */
	deleteContext(key: string): boolean {
		return this.context.delete(key);
	}

	/**
	 * Clear all context data (mutates current context)
	 */
	clearContext(): void {
		this.context.clear();
	}

	/**
	 * Get a snapshot of all context data
	 */
	getContextSnapshot(): Record<string, unknown> {
		const snapshot: Record<string, unknown> = {};
		for (const [key, value] of this.context) {
			snapshot[key] = value;
		}
		return snapshot;
	}
}

/**
 * Factory function to create optimization context
 */
export function createOptContext(
	optimizer: Optimizer,
	stats: StatsProvider,
	tuning: OptimizerTuning,
	db: Database,
	phase: 'rewrite' | 'impl' = 'rewrite',
): OptContext {
	return new OptimizationContext(optimizer, stats, tuning, phase, db);
}

/**
 * Type guard to check if an object is an OptContext
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isOptContext(obj: any): obj is OptContext {
	return obj &&
		typeof obj === 'object' &&
		'optimizer' in obj &&
		'stats' in obj &&
		'tuning' in obj &&
		'phase' in obj &&
		'context' in obj;
}
