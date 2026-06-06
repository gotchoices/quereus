import type { AliasNode } from '../../planner/nodes/alias-node.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Instruction } from '../types.js';

/**
 * Emitter for AliasNode - optimized away at runtime.
 *
 * AliasNode is a planning-time construct that updates relationName on attributes
 * to support qualified SELECT * (e.g., SELECT E.*). At runtime, column access
 * is done via attribute IDs which are preserved through the alias, so we can
 * simply emit the underlying source directly.
 */
export function emitAlias(plan: AliasNode, ctx: EmissionContext): Instruction {
	// AliasNode is purely a planning-time construct - at runtime, just emit the source
	// The attribute IDs are the same, and relationName is not used at runtime
	return emitPlanNode(plan.source, ctx);
}

