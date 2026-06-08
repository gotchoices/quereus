import type { EmptyRelationNode } from '../../planner/nodes/empty-relation-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitEmptyRelation(_plan: EmptyRelationNode, _ctx: EmissionContext): Instruction {
	async function* run(_rctx: RuntimeContext): AsyncIterable<Row> {
		// Schema-polymorphic empty source — yields no rows.
	}

	return {
		params: [],
		run,
		note: 'empty_relation',
	};
}
