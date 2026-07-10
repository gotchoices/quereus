import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type ZeroAryScalarNode } from './plan-node.js';
import type { ScalarType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type { WindowFunctionExpr } from '../../parser/ast.js';
import { Cached } from '../../util/cached.js';
import { formatScalarType } from '../../util/plan-formatter.js';
import { resolveWindowFunction } from '../../schema/window-function.js';
import { REAL_TYPE } from '../../types/builtin-types.js';
import type { LogicalType } from '../../types/logical-type.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode, type DeepReadonly } from '../../common/types.js';
import type { WindowFunctionCapable } from '../framework/characteristics.js';

/**
 * Represents a window function call in the query plan.
 * Window functions are computed during window operation execution.
 */
export class WindowFunctionCallNode extends PlanNode implements ZeroAryScalarNode, WindowFunctionCapable {
	override readonly nodeType = PlanNodeType.WindowFunctionCall;
	readonly isWindowFunctionCapable = true as const;

	private outputTypeCache: Cached<ScalarType>;

	constructor(
		scope: Scope,
		public readonly expression: WindowFunctionExpr,
		public readonly functionName: string,
		public readonly isDistinct: boolean = false,
		public readonly alias?: string,
		/**
		 * Logical types of the built argument expressions, supplied by the
		 * builders so `getType()` can consult `schema.inferReturnType` (e.g.
		 * window MIN/MAX deriving their argument's type). Zero-ary node carries
		 * no argument children, so the types must be threaded in explicitly.
		 */
		public readonly argTypes?: ReadonlyArray<DeepReadonly<LogicalType>>,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride);

		this.outputTypeCache = new Cached(() => {
			const schema = resolveWindowFunction(this.functionName);
			if (schema) {
				// Polymorphic windows (MIN/MAX) derive their type from the argument
				// type when one is available; otherwise fall back to the fixed type.
				if (schema.inferReturnType && this.argTypes && this.argTypes.length > 0) {
					return schema.inferReturnType(this.argTypes);
				}
				return schema.returnType;
			}

			// Fallback: unknown window functions behave like numeric windows for now.
			return { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false, isReadOnly: true } satisfies ScalarType;
		});
	}

	getType(): ScalarType {
		return this.outputTypeCache.value;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			quereusError(`WindowFunctionCallNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		return this; // No children, so no change
	}

	override toString(): string {
		const distinctStr = this.isDistinct ? 'DISTINCT ' : '';
		const aliasStr = this.alias ? ` AS ${this.alias}` : '';
		return `${this.functionName}(${distinctStr})${aliasStr}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			function: this.functionName,
			isDistinct: this.isDistinct,
			alias: this.alias,
			resultType: formatScalarType(this.getType())
		};
	}
}
