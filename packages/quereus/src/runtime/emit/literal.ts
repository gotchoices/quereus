import type { MaybePromise, SqlValue } from "../../common/types.js";
import type { Instruction, RuntimeContext } from "../types.js";
import { asRun } from "../types.js";
import type { LiteralNode } from "../../planner/nodes/scalar.js";
import { safeJsonStringify } from "../../util/serialization.js";
import type { EmissionContext } from "../emission-context.js";

export function emitLiteral(plan: LiteralNode, _ctx: EmissionContext): Instruction {
	function run(_rctx: RuntimeContext): MaybePromise<SqlValue> {
		return plan.expression.value;
	}

	return {
		params: [],
		run: asRun(run),
		note: `literal(${safeJsonStringify(plan.expression.value)})`
	};
}
