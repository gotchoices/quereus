import type { RetrieveNode } from '../../planner/nodes/retrieve-node.js';
import type { Instruction } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export function emitRetrieve(plan: RetrieveNode, _ctx: EmissionContext): Instruction {
	// RetrieveNode should always be rewritten by the optimizer's access path selection rule
	// If we reach this point, it means the optimizer failed to convert it to a physical node
	throw new QuereusError(
		`RetrieveNode for table '${plan.tableRef.tableSchema.name}' was not rewritten to a physical access node. ` +
		`This indicates the virtual table module has no supported access method (neither supports() nor getBestAccessPlan()).`,
		StatusCode.INTERNAL
	);
}
