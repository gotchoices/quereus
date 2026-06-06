import type { EmptyResultNode } from '../../planner/nodes/table-access-nodes.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitEmptyResult(_plan: EmptyResultNode, _ctx: EmissionContext): Instruction {
	async function* run(_rctx: RuntimeContext): AsyncIterable<Row> {
		// Yield nothing — impossible predicate produces zero rows
	}

	return {
		params: [],
		run,
		note: 'empty_result'
	};
}
